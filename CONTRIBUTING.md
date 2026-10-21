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
Keep native outputs, Cargo targets and staged sources separate in both modes.
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

Instrumented cases exercise real provider waits and contained owned-task faults.
The recurring `lifecycle-instrumented` CI job runs on pull requests and main,
alongside production tests. It requires every hook-dependent case to execute:
missing hooks, mode/hash mismatches, skips, TODOs, aborted tests or empty selection
fail validation. Production mode skips only explicitly marked instrumented cases
and continues to assert that private exports are absent.

The stage manifest identifies the exact local addon and SHA-256, selected feature
mode and source hashes. Tests match the Duroxide loader's native class identities,
not an arbitrary cached `.node`. Sources live under a stage-local `node_modules`
directory so root-level test discovery cannot run duplicate staged suites. The
runner sets mode/provenance only in its child environment and retains TAP, stderr
and JSON totals beside the manifest. Instrumented evidence artifacts are not
named `binary-*`, contain no native binaries, and never feed packing/release jobs.
`CARGO_TARGET_DIR` also tells napi where to copy the compiled library from;
passing only Cargo's `--target-dir` would not set napi's source path.
The `--dts` filename is relative to napi's destination directory.

Both ordered races still run **100 iterations**. Held-provider probes still
require `6000 <= elapsedMs < 7000` for omitted grace, `5000 <= elapsedMs < 6000`
for zero grace, and `repeatedMs < 1000`. Their separate message-delivery watchdog
allows the first call, repeated call and bounded transport headroom; it cannot
relax those measured SDK limits. The suite also checks incomplete-cleanup
event-loop liveness without stdin/referenced timers, and activity-only
self-capturing callback collection in a live process after creating frames retire.
Collection uses bounded WeakRef/FinalizationRegistry settling with a noncapturing
control, not natural process exit or zero task counts. Successful, quiescent-error
and late cleanup are covered, including late release with no further stop caller.

Native-independent harness/oracle checks can run before a native build:
`node --test __tests__/lifecycle-oracles.test.js`. They include deliberate child
failure, malformed protocol, zero-start counter and CI-skip negative controls.

Do not publish instrumented assets or temporary local core overrides. A matching
published core minimum remains a separate prerequisite: CI must fail missing core
APIs rather than silently skip coverage or substitute an unofficial dependency.