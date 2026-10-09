# Contributing

This project welcomes contributions and suggestions. Most contributions require you to
agree to a Contributor License Agreement (CLA) declaring that you have the right to,
and actually do, grant us the rights to use your contribution. For details, visit
https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need
to provide a CLA and decorate the PR appropriately (for example, label or comment).
Simply follow the instructions provided by the bot. You will only need to do this once
across all repositories using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Reporting security issues

Please do not report security vulnerabilities through public GitHub issues. Follow the instructions in [SECURITY.md](SECURITY.md).

## Development workflow

Install Rust using [rustup](https://rustup.rs). The root `rust-toolchain.toml` selects
the compiler for local development and CI. Run `rustup show active-toolchain` from
the repository to install it, and `rustup component add clippy` before running Clippy.

Before opening a pull request, run the checks relevant to your change:

```bash
npx napi build --platform
npm test
npm run test:races
npm run test:admin
npm run test:scenarios
npm run test:sessions
cargo clippy --all-targets
```

After Rust source changes (`src/*.rs`), re-run `npx napi build --platform` before running JavaScript tests.

### Lifecycle checks without PostgreSQL

The lifecycle suite requires a freshly built local native module, not an optional
prebuilt platform package. Its private controls are absent from production builds.
For example, in PowerShell:

```powershell
npm run build:debug -- --features test-hooks --js false --dts target\lifecycle-native.d.ts
$env:DUROXIDE_LIFECYCLE_TEST_HOOKS = '1'
npm run test:lifecycle
Remove-Item Env:DUROXIDE_LIFECYCLE_TEST_HOOKS
npm run build:debug -- --js false --dts target\lifecycle-native.d.ts
npm run test:lifecycle
```

Instrumented cases exercise real provider waits and contained owned-task faults.
The suite checks native import provenance, 100 repetitions per ordered race,
bounded child-process cleanup, and production export absence. Production mode
skips only hook-dependent cases. Do not publish instrumented assets or temporary
local core overrides. A matching published core minimum is required before release.