#!/usr/bin/env bash
# Post-publish smoke: install `duroxide@<version>` from the real npm registry
# and run the smoke script. Catches registry-propagation / platform-subpackage
# resolution issues that `npm view` existence checks miss.
#
# Required env:
#   DUROXIDE_VERSION  - version to install (e.g. 0.1.20 or 0.1.20-rc.0)
#   SMOKE_SCRIPT      - absolute path to ci/smoke/smoke.mjs
set -euo pipefail

: "${DUROXIDE_VERSION:?DUROXIDE_VERSION must be set}"
: "${SMOKE_SCRIPT:?SMOKE_SCRIPT must be set}"

WORKDIR="$(mktemp -d -t duroxide-smoke-XXXXXX)"
echo "[smoke] workdir=$WORKDIR"
echo "[smoke] version=$DUROXIDE_VERSION"

cd "$WORKDIR"
npm init -y >/dev/null

attempts=6
for i in $(seq 1 "$attempts"); do
  if npm install --no-audit --no-fund "duroxide@$DUROXIDE_VERSION"; then
    break
  fi
  if [ "$i" -eq "$attempts" ]; then
    echo "[smoke] install failed after $attempts attempts" >&2
    exit 1
  fi
  sleep_s=$(( i * 10 ))
  echo "[smoke] install attempt $i failed; sleeping ${sleep_s}s"
  sleep "$sleep_s"
done

cp "$SMOKE_SCRIPT" ./smoke.mjs
node ./smoke.mjs
echo "[smoke] registry smoke OK"
