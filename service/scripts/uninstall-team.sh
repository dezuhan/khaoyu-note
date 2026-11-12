#!/usr/bin/env bash
# Stop or remove the team Docker stack.
#
#   ./scripts/uninstall-team.sh              # stop/remove containers, keep PostgreSQL/service data
#   ./scripts/uninstall-team.sh --purge      # also delete PostgreSQL + service data volumes and .env.team
#   ./scripts/uninstall-team.sh --yes        # skip the stop confirmation
#   ./scripts/uninstall-team.sh --help
#
# This only manages the Compose stack. A managed/external PostgreSQL or Redis must be deleted through
# its own provider. Take a backup first if you want to keep the data.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.team}"
PURGE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

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

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run setup-team.sh first, or pass ENV_FILE=..." >&2
  exit 1
fi

if [[ "$PURGE" == "1" ]]; then
  echo "WARNING: this deletes the PostgreSQL database, service data, assets and backups stored in"
  echo "Docker volumes for this stack. It cannot be undone. External PostgreSQL/Redis are untouched."
  if [[ "$ASSUME_YES" != "1" ]]; then
    read -r -p "Type DELETE TEAM DATA to continue: " confirmation
    if [[ "$confirmation" != "DELETE TEAM DATA" ]]; then
      echo "Cancelled." >&2
      exit 1
    fi
  fi
  $COMPOSE --env-file "$ENV_FILE" -f docker-compose.team.yml --profile tunnel down -v --remove-orphans
  rm -f "$ENV_FILE"
  echo "Removed team containers, volumes and $ENV_FILE."
else
  if [[ "$ASSUME_YES" != "1" ]]; then
    read -r -p "Stop the team stack? Data volumes and $ENV_FILE will be kept [y/N] " confirmation
    if [[ "$confirmation" != "y" && "$confirmation" != "Y" ]]; then
      echo "Cancelled." >&2
      exit 1
    fi
  fi
  $COMPOSE --env-file "$ENV_FILE" -f docker-compose.team.yml --profile tunnel down --remove-orphans
  echo "Stopped team containers. Data volumes and $ENV_FILE were kept."
  echo "Run with --purge to delete the database and service data volumes."
fi

echo "Desktop/local data is unaffected. Remove the desktop app through your package manager or by"
echo "deleting the AppImage; its data lives under the platform app-data directory."
