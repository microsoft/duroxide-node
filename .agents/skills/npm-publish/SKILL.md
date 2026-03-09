---
name: npm-publish
description: Publishing duroxide-node to npm. Use when releasing a new version, building platform binaries, or publishing to the npm registry.
---

# Publishing duroxide-node to npm

## Pre-Publish Checklist

Before publishing, verify ALL of the following:

### 1. Clean Build

```bash
cd duroxide-node

# Clippy — must pass with zero warnings
cargo clippy --all-targets

# Release build via napi
npx napi build --platform --release
```

### 2. Tests Pass

```bash
# All 52 tests must pass (requires DATABASE_URL in .env)
npm run test:all
```

### 3. Changelog Updated

- `CHANGELOG.md` must have an entry for the new version
- Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
- Include all Added/Changed/Fixed/Removed sections as applicable

### 4. README Points to Changelog

Verify `README.md` contains a link to `CHANGELOG.md`:
```markdown
> See [CHANGELOG.md](CHANGELOG.md) for release notes.
```

### 5. Version Bumped

Update version in `package.json` and all platform `package.json` files:

```bash
# Bump version (also updates npm/npm/*/package.json)
npx napi version
```

Or manually update `package.json` `version` field and ensure `optionalDependencies` versions match.

## Build Platform Binaries

Three platforms are supported:

### darwin-arm64 (macOS Apple Silicon) — native build
```bash
npx napi build --platform --release
cp duroxide.darwin-arm64.node npm/npm/darwin-arm64/
```

### darwin-x64 (macOS Intel) — native cross-compile
```bash
rustup target add x86_64-apple-darwin  # one-time
npx napi build --platform --release --target x86_64-apple-darwin
cp duroxide.darwin-x64.node npm/npm/darwin-x64/
```

### linux-x64-gnu — Docker build
```bash
docker run --rm -v "$(pwd):/build" -w /build --platform linux/amd64 rust:latest bash -c "
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - &&
  apt-get install -y nodejs &&
  npm install &&
  npx napi build --platform --release --target x86_64-unknown-linux-gnu
"
cp duroxide.linux-x64-gnu.node npm/npm/linux-x64-gnu/
```

### win32-x64-msvc (Windows) — Docker + cargo-xwin (optional)
Not currently built. Can be added with `cargo-xwin` in a Linux Docker container.

## Publish Order

Platform packages MUST be published before the main package (npm resolves optionalDependencies at install time).

### 1. Publish platform packages
```bash
# Requires an npm Automation token (bypasses 2FA)
AUTH="--//registry.npmjs.org/:_authToken=<TOKEN>"

cd npm/npm/darwin-arm64 && npm publish --access public $AUTH && cd -
cd npm/npm/darwin-x64   && npm publish --access public $AUTH && cd -
cd npm/npm/linux-x64-gnu && npm publish --access public $AUTH && cd -
```

### 2. Publish main package
```bash
cd duroxide-node
npm publish --access public $AUTH
```

The `prepublishOnly` script runs `napi prepublish -t npm` automatically, which verifies platform binaries exist.

### 3. Verify (MANDATORY — DO NOT SKIP)

⚠️ **A release is NOT complete until ALL packages are verified on npm.** The main `duroxide` package depends on platform binary packages via `optionalDependencies`. If any platform package is missing, the install will silently succeed but the native binary won't load at runtime.

**Step 3a: Verify all platform packages exist on npm**
```bash
VERSION="<NEW_VERSION>"  # e.g., 0.1.14
for pkg in duroxide-darwin-arm64 duroxide-darwin-x64 duroxide-linux-x64-gnu duroxide-windows-x64; do
  echo -n "$pkg@$VERSION: "
  npm view "$pkg@$VERSION" version 2>/dev/null && echo "✅" || echo "❌ MISSING — DO NOT PROCEED"
done
```

If ANY platform package shows ❌, **STOP** and fix before continuing. The most common failure mode is version skew — the platform `package.json` files (`npm/npm/*/package.json`) were not bumped to match the main `package.json` version. This causes `npm publish` to try re-publishing an old version, which npm rejects with E403, and the `|| true` in CI silently swallows the error.

**Step 3b: Verify main package**
```bash
npm view "duroxide@$VERSION" version
```

**Step 3c: Integration test in a clean directory**
```bash
cd /tmp && mkdir test-duroxide && cd test-duroxide
npm install duroxide@$VERSION
node -e "const d = require('duroxide'); console.log('loaded:', Object.keys(d).slice(0,5))"
rm -rf /tmp/test-duroxide
```

All three steps must pass. If Step 3c fails with a missing native binary error, one of the platform packages is broken.

## npm Authentication

- Publishing requires an **Automation** token (bypasses 2FA)
- Create at: https://www.npmjs.com/settings/<username>/tokens
- Token type: **Automation** (not Granular, unless "bypass 2FA" is enabled)
- Never commit tokens to source code

## Version Cascade

When bumping versions, update `optionalDependencies` in the main `package.json` to match:

```json
"optionalDependencies": {
  "duroxide-darwin-arm64": "<NEW_VERSION>",
  "duroxide-darwin-x64": "<NEW_VERSION>",
  "duroxide-linux-x64-gnu": "<NEW_VERSION>",
  "duroxide-win32-x64-msvc": "<NEW_VERSION>"
}
```

## Summary Checklist

- [ ] `cargo clippy --all-targets` — zero warnings
- [ ] `npx napi build --platform --release` — clean build
- [ ] `npm run test:all` — all tests pass
- [ ] `CHANGELOG.md` — updated for new version
- [ ] `README.md` — links to CHANGELOG.md
- [ ] Version bumped in `package.json` + **ALL** platform packages (`npm/npm/*/package.json`)
- [ ] Platform binaries built and copied to `npm/npm/*/`
- [ ] Platform packages published first
- [ ] Main package published
- [ ] **ALL 4 platform packages verified on npm** (`npm view <pkg>@<version>`)
- [ ] **Main package verified on npm** (`npm view duroxide@<version>`)
- [ ] Verified with `npm install duroxide` in a clean directory — native binary loads
