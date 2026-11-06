import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dataDir =
  process.env.KHAOYU_NOTE_DB_DIR ||
  path.join(process.env.APPDATA, "com.dezuhan.khaoyunote");
const dbPath = process.argv[2] || path.join(dataDir, "khaoyu-note.db");
const setKey = process.argv[3];
const setValue = process.argv[4];

const db = new DatabaseSync(dbPath, { readOnly: !setKey });
if (setKey) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(setKey, setValue);
  console.log(`set ${setKey}=${setValue}`);
} else {
  const rows = db.prepare("SELECT key, value FROM meta ORDER BY key").all();
  console.log(JSON.stringify(rows, null, 1));
  console.log("boards:", db.prepare("SELECT COUNT(*) AS n FROM boards").get().n);
  console.log("cards:", db.prepare("SELECT COUNT(*) AS n FROM cards").get().n);
}
db.close();
