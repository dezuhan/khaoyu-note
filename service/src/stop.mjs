import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.env.KHAOYU_SERVICE_DATA_DIR || ".khaoyu-service-data");
const runtimePath = path.join(dataDir, "runtime.json");
if (!fs.existsSync(runtimePath)) {
  process.stdout.write("No background service runtime file was found.\n");
  process.exit(0);
}
let runtime;
try {
  runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
} catch {
  process.stderr.write(`Could not read ${runtimePath}.\n`);
  process.exit(1);
}
try {
  process.kill(Number(runtime.pid));
  fs.rmSync(runtimePath, { force: true });
  process.stdout.write(`Stopped Khaoyu Note service (pid ${runtime.pid}).\n`);
} catch (error) {
  process.stderr.write(`Could not stop pid ${runtime.pid}: ${error.message}\n`);
  process.exit(1);
}
