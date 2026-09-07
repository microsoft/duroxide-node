# Release Policy

`duroxide` and its platform packages are published to npm by Microsoft's
internal open-source release infrastructure. Publishing credentials and release
execution remain outside this repository.

## Contributor Workflow

Contributors can prepare a release through a pull request:

1. Update the version in `package.json` and `npm/npm/*/package.json`.
2. Update `CHANGELOG.md` and relevant documentation.
3. Open a pull request for review. GitHub Actions runs the build, tests, and
   package smoke checks.

After the release change is merged, a Microsoft maintainer creates the matching
release tag and uses the internal release pipeline to build and publish the
packages to npm.

## Publishing Boundary

- Do not run `npm publish` for the Microsoft release.
- Do not create a GitHub Release manually.
- Do not request or store Microsoft publishing credentials in this repository.

For release questions, open a GitHub issue without including credentials or
internal pipeline configuration.
