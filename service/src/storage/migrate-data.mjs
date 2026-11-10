import fs from "node:fs";
import { openSqliteStorage } from "./sqlite.mjs";
import { openPostgresStorage } from "./postgres.mjs";

// Durable tables copied from the single-user SQLite database into a migrated PostgreSQL database.
// Sessions, access/refresh tokens and other short-lived rows are intentionally skipped so the cutover
// forces a fresh sign-in. Object files stay in the object store directory and are copied separately.
const COPY_TABLES = [
  "accounts",
  "api_tokens",
  "projects",
  "project_members",
  "project_snapshots",
  "project_versions",
  "objects",
  "project_assets",
  "audit_log",
  "service_meta",
  "project_invitations",
  "share_links",
  "abuse_reports",
  "notifications",
  "email_preferences",
  "passkey_credentials",
  "email_jobs",
];

const SKIPPED_TABLES = [
  "sessions",
  "refresh_tokens",
  "access_tokens",
  "email_tokens",
  "login_attempts",
  "email_otps",
  "share_attempts",
  "passkey_challenges",
];

const CHUNK_SIZE = 500;

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function sourceColumns(source, table) {
  const rows = await source.all(`PRAGMA table_info(${quoteIdent(table)})`);
  return rows.map((row) => row.name);
}

async function targetColumns(target, table) {
  const rows = await target.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
    [table]
  );
  return rows.map((row) => row.column_name);
}

async function count(storage, table) {
  const row = await storage.get(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`);
  return Number(row?.count || 0);
}

export async function copySqliteToPostgres({
  sqlitePath,
  databaseUrl,
  databaseSsl = false,
  databasePoolMax = 10,
  dryRun = false,
  onProgress = () => {},
} = {}) {
  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found: ${sqlitePath}`);
  }
  const source = await openSqliteStorage(sqlitePath, { readOnly: true });
  const target = await openPostgresStorage({
    databaseUrl,
    databaseSsl,
    databasePoolMax,
  });
  const report = { source: sqlitePath, dryRun, tables: {}, skipped: SKIPPED_TABLES };
  try {
    const baseline = await target.get(
      "SELECT version FROM schema_migrations WHERE version = 1"
    );
    if (!baseline) {
      throw new Error("target database has no PostgreSQL baseline; run migrate-postgres first");
    }

    const plan = [];
    for (const table of COPY_TABLES) {
      const columns = await sourceColumns(source, table);
      const targetNames = await targetColumns(target, table);
      const missing = columns.filter((column) => !targetNames.includes(column));
      if (missing.length) {
        throw new Error(
          `target table ${table} is missing columns: ${missing.join(", ")}`
        );
      }
      plan.push({ table, columns, rows: await count(source, table) });
    }
    report.plan = plan;

    if (!dryRun) {
      for (const table of COPY_TABLES) {
        const targetCount = await count(target, table);
        if (targetCount > 0) {
          throw new Error(
            `target table ${table} is not empty (${targetCount} rows); migrate into a fresh database`
          );
        }
      }
    }

    for (const entry of plan) {
      if (dryRun) {
        report.tables[entry.table] = { rows: entry.rows, copied: 0 };
        onProgress({ table: entry.table, rows: entry.rows, copied: 0, dryRun: true });
        continue;
      }
      const rows = await source.all(`SELECT * FROM ${quoteIdent(entry.table)}`);
      const columns = entry.columns;
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO ${quoteIdent(entry.table)} (${columns
        .map(quoteIdent)
        .join(", ")}) VALUES (${placeholders})`;
      let copied = 0;
      for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + CHUNK_SIZE);
        await target.transaction(async (tx) => {
          for (const row of chunk) {
            await tx.run(
              insertSql,
              columns.map((column) => {
                if (entry.table === "projects" && column === "parent_project_id") return null;
                const value = row[column] ?? null;
                if (
                  value !== null &&
                  ((entry.table === "accounts" && column === "email") ||
                    (entry.table === "project_invitations" && column === "email"))
                ) {
                  return String(value).toLowerCase();
                }
                return value;
              })
            );
          }
        });
        copied += chunk.length;
        onProgress({ table: entry.table, rows: rows.length, copied });
      }
      if (entry.table === "projects") {
        const parents = rows.filter((row) => row.parent_project_id !== null && row.parent_project_id !== undefined);
        if (parents.length) {
          await target.transaction(async (tx) => {
            for (const row of parents) {
              await tx.run("UPDATE projects SET parent_project_id = ? WHERE id = ?", [
                row.parent_project_id,
                row.id,
              ]);
            }
          });
        }
      }
      const targetCount = await count(target, entry.table);
      if (targetCount !== rows.length) {
        throw new Error(
          `row count mismatch for ${entry.table}: source ${rows.length}, target ${targetCount}`
        );
      }
      report.tables[entry.table] = { rows: rows.length, copied: targetCount };
    }
    return report;
  } finally {
    await target.close().catch(() => {});
    await source.close().catch(() => {});
  }
}

export const dataMigrationTables = { copy: COPY_TABLES, skipped: SKIPPED_TABLES };
