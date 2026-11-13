import crypto from "node:crypto";

// Google is a real OpenID Connect provider: it exposes discovery, JWKS and a signed id_token.
// GitHub only implements OAuth 2.0, so its adapter fetches the profile and the verified primary
// email with the access token instead of verifying an id_token.
export const STATE_COOKIE = "khaoyu_oidc_state";
export const STATE_TTL_MS = 10 * 60 * 1000;
const ENDPOINT_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map();
const endpointCache = new Map();

export function enabledProviders(config) {
  return (config.oidcProviders || []).filter((provider) => provider && provider.enabled);
}

export function providerFor(config, id) {
  return enabledProviders(config).find((provider) => provider.id === id) || null;
}

// Only same-site paths may be used as a post-login destination. This blocks open redirects such as
// //evil.example, https://evil.example and /\evil.example.
export function sanitizeRedirect(value, fallback = "/admin") {
  const target = typeof value === "string" ? value.trim() : "";
  if (!target || !target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return fallback;
  }
  if (target.length > 500 || /[\u0000-\u001f\u007f]/.test(target)) return fallback;
  return target;
}

function stateSignature(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signState(data, secret, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ ...data, exp: now + STATE_TTL_MS }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${stateSignature(payload, secret)}`;
}

export function verifyState(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = stateSignature(payload, secret);
  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (!Number.isFinite(data.exp) || data.exp <= now) return null;
  return data;
}

function requireHttps(url, allowHttp) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error("OIDC endpoints must use HTTPS");
  }
  return parsed.toString();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`provider request failed with ${response.status}`);
  }
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("provider response is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("provider returned invalid JSON");
  }
}

async function oidcEndpoints(provider, fetchImpl = fetch) {
  if (provider.authorizationEndpoint && provider.tokenEndpoint && provider.jwksUri) {
    return {
      authorizationEndpoint: provider.authorizationEndpoint,
      tokenEndpoint: provider.tokenEndpoint,
      jwksUri: provider.jwksUri,
    };
  }
  const cacheKey = `${provider.id}:${provider.issuer}:${provider.discoveryUrl}`;
  const cached = endpointCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints;
  const discoveryUrl =
    provider.discoveryUrl ||
    new URL("/.well-known/openid-configuration", provider.issuer).toString();
  const data = await fetchImpl(requireHttps(discoveryUrl, provider.allowHttp), {
    headers: { accept: "application/json" },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`OIDC discovery failed with ${response.status}`);
    return response.json();
  });
  const endpoints = {
    authorizationEndpoint: requireHttps(data.authorization_endpoint, provider.allowHttp),
    tokenEndpoint: requireHttps(data.token_endpoint, provider.allowHttp),
    jwksUri: requireHttps(data.jwks_uri, provider.allowHttp),
  };
  endpointCache.set(cacheKey, { endpoints, expiresAt: Date.now() + ENDPOINT_TTL_MS });
  return endpoints;
}

export async function authorizationUrl(provider, { state, nonce, verifier, redirectUri, fetchImpl }) {
  if (provider.kind === "github") {
    const url = new URL(provider.authorizationEndpoint);
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", (provider.scopes || ["read:user", "user:email"]).join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }
  const endpoints = await oidcEndpoints(provider, fetchImpl);
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (provider.scopes || ["openid", "email", "profile"]).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function tokenRequest(provider, params, fetchImpl) {
  const response = await fetchImpl(provider.tokenEndpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`token exchange failed with ${response.status}`);
  try {
    const data = JSON.parse(text);
    if (data.error) throw new Error(`token exchange failed: ${data.error}`);
    return data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("token endpoint returned invalid JSON");
    throw error;
  }
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function verifyIdToken(idToken, provider, nonce, jwksUri) {
  if (typeof idToken !== "string") throw new Error("id_token is missing");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token is malformed");
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (header.alg !== "RS256") throw new Error("id_token algorithm is not supported");
  if (!header.kid) throw new Error("id_token key id is missing");

  let jwks = discoveryCache.get(jwksUri);
  if (!jwks || jwks.expiresAt <= Date.now()) {
    jwks = {
      keys: (await fetchJson(jwksUri)).keys || [],
      expiresAt: Date.now() + ENDPOINT_TTL_MS,
    };
    discoveryCache.set(jwksUri, jwks);
  }
  const jwk = jwks.keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("id_token signing key was not found");
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signature = Buffer.from(parts[2], "base64url");
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    publicKey,
    signature
  );
  if (!valid) throw new Error("id_token signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.iss !== "string" || claims.iss !== provider.issuer) {
    throw new Error("id_token issuer is invalid");
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(provider.clientId)) throw new Error("id_token audience is invalid");
  if (!Number.isFinite(claims.exp) || claims.exp + 60 < now) throw new Error("id_token has expired");
  if (Number.isFinite(claims.iat) && claims.iat > now + 120) throw new Error("id_token was issued in the future");
  if (nonce && claims.nonce !== nonce) throw new Error("id_token nonce is invalid");
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  if (!emailVerified || typeof claims.email !== "string") {
    throw new Error("provider did not return a verified email");
  }
  return {
    subject: String(claims.sub || ""),
    email: claims.email,
    displayName: claims.name || claims.given_name || claims.email.split("@")[0],
    avatarUrl: claims.picture || "",
  };
}

async function githubProfile(provider, accessToken, fetchImpl) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "khaoyu-note",
  };
  const user = await fetchJson(`${provider.userApi}/user`, { headers });
  const emails = await fetchJson(`${provider.userApi}/user/emails`, { headers });
  const primary = Array.isArray(emails)
    ? emails.find((entry) => entry.primary && entry.verified) ||
      emails.find((entry) => entry.verified)
    : null;
  if (!primary?.email) throw new Error("GitHub did not return a verified email");
  return {
    subject: String(user.id || ""),
    email: primary.email,
    displayName: user.name || user.login || primary.email.split("@")[0],
    avatarUrl: user.avatar_url || "",
  };
}

export async function finishAuthorization(provider, { code, nonce, verifier, redirectUri, fetchImpl = fetch }) {
  if (!code) throw new Error("authorization code is missing");
  if (provider.kind === "github") {
    const token = await tokenRequest(
      provider,
      {
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code,
        redirect_uri: redirectUri,
      },
      fetchImpl
    );
    if (!token.access_token) throw new Error("GitHub did not return an access token");
    return githubProfile(provider, token.access_token, fetchImpl);
  }

  const endpoints = await oidcEndpoints(provider, fetchImpl);
  const token = await tokenRequest(
    {
      ...provider,
      tokenEndpoint: endpoints.tokenEndpoint,
    },
    {
      grant_type: "authorization_code",
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    fetchImpl
  );
  return verifyIdToken(token.id_token, provider, nonce, endpoints.jwksUri);
}
