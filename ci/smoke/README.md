# Packaging smoke tests

Cross-platform smoke tests that exercise the **distributable** `duroxide` npm
package — not the source tree. Installs into a fresh temp dir, resolves the
napi-rs platform subpackage, runs a minimal SQLite-backed orchestration.

Motivated by [microsoft/duroxide#13](https://github.com/microsoft/duroxide/issues/13):
the Windows platform subpackage was renamed from `duroxide-win32-x64-msvc` to
`duroxide-windows-x64` but `index.js` kept the old name, breaking every Windows
install. The in-repo `__tests__/` suite didn't catch it because napi-rs falls
back to the local `.node` binary when run from the repo.

## Files

| File                     | Purpose                                         |
|--------------------------|-------------------------------------------------|
| `smoke.mjs`              | Hello-world orchestration using `SqliteProvider`. |
| `run-local.sh` / `.ps1`  | Install from local tarballs (pre-publish).      |
| `run-registry.sh` / `.ps1` | Install from npm registry (post-publish).     |

## Parity

The smoke script MUST stay semantically in sync with the equivalent script in
the Python SDK (`sdks/duroxide-python/ci/smoke/smoke.py`). The duroxide-update-
manager agent owns keeping them in sync — see its instructions.
