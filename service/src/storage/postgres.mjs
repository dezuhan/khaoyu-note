import pg from "pg";

const { Pool } = pg;

// BIGINT milliseconds and COUNT(*) values fit safely in a JavaScript number for this service.
// Returning numbers keeps the route code identical to the SQLite path.
pg.types.setTypeParser(20, (value) => Number(value));

// The service SQL is written with SQLite-style positional placeholders (?). PostgreSQL uses $1,
// $2, ... so the adapter rewrites them while leaving quoted strings and comments untouched.
export function toPostgresPlaceholders(sql) {
  let output = "";
  let index = 0;
  let state = "normal";
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (state === "normal") {
      if (char === "'") {
        state = "single";
        output += char;
      } else if (char === '"') {
        state = "double";
        output += char;
      } else if (char === "-" && next === "-") {
        state = "line";
        output += char;
      } else if (char === "/" && next === "*") {
        state = "block";
        output += char;
      } else if (char === "?") {
        index += 1;
        output += `$${index}`;
      } else {
        output += char;
      }
      continue;
    }
    if (state === "single") {
      output += char;
      if (char === "'" && next === "'") {
        output += next;
        i += 1;
      } else if (char === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double") {
      output += char;
      if (char === '"' && next === '"') {
        output += next;
        i += 1;
      } else if (char === '"') {
        state = "normal";
      }
      continue;
    }
    if (state === "line") {
      output += char;
      if (char === "\n") state = "normal";
      continue;
    }
    // block comment
    output += char;
    if (char === "*" && next === "/") {
      output += next;
      i += 1;
      state = "normal";
    }
  }
  return output;
}

function makeApi(queryable, { nested = false, pool = null } = {}) {
  let closed = false;
  const api = {
    dialect: "postgres",
    async get(sql, params = []) {
      const result = await queryable.query(toPostgresPlaceholders(sql), params);
      return result.rows[0] ?? undefined;
    },
    async all(sql, params = []) {
      const result = await queryable.query(toPostgresPlaceholders(sql), params);
      return result.rows;
    },
    async run(sql, params = []) {
      const result = await queryable.query(toPostgresPlaceholders(sql), params);
      return { changes: Number(result.rowCount || 0) };
    },
    async exec(sql) {
      await queryable.query(sql);
    },
    async transaction(fn) {
      if (nested) return fn(api);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(makeApi(client, { nested: true }));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the connection is already unusable */
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (closed || !pool) return;
      closed = true;
      await pool.end();
    },
  };
  return api;
}

export async function openPostgresStorage({ databaseUrl, databaseSsl = false, databasePoolMax = 10 } = {}) {
  if (!databaseUrl) throw new Error("KHAOYU_SERVICE_DATABASE_URL is required for PostgreSQL");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(databasePoolMax) || 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    application_name: "khaoyu-note-service",
    ...(databaseSsl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return makeApi(pool, { pool });
}
