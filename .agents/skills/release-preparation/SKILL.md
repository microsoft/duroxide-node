---
name: release-preparation
description: Preparing a duroxide-node npm release PR without publishing. Use when bumping the package version, finalizing the changelog, or preparing release changes for a maintainer.
---

# Preparing a duroxide-node Release

Prepare the public release changes for review. Publishing is performed separately
by a Microsoft maintainer through the internal release pipeline.

## 1. Confirm the Release

Before editing, identify:

- The target npm version without a `v` prefix.
- The changes that should move from `Unreleased` into the release.
- Whether the release is stable or a prerelease such as `-rc.0`.

Follow Semantic Versioning and the policy in
[RELEASE_POLICY.md](../../../RELEASE_POLICY.md).

## 2. Synchronize npm Versions

Set the target version in:

- `package.json`
- Every `npm/npm/*/package.json`
- Every entry in `package.json` `optionalDependencies`

All six package versions and all five optional dependency versions must match.
Do not change the `Cargo.toml` package version as part of an npm-only release.

## 3. Finalize the Changelog

In `CHANGELOG.md`:

1. Keep an empty `## [Unreleased]` section at the top.
2. Add `## [X.Y.Z] - YYYY-MM-DD` below it.
3. Move the release changes under the appropriate Keep a Changelog headings:
   `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`.
4. Describe user-visible behavior and dependency changes precisely.

Update other documentation only when the release changes make it inaccurate.

## 4. Validate the Release Changes

Run the existing checks:

```bash
cargo clippy --all-targets
npm run build
npm run test:all
npm pack --dry-run
```

`npm run test:all` requires the configured PostgreSQL test database. GitHub
Actions performs the cross-platform builds and local-package smoke tests.

Before finishing, verify that the root package, all platform packages, and all
optional dependencies use the same target version.

## 5. Prepare the Pull Request

The release preparation is complete when the version updates, changelog, and
required documentation are ready for maintainer review.

Do not:

- Run `npm publish`.
- Create or push a release tag.
- Create a GitHub Release.
- Add publishing credentials or internal pipeline configuration.

A Microsoft maintainer handles publication through the internal release
pipeline after the release pull request is merged.
