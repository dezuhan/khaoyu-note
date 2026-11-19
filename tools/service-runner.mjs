// Starts the self-hosted service for integration tests. SERVICE_CMD lets CI or a developer point the
// tests at a packaged server binary or a different entry point without changing the suites.
import { spawn } from "node:child_process";

export function serviceCommand() {
  return process.env.SERVICE_CMD || "";
}

export function startService({ cwd, env, stdio = "ignore" } = {}) {
  const override = serviceCommand();
  if (!override) {
    return spawn(process.execPath, ["service/src/server.mjs"], { cwd, env, stdio });
  }
  // A shell command needs its own process group so kill() reaches the server, not only the shell.
  const child = spawn(override, {
    cwd,
    env,
    stdio,
    shell: true,
    detached: true,
  });
  const fallbackKill = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return fallbackKill(signal);
    }
  };
  return child;
}
