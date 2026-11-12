#!/usr/bin/env bash
# Fast reinstall: uninstall the team stack, then run the normal installer again.
#
#   ./scripts/reinstall-team.sh              # keep database/data volumes, rebuild and start
#   ./scripts/reinstall-team.sh --purge      # delete the team database/assets/env, then fresh install
#   ./scripts/reinstall-team.sh --yes        # skip this script's confirmation
#   ./scripts/reinstall-team.sh --help
#
# The default mode is the fastest safe path: containers are removed, PostgreSQL/service volumes and
# .env.team are kept, and setup-team.sh only rebuilds and starts the stack. --purge is destructive.
set -euo pipefail
cd "$(dirname "$0")/.."

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

if [[ ! -f .env.team ]]; then
  echo "No .env.team found; running a fresh setup instead."
  exec ./scripts/setup-team.sh
fi

if [[ "$ASSUME_YES" != "1" ]]; then
  if [[ "$PURGE" == "1" ]]; then
    echo "WARNING: reinstall --purge deletes the team PostgreSQL database, service assets and .env.team."
    read -r -p "Type REINSTALL AND DELETE to continue: " confirmation
    if [[ "$confirmation" != "REINSTALL AND DELETE" ]]; then
      echo "Cancelled." >&2
      exit 1
    fi
  else
    read -r -p "Reinstall the team stack while keeping database data? [y/N] " confirmation
    if [[ "$confirmation" != "y" && "$confirmation" != "Y" ]]; then
      echo "Cancelled." >&2
      exit 1
    fi
  fi
fi

if [[ "$PURGE" == "1" ]]; then
  ./scripts/uninstall-team.sh --purge --yes
else
  ./scripts/uninstall-team.sh --yes
fi

exec ./scripts/setup-team.sh
