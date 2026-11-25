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

The lifecycle suite requires a freshly built local native module.
Do not use an optional prebuilt platform package.
Production builds omit private test controls.
Keep native outputs, Cargo targets, and staged sources separate for each mode.
For example, from the repository root in PowerShell:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target\lifecycle-production\cargo'
npx napi build --platform --js false --dts bindings.d.ts --cargo-flags="--locked" target\lifecycle-production\native
node ci\stage-lifecycle.cjs target\lifecycle-production\native target\lifecycle-production\stage production
node ci\run-lifecycle.cjs production target\lifecycle-production\stage

$env:CARGO_TARGET_DIR = Join-Path $PWD 'target\lifecycle-instrumented\cargo'
npx napi build --platform --features test-hooks --js false --dts bindings.d.ts --cargo-flags="--locked" target\lifecycle-instrumented\native
node ci\stage-lifecycle.cjs target\lifecycle-instrumented\native target\lifecycle-instrumented\stage instrumented
node ci\run-lifecycle.cjs instrumented target\lifecycle-instrumented\stage
Remove-Item Env:CARGO_TARGET_DIR
```

Instrumented cases exercise real provider waits and contained faults in owned tasks.
The `lifecycle-instrumented` CI job runs on pull requests and main, alongside production tests.
Every hook-dependent case must execute.
Missing hooks, mode or hash mismatches, skips, TODOs, aborted tests, and empty selections fail validation.
Production mode skips only explicitly marked instrumented cases.
It also checks that private exports are absent.

The stage manifest identifies the exact local addon, its SHA-256, the selected feature mode, and source hashes.
Tests match the Duroxide loader's native class identities, not an arbitrary cached `.node`.
Sources use a stage-local `node_modules` directory.
This prevents root-level test discovery from running duplicate staged suites.
The runner sets mode and provenance only in its child environment.
It retains TAP, stderr, and JSON totals beside the manifest.
Instrumented evidence artifacts do not use `binary-*` names or contain native binaries.
They never feed packing or release jobs.
`CARGO_TARGET_DIR` also tells napi where to find the compiled library.
Cargo's `--target-dir` alone does not set napi's source path.
The `--dts` filename is relative to napi's destination directory.

Both ordered races still run **100 iterations**.
Held-provider probes require `6000 <= elapsedMs < 7000` for omitted grace,
`5000 <= elapsedMs < 6000` for zero grace, and `repeatedMs < 1000`.
A separate message-delivery watchdog allows the first call, repeated call, and limited transport time.
It cannot relax those measured SDK limits.

The suite checks event-loop liveness during incomplete cleanup, without stdin or referenced timers.
It also checks collection of activity-only self-capturing callbacks in a live process, after the creating frames return.
Collection uses bounded WeakRef/FinalizationRegistry settling and a noncapturing control.
It does not use natural process exit or zero task counts as proof.
Cases cover successful, quiescent-error, and late cleanup, including late release without another stop caller.

Harness and oracle checks that do not need native code can run before a native build:
`node --test __tests__/lifecycle-oracles.test.js`.
They include negative controls for child failure, malformed protocol, a zero-start counter, and CI skips.

Do not publish instrumented assets or temporary local core overrides.
A matching published core minimum remains a separate prerequisite.
CI must fail when core APIs are missing.
It must not silently skip coverage or substitute an unofficial dependency.