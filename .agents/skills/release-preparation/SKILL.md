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

## 4. Open the Release Pull Request

The release preparation is complete when the version updates, changelog, and
required documentation are ready for maintainer review.

Create a pull request targeting `main`. Do not create the release tag while the
pull request is open.

GitHub Actions validates the full SDK test suite, cross-platform builds, and
local-package smoke tests on the pull request.

## 5. Maintainer Handoff

After the pull request is merged, release preparation is complete.

Do not create or push a release tag, run `npm publish`, create a GitHub Release,
or add publishing credentials or internal pipeline configuration. A Microsoft
maintainer handles tagging and publication through the internal release
pipeline.
