import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.env.KHAOYU_SERVICE_DATA_DIR || ".khaoyu-service-data");
const logDir = path.join(dataDir, "logs");
fs.mkdirSync(logDir, { recursive: true });
const out = fs.openSync(path.join(logDir, "service.log"), "a");
const err = fs.openSync(path.join(logDir, "service-error.log"), "a");

const serverPath = path.join(import.meta.dirname, "server.mjs");
const child = spawn(process.execPath, [serverPath], {
  detached: true,
  stdio: ["ignore", out, err],
  env: process.env,
  cwd: path.dirname(import.meta.dirname),
  windowsHide: true,
});
child.unref();

const runtimePath = path.join(dataDir, "runtime.json");
let runtime = null;
for (let attempt = 0; attempt < 50; attempt += 1) {
  if (fs.existsSync(runtimePath)) {
    try {
      runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
      break;
    } catch {
      /* the server is still writing it */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

process.stdout.write(`Khaoyu Note service started in the background (pid ${child.pid}).\n`);
if (runtime) {
  process.stdout.write(`frontend: ${runtime.frontendUrl}\n`);
  process.stdout.write(`backend:  ${runtime.backendUrl}\n`);
  process.stdout.write(`admin:    ${runtime.frontendUrl}/admin\n`);
} else {
  process.stdout.write(`Ports will appear in ${runtimePath} once the service is ready.\n`);
}
process.stdout.write(`logs:     ${logDir}\n`);
