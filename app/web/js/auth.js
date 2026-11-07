// Local account state for milestone M1. The session stays in memory only: the desktop host
// persists it in session.json and the web host keeps it in an HttpOnly cookie.

import * as bridge from "./bridge.js";

const listeners = new Set();

const state = {
  ready: false,
  loading: false,
  available: false,
  userCount: 0,
  requireLogin: true,
  guestAllowed: false,
  csrfToken: null,
  user: null,
  error: "",
};

let refreshing = null;
let restored = false;

function emit() {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.error(error);
    }
  }
}

export function authState() {
  return state;
}

export function subscribeAuth(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyStatus(status) {
  if (!status) return;
  if (status.user !== undefined) state.user = status.user || null;
  if (status.userCount !== undefined) state.userCount = Number(status.userCount) || 0;
  if (status.requireLogin !== undefined) state.requireLogin = Boolean(status.requireLogin);
  if (status.guestAllowed !== undefined) state.guestAllowed = Boolean(status.guestAllowed);
  if (status.csrfToken !== undefined) state.csrfToken = status.csrfToken || null;
  state.available = status.available !== false;
}

export async function refreshAuth() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    state.loading = true;
    emit();
    try {
      const status = await bridge.authStatus();
      applyStatus(status);
      state.error = "";
    } catch (error) {
      state.available = false;
      state.error = error?.message || "Accounts are unavailable";
    } finally {
      state.ready = true;
      state.loading = false;
      refreshing = null;
      emit();
    }
    return state;
  })();
  return refreshing;
}

export async function initAuth() {
  if (!restored) {
    restored = true;
    try {
      await bridge.authRestoreSession();
    } catch {
      /* A missing or expired remembered session is treated as guest. */
    }
  }
  return refreshAuth();
}

export async function setupAdmin(input) {
  const result = await bridge.authSetupAdmin(input);
  if (result?.user) {
    state.user = result.user;
    state.userCount = Math.max(1, state.userCount);
    state.available = true;
    emit();
  }
  await refreshAuth();
  return result;
}

export async function login(input) {
  const result = await bridge.authLogin(input);
  if (result?.user) {
    state.user = result.user;
    state.userCount = Math.max(1, state.userCount);
    state.available = true;
    emit();
  }
  await refreshAuth();
  return result;
}

export async function logout() {
  await bridge.authLogout();
  state.user = null;
  emit();
  await refreshAuth();
}

export async function logoutAll() {
  await bridge.authLogoutAll();
  state.user = null;
  emit();
  await refreshAuth();
}

export async function updateProfile(profile) {
  const user = await bridge.authUpdateProfile(profile);
  if (user) {
    state.user = user;
    emit();
  }
  return user;
}

export async function changePassword(input) {
  await bridge.authChangePassword(input);
}

export async function loadHistory(limit = 20, offset = 0) {
  return bridge.authHistory({ limit, offset });
}

export function isAdmin() {
  return Boolean(state.user && state.user.role === "admin");
}

export function canEdit() {
  if (!state.user) return false;
  return isAdmin() || state.user.memberRole === "editor";
}

export function canComment() {
  if (!state.user) return false;
  return isAdmin() || state.user.memberRole === "editor" || state.user.memberRole === "commenter";
}
