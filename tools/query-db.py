import os
import sqlite3

data_dir = os.environ.get("KHAOYU_NOTE_DB_DIR") or os.path.join(
    os.environ["APPDATA"], "com.dezuhan.khaoyunote"
)
path = os.path.join(data_dir, "khaoyu-note.db")
uri = "file:" + path.replace("\\", "/") + "?mode=ro"
conn = sqlite3.connect(uri, uri=True)
print("page_count", conn.execute("pragma page_count").fetchone()[0])
print("page_size", conn.execute("pragma page_size").fetchone()[0])
print("freelist", conn.execute("pragma freelist_count").fetchone()[0])
tables = [row[0] for row in conn.execute("select name from sqlite_master where type='table' order by name")]
print("tables", tables)
for table in ["boards", "cards", "connections", "assets", "meta"]:
    if table in tables:
        print(table, conn.execute(f"select count(*) from {table}").fetchone()[0])
print("cards by type", conn.execute("select json_extract(data, '$.type'), count(*) from cards group by 1 order by 2 desc").fetchall())
conn.close()
