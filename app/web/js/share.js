// Service-backed sharing for the desktop board UI.

import { loadSyncConfig } from "./sync.js";

function config() {
  const sync = loadSyncConfig();
  if (!sync.url || !sync.token) throw new Error("Connect a server in Sync settings first");
  return { base: sync.url.replace(/\/+$/, ""), token: sync.token };
}

async function api(pathname, { method = "GET", body } = {}) {
  const { base, token } = config();
  const response = await fetch(base + pathname, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = new Error(parsed?.error || `Share request failed (${response.status})`);
    error.code = parsed?.code;
    throw error;
  }
  return parsed;
}

export function shareUrl(token) {
  return `${config().base}/s/${encodeURIComponent(token)}`;
}

export async function readProject(projectId) {
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}`);
}

export async function listShares(projectId) {
  return (await api(`/api/v1/projects/${encodeURIComponent(projectId)}/shares`)).shares;
}

export async function enableSharing(projectId) {
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/public-sharing`, {
    method: "POST",
    body: { enabled: true, acknowledge: true },
  });
}

export async function disableSharing(projectId) {
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/public-sharing`, {
    method: "POST",
    body: { enabled: false },
  });
}

export async function createShare(projectId, options) {
  const body = {
    permission: options.permission || "view",
    scope: options.scope,
    downloadAllowed: Boolean(options.downloadAllowed),
  };
  if (options.scope !== "project") body.targetId = options.targetId;
  if (options.password) body.password = options.password;
  if (options.expiresInDays) body.expiresInDays = options.expiresInDays;
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/shares`, {
    method: "POST",
    body,
  });
}

export async function revokeShare(projectId, shareId) {
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(shareId)}`, {
    method: "DELETE",
  });
}
