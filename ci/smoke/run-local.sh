#!/usr/bin/env bash
# Pre-publish smoke: install duroxide main + matching platform subpackage from
# LOCAL tarballs in a fresh temp dir (outside the repo), then run smoke.mjs.
# Reproduces the exact require-path that `npm install duroxide` exercises for
# end users, which is where issue #13 surfaces.
#
# Required env:
#   TARBALL_MAIN      - absolute path to duroxide-<version>.tgz
#   TARBALL_PLATFORM  - absolute path to duroxide-<platform>-<version>.tgz
#   SMOKE_SCRIPT      - absolute path to ci/smoke/smoke.mjs
set -euo pipefail

: "${TARBALL_MAIN:?TARBALL_MAIN must be set}"
: "${TARBALL_PLATFORM:?TARBALL_PLATFORM must be set}"
: "${SMOKE_SCRIPT:?SMOKE_SCRIPT must be set}"

WORKDIR="$(mktemp -d -t duroxide-smoke-XXXXXX)"
echo "[smoke] workdir=$WORKDIR"
echo "[smoke] main=$TARBALL_MAIN"
echo "[smoke] platform=$TARBALL_PLATFORM"

cd "$WORKDIR"
npm init -y >/dev/null
# Installing the platform tarball first guarantees the optional-dep name
# resolves locally — registry fallback would defeat the point of smoke-local.
npm install --no-audit --no-fund --ignore-scripts "$TARBALL_PLATFORM" "$TARBALL_MAIN"

cp "$SMOKE_SCRIPT" ./smoke.mjs
node ./smoke.mjs
echo "[smoke] local smoke OK"
