# duroxide-node — AI Coding Assistant Instructions

> **🚨 STOP: DO NOT `git commit` OR `git push` WITHOUT EXPLICIT USER PERMISSION 🚨**
>
> Always ask before committing or pushing. Never assume.

## ⚠️ SDK Symmetry — duroxide-node & duroxide-python MUST stay in sync

When making changes to this SDK, **always** check `../duroxide-python` for symmetry:
1. **Bug fixes**: If you fix a bug here, apply the same fix in duroxide-python (and vice versa)
2. **API parity**: Every public API in one SDK must have an equivalent in the other (adjusted for language idioms — camelCase in JS, snake_case in Python)
3. **Test parity**: Every test in one SDK must have a corresponding test in the other
4. **Feature parity**: New duroxide features exposed in one SDK must be exposed in both
5. **Rust handler code** (`src/handlers.rs`): Both SDKs share the same interop architecture — `execute_task`, `make_select_future`, `make_join_future` should be kept structurally identical

## Project Overview

duroxide-node is a **Node.js/TypeScript SDK** for the [Duroxide](https://github.com/microsoft/duroxide) durable execution runtime. It wraps the Rust runtime via [napi-rs](https://napi.rs), exposing generator-based orchestrations and async activities to JavaScript.

Key docs: `docs/architecture.md`, `docs/user-guide.md`.

## Architecture

```
lib/duroxide.js          ← JS wrapper: generator driver, OrchestrationContext, ActivityContext
src/lib.rs               ← napi entry point, trace functions
src/handlers.rs          ← Core interop: orchestration handler loop, activity invocation,
                           global context maps, select/race/join, activity cancellation
src/types.rs             ← ScheduledTask enum (activity, timer, wait, orchestration, etc.)
src/runtime.rs           ← JsRuntime (wraps duroxide::Runtime)
src/client.rs            ← JsClient (wraps duroxide::Client, including admin/management APIs)
src/provider.rs          ← JsSqliteProvider
src/pg_provider.rs       ← JsPostgresProvider
__tests__/e2e.test.js    ← PostgreSQL e2e tests (24 tests + 1 SQLite smoketest)
__tests__/races.test.js  ← ctx.all() and ctx.race() with mixed task types + cancellation (7 tests)
__tests__/admin_api.test.js ← Admin/management API tests (14 tests)
__tests__/sessions.test.js ← Session support tests (6 tests, SQLite in-memory)
__tests__/scenarios/     ← Scenario tests modeling real-world patterns (toygres, 6 tests)
```

## ⚠️ Critical: Yield vs Await

This is the most important design constraint. **Get this wrong and replay breaks.**

- **Orchestrations** use `function*` (generators) and `yield` for all durable operations
- **Activities** use `async function` and `await` (normal async)
- **Tracing** methods (`ctx.traceInfo()` etc.) are fire-and-forget — no yield needed

```javascript
// ✅ Orchestration: generator, yield for durable operations
runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
  ctx.traceInfo('starting');                                     // no yield — fire-and-forget
  const result = yield ctx.scheduleActivity('Work', input);      // yield — durable
  return result;
});

// ✅ Activity: async function, await for I/O
runtime.registerActivity('Work', async (ctx, input) => {
  ctx.traceInfo(`processing ${input}`);
  const data = await fetch(input.url);
  return data;
});
```

**Why generators?** The Rust replay engine needs full control over each step — it calls `poll_once()` on `DurableFuture`s and feeds cached results during replay. `await` would yield control to the JS event loop, breaking the replay engine's synchronous step-by-step model. See `docs/architecture.md` for the full explanation.

## ⚠️ Critical: Tracing Delegates to Rust

Tracing in both orchestrations and activities delegates to Rust contexts via global `HashMap`s. **Do NOT reimplement tracing in JS.**

- **Orchestration tracing**: `orchestrationTraceLog(instanceId, level, message)` → looks up `OrchestrationContext` from `ORCHESTRATION_CTXS` map → calls `ctx.trace()` which handles `is_replaying` suppression
- **Activity tracing**: `activityTraceLog(token, level, message)` → looks up `ActivityContext` from `ACTIVITY_CTXS` map → calls `ctx.trace_info()` etc. with full structured fields

The `is_replaying` guard lives entirely on the Rust side. JS never knows about replay state.

## Build & Test

```bash
# Build (MUST use napi build, not cargo build, for the .node binary)
npx napi build --platform              # Debug build
npx napi build --platform --release    # Release build

# Tests
npm test                               # PostgreSQL e2e (24 tests + 1 SQLite smoketest, needs DATABASE_URL in .env)
npm run test:races                     # Race/join composition tests (7 tests, needs DATABASE_URL)
npm run test:admin                     # Admin API tests (14 tests, needs DATABASE_URL)
npm run test:scenarios                 # Scenario tests (6 tests, needs DATABASE_URL)
npm run test:sessions                  # Session tests (6 tests, SQLite in-memory)
npm run test:all                       # Everything (58 tests)

# Lint the Rust side
cargo clippy --all-targets
```

**Important**: After any Rust code change (`src/*.rs`), you MUST run `npx napi build --platform` before running tests. The JS side loads a compiled `.node` binary, not Rust source.

## Interop Model

The orchestration handler loop in `src/handlers.rs`:

1. Rust calls JS `createGenerator(payload)` via `ThreadsafeFunction` (blocked with `block_in_place`)
2. JS creates a generator, calls `gen.next()`, returns the first yielded `ScheduledTask` descriptor
3. Rust executes the task via `OrchestrationContext` (real execution or replay)
4. Rust calls JS `nextStep(result)` — feeds result back to generator
5. Repeat until generator returns or throws

Activities are simpler: Rust calls JS async function via `call_async`, awaits the Promise.

**`block_in_place` is required** because the replay engine's `poll_once()` drops the handler future after one poll. A regular `call_async` future would be dropped before the JS callback fires.

## ScheduledTask Protocol

The JS generator yields plain objects that map to Rust `ScheduledTask` variants:

| JS Descriptor | Rust Variant | Notes |
|--------------|-------------|-------|
| `{ type: 'activity', name, input }` | `Activity` | Runs an activity |
| `{ type: 'activity', name, input, sessionId }` | `Activity` | Runs an activity on a session |
| `{ type: 'activityWithRetry', name, input, retryPolicy }` | `ActivityWithRetry` | With retry policy |
| `{ type: 'timer', delayMs }` | `Timer` | Durable delay |
| `{ type: 'wait', eventName }` | `WaitEvent` | Wait for external event |
| `{ type: 'subOrchestration', name, input }` | `SubOrchestration` | Await child workflow |
| `{ type: 'orchestration', name, instanceId, input }` | `Orchestration` | Fire-and-forget |
| `{ type: 'all', tasks }` | `All` | Parallel execution |
| `{ type: 'race', task1, task2 }` | `Race` | First-to-complete |
| `{ type: 'utcNow' }` | `UtcNow` | Deterministic timestamp |
| `{ type: 'newGuid' }` | `NewGuid` | Deterministic GUID |
| `{ type: 'continueAsNew', input }` | `ContinueAsNew` | Restart orchestration |
| `{ type: 'continueAsNewVersioned', input, version }` | `ContinueAsNewVersioned` | Restart as specific version |

## Key Patterns

**Provider polymorphism** — napi-rs can't use trait objects in constructors, so `JsRuntime` has a factory method:
```javascript
// JS wrapper detects provider._type and calls the right constructor
if (provider._type === 'postgres') {
  this._native = JsRuntime.fromPostgres(provider._native, options);
} else {
  this._native = new JsRuntime(provider._native, options);
}
```

**Global context maps** for cross-thread tracing:
- `ACTIVITY_CTXS: HashMap<String, ActivityContext>` — keyed by atomic token (`act-0`, `act-1`, ...)
- `ORCHESTRATION_CTXS: HashMap<String, OrchestrationContext>` — keyed by `instance_id`
- Contexts are inserted before calling JS, removed after completion

**select/race** uses `make_select_future()` which returns `Pin<Box<dyn Future<Output = String>>>` to handle all task types uniformly.

**join/all** uses `make_join_future()` — similar to `make_select_future()` but normalizes output to `{ok:v}/{err:e}` JSON. Supports all task types: activities, timers, waits, sub-orchestrations (all variants).

**Nested join/select rejection** — `Join` and `Select` handlers reject nested `Join`/`Select` tasks to avoid recursive async issues.

**Activity cancellation** — `ctx.isCancelled()` checks the Rust `CancellationToken` via `ACTIVITY_CTXS` map. Cancellation is detected via lock renewal failure (latency = `workerLockTimeoutMs / 2`).

**Activity client access** — `ctx.getClient()` calls `activityGetClient(token)` napi function → looks up `ActivityContext` in `ACTIVITY_CTXS` map → calls `ctx.get_client()` → wraps result as `JsClient`. Activities can use this to start orchestrations, raise events, etc.

**Metrics snapshot** — `runtime.metricsSnapshot()` returns a `JsMetricsSnapshot` with 17 counters (orch starts/completions/failures, activity results, dispatcher stats, provider errors). Returns `null` if observability is not enabled.

**Observability options** — `JsRuntimeOptions` includes `logFormat`, `logLevel`, `serviceName`, `serviceVersion` which map to `duroxide::ObservabilityConfig`.

## Determinism Rules

Orchestration generators **must be deterministic** (same rules as Rust duroxide):
- ✅ Use: `yield ctx.utcNow()`, `yield ctx.newGuid()`, `ctx.traceInfo()`
- ❌ Avoid: `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `console.log()`, I/O, `fetch()`

Activities have no restrictions — they run once, result is cached.

## Crate Version Alignment

Release manifests must resolve `duroxide` and `duroxide-pg` from crates.io:
```toml
duroxide = { version = "0.1.29", features = ["sqlite"] }
duroxide-pg = "0.1.34"
```

Temporary local `[patch.crates-io]` sections or inline `path =` overrides are
acceptable during cross-repository development, but remove them before release
validation so CI and published packages use registry crates.

## Adding Features

**After adding features**: update `docs/user-guide.md`, relevant skills in `.agents/skills/`, and the ScheduledTask table above.

**New ScheduledTask type:**
1. Add variant to `ScheduledTask` enum in `src/types.rs`
2. Add execution branch in `execute_task()` in `src/handlers.rs`
3. Add JS method to `OrchestrationContext` class in `lib/duroxide.js`
4. Add TypeScript type to `index.d.ts`
5. Add test in `__tests__/e2e.test.js`

**New napi function:**
1. Add `#[napi]` function in `src/lib.rs` (or relevant module)
2. Import in `lib/duroxide.js` from the napi binding
3. Rebuild: `npx napi build --platform`

## Limitations

- `ctx.race()` supports exactly 2 tasks (maps to Rust `select2`)
- `ctx.all()` supports all task types: activities, timers, waits, sub-orchestrations (all variants). Nested `all()`/`race()` is rejected.
- `ctx.race()` supports all task types. Nested `all()`/`race()` is rejected.
- All JS callbacks run on the Node.js main thread (single-threaded)
- No `async function*` generators — breaks replay model
- SQLite may hit "database is locked" under concurrency (retried automatically)
- `Runtime.shutdown(timeoutMs)` waits the full timeout (no short-circuit)
- Platform-specific `.node` binary — cross-platform needs per-platform builds
- Activity cancellation detection latency depends on `workerLockTimeoutMs` (default 30s → ~15s detection)
