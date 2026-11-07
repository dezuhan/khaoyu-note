import net from "node:net";

export const MIN_PORT = 20000;
export const MAX_PORT = 59999;

function normalizeHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function isPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, normalizeHost(host), () => {
      probe.close(() => resolve(true));
    });
  });
}

async function randomFreePort(host, used) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));
    if (used.has(port)) continue;
    if (await isPortFree(port, host)) return port;
  }
  for (let port = MIN_PORT; port <= MAX_PORT; port += 1) {
    if (used.has(port)) continue;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error("no free 5-digit port is available");
}

function explicitPort(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 10000 || port > 65535) {
    throw new Error(`${name} must be a 5-digit port between 10000 and 65535`);
  }
  return port;
}

// Pick one frontend and one backend port. Both are 5 digits and distinct. Explicit environment
// values win, otherwise the first free ports in 20000-59999 are used.
export async function pickServicePorts(host, { frontend, backend } = {}) {
  const used = new Set();
  let frontendPort = explicitPort(frontend ?? process.env.KHAOYU_SERVICE_FRONTEND_PORT, "frontend port");
  let backendPort = explicitPort(backend ?? process.env.KHAOYU_SERVICE_BACKEND_PORT, "backend port");
  if (frontendPort && !(await isPortFree(frontendPort, host))) {
    throw new Error(`frontend port ${frontendPort} is already in use`);
  }
  if (backendPort && !(await isPortFree(backendPort, host))) {
    throw new Error(`backend port ${backendPort} is already in use`);
  }
  if (frontendPort) used.add(frontendPort);
  if (backendPort) used.add(backendPort);
  if (!frontendPort) frontendPort = await randomFreePort(host, used);
  used.add(frontendPort);
  if (!backendPort) backendPort = await randomFreePort(host, used);
  if (frontendPort === backendPort) throw new Error("frontend and backend ports must differ");
  return { frontendPort, backendPort };
}

export function displayHost(host) {
  return normalizeHost(host);
}
