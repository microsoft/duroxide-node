# Release Policy

`duroxide` and its platform packages are published to npm by Microsoft's
internal open-source release infrastructure. Publishing credentials and release
execution remain outside this repository.

## Contributor Workflow

Contributors can prepare a release through a pull request:

1. Keep the root package version, every `npm/npm/*/package.json` version, and
   all platform `optionalDependencies` aligned.
2. Update `CHANGELOG.md` and relevant documentation.
3. Open a pull request for review. GitHub Actions runs the build, tests, and
   package smoke checks.

After the release change is merged, a Microsoft maintainer runs the internal
release pipeline to build and publish the packages to npm.

## GitHub Release

After all six packages for a version are on npm, a maintainer creates a GitHub
Release for that version:

- Tag: `vX.Y.Z`, on the merged release commit.
- Title: `duroxide-node X.Y.Z`.
- Notes: the version's section of `CHANGELOG.md`.
- Assets: the six tarballs that npm serves for that version, unchanged, and a
  `SHA256SUMS` file that lists them.

`npm pack <package>@<version>` downloads a published tarball unchanged. In an
empty directory, with the notes in `notes.md`:

```bash
VERSION=X.Y.Z
for pkg in duroxide duroxide-darwin-arm64 duroxide-darwin-x64 \
  duroxide-linux-arm64-gnu duroxide-linux-x64-gnu duroxide-windows-x64; do
  npm pack "$pkg@$VERSION"
done
shasum -a 256 *.tgz > SHA256SUMS
gh release create "v$VERSION" --repo microsoft/duroxide-node --verify-tag \
  --title "duroxide-node $VERSION" --notes-file notes.md *.tgz SHA256SUMS
```

Attach only tarballs downloaded from npm. Tarballs from CI, or from `npm pack`
in a checkout of this repository, are not the published packages. Their native
binaries are built separately, and the Linux binaries from CI need a newer
glibc than the published ones.

## Publishing Boundary

- Do not run `npm publish` for the Microsoft release.
- Create the GitHub Release only after the packages are on npm, and attach only
  tarballs downloaded from npm.
- Do not request or store Microsoft publishing credentials in this repository.

For release questions, open a GitHub issue without including credentials or
internal pipeline configuration.
