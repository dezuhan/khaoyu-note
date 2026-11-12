#!/usr/bin/env bash
# One-command team setup: generates .env.team, starts PostgreSQL + Redis + service, and creates the
# first owner account. Run from the service directory:
#
#   ./scripts/setup-team.sh
#
# Re-running is safe: existing .env.team is reused and the bootstrap step is skipped once an owner
# exists. To expose the service publicly, start with --profile tunnel after setting
# CLOUDFLARE_TUNNEL_TOKEN, or point your own TLS reverse proxy at 127.0.0.1:18080.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.team}"
COMPOSE="${COMPOSE:-docker compose}"
if ! command -v docker >/dev/null 2>&1; then
  if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    COMPOSE="podman compose"
  elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE="podman-compose"
  else
    echo "Need docker compose, podman compose or podman-compose." >&2
    exit 1
  fi
fi

random_hex() { openssl rand -hex "${1:-24}"; }

normalize_url() {
  local value="$1"
  if [[ ! "$value" =~ ^https?:// ]]; then
    value="https://$value"
  fi
  printf '%s' "$value"
}

CREATED_ENV=0
if [[ ! -f "$ENV_FILE" ]]; then
  CREATED_ENV=1
  read -r -p "Backend/service URL [http://127.0.0.1:18080]: " PUBLIC_URL
  PUBLIC_URL="$(normalize_url "${PUBLIC_URL:-http://127.0.0.1:18080}")"
  read -r -p "Public view/share URL [same as backend]: " PUBLIC_VIEW_URL
  PUBLIC_VIEW_URL="$(normalize_url "${PUBLIC_VIEW_URL:-$PUBLIC_URL}")"
  read -r -p "Initial owner email [owner@localhost]: " BOOTSTRAP_EMAIL
  BOOTSTRAP_EMAIL="${BOOTSTRAP_EMAIL:-owner@localhost}"
  read -r -p "Cloudflare tunnel token (optional, press Enter to skip): " TUNNEL_TOKEN

  cat > "$ENV_FILE" <<ENV
KHAOYU_SERVICE_PROFILE=team
KHAOYU_SERVICE_PUBLIC_URL="${PUBLIC_URL}"
KHAOYU_SERVICE_SHARE_PUBLIC_URL="${PUBLIC_VIEW_URL}"
KHAOYU_SERVICE_MAIN_APP_URL="${PUBLIC_VIEW_URL}"
KHAOYU_SERVICE_COOKIE_SECURE=$( [[ "$PUBLIC_URL" == https://* ]] && echo true || echo false )
KHAOYU_SERVICE_TRUST_PROXY=true
KHAOYU_SERVICE_PUBLIC_SHARING=true
KHAOYU_SERVICE_SECRET="$(random_hex 32)"
KHAOYU_SERVICE_CORS_ORIGINS="tauri://localhost,http://tauri.localhost,http://127.0.0.1:1430,http://localhost:1430,${PUBLIC_URL},${PUBLIC_VIEW_URL}"
KHAOYU_SERVICE_POSTGRES_DB=khaoyu
KHAOYU_SERVICE_POSTGRES_USER=khaoyu
KHAOYU_SERVICE_POSTGRES_PASSWORD="$(random_hex 24)"
KHAOYU_SERVICE_REDIS_PASSWORD="$(random_hex 24)"
KHAOYU_BOOTSTRAP_EMAIL="${BOOTSTRAP_EMAIL}"
KHAOYU_BOOTSTRAP_NAME="Owner"
KHAOYU_BOOTSTRAP_PROJECT="Khaoyu Note"
KHAOYU_BOOTSTRAP_PASSWORD="$(random_hex 18)"
KHAOYU_SERVICE_BACKUP_PASSPHRASE="$(random_hex 24)"
KHAOYU_SERVICE_OBJECT_KEY="$(random_hex 32)"
CLOUDFLARE_TUNNEL_TOKEN="${TUNNEL_TOKEN}"
ENV
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE (mode 0600)."
fi

# shellcheck disable=SC1090
if [[ "$ENV_FILE" = /* ]]; then ENV_PATH="$ENV_FILE"; else ENV_PATH="./$ENV_FILE"; fi
set -a; . "$ENV_PATH"; set +a

for variable in KHAOYU_SERVICE_PUBLIC_URL KHAOYU_SERVICE_SHARE_PUBLIC_URL; do
  value="${!variable:-}"
  if [[ ! "$value" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "$variable must be an http:// or https:// URL; got: $value" >&2
    exit 1
  fi
done

echo "Starting PostgreSQL, Redis and service..."
$COMPOSE --env-file "$ENV_FILE" -f docker-compose.team.yml up -d --build

echo "Waiting for the service health check..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${KHAOYU_SERVICE_PUBLISH_PORT:-18080}/readyz" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${KHAOYU_SERVICE_PUBLISH_PORT:-18080}/readyz" || {
  echo "Service did not become ready. Check: $COMPOSE -f docker-compose.team.yml logs service" >&2
  exit 1
}
echo

# Always run the idempotent bootstrap after startup. This also handles a first run that failed after
# creating .env.team but before the database existed: the owner is created and the generated password
# is printed exactly once.
echo "Ensuring the first owner account..."
BOOTSTRAP_OUTPUT="$($COMPOSE --env-file "$ENV_FILE" -f docker-compose.team.yml exec -T service \
  node src/cli.mjs bootstrap-postgres)"
if echo "$BOOTSTRAP_OUTPUT" | grep -q '"createdAccount": true'; then
  echo
  echo "First owner login"
  echo "  email:    ${KHAOYU_BOOTSTRAP_EMAIL}"
  echo "  password: ${KHAOYU_BOOTSTRAP_PASSWORD}"
  echo "Change this password immediately after signing in."
else
  echo "Owner already exists in PostgreSQL; the existing password was not changed."
  echo "If you lost it, use the service password-reset flow or the owner account in the admin dashboard."
fi

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "Starting Cloudflare Tunnel..."
  $COMPOSE --env-file "$ENV_FILE" -f docker-compose.team.yml --profile tunnel up -d cloudflared
fi

echo "Backend/admin: ${KHAOYU_SERVICE_PUBLIC_URL}/login"
echo "Public view:   ${KHAOYU_SERVICE_SHARE_PUBLIC_URL}/s/<share-token>"
echo "PostgreSQL and Redis are internal-only; only 127.0.0.1:${KHAOYU_SERVICE_PUBLISH_PORT:-18080}/${KHAOYU_SERVICE_PUBLISH_BACKEND_PORT:-18081} are published."
