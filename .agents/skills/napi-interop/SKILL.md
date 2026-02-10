---
name: napi-interop
description: Rust↔JS interop architecture in duroxide-node. Use when modifying the napi bridge, adding ScheduledTask types, fixing cross-thread issues, changing tracing delegation, or debugging block_in_place / ThreadsafeFunction behavior.
---

# napi-rs Interop Architecture

## Overview

duroxide-node bridges Rust's duroxide runtime to Node.js via napi-rs. The interop has two distinct paths — orchestrations (generator-based, synchronous blocking) and activities (async Promise-based). Getting this wrong causes silent replay corruption, deadlocks, or dropped futures.

## File Map

| File | Role |
|------|------|
| `src/handlers.rs` | Core interop — orchestration handler loop, activity invocation, global context maps, select/race |
| `src/types.rs` | `ScheduledTask` enum — the protocol between JS and Rust |
| `src/lib.rs` | napi entry point, `#[napi]` trace functions |
| `src/runtime.rs` | `JsRuntime` — wraps `duroxide::Runtime`, registers handlers |
| `src/client.rs` | `JsClient` — wraps `duroxide::Client` |
| `src/provider.rs` | `JsSqliteProvider` |
| `src/pg_provider.rs` | `JsPostgresProvider` |
| `lib/duroxide.js` | JS generator driver, `OrchestrationContext`, `ActivityContext` |

## Orchestration Interop (Blocking Generator Loop)

The replay engine calls `poll_once()` on the handler future. If the future isn't ready in one poll, it's **dropped**. This means `call_async` (which returns a future awaiting a JS callback) would be dropped before the callback fires.

**Solution: `block_in_place` + `block_on`**

```rust
fn call_create_blocking(&self, payload: String) -> Result<GeneratorStepResult, String> {
    let create_fn = self.create_fn.clone();
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            create_fn.call_async::<String>(payload).await
        })
    })?;
}
```

This blocks the tokio thread synchronously while waiting for the JS callback to complete on the Node event loop thread. `block_in_place` tells tokio the thread is doing blocking work.

### Orchestration Handler Sequence

```
Rust (tokio thread)                         JS (Node event loop)
───────────────────                         ────────────────────
1. invoke(ctx, input)
   ├─ Store ctx in ORCHESTRATION_CTXS[instance_id]
   ├─ call_create_blocking(payload) ──────► createGenerator(payload)
   │                                         ├─ Create OrchestrationContext
   │                                         ├─ Create generator: fn(ctx, input)
   │                                         ├─ gen.next() → first yield
   │                                         └─ Return { status: 'yielded', task }
   │◄────────────────────────────────────────┘
   ├─ Loop:
   │   ├─ execute_task(ctx, task)           // Real DurableFuture or replay
   │   ├─ call_next_blocking(result) ──────► nextStep(result)
   │   │                                     ├─ gen.next(value) or gen.throw(err)
   │   │                                     └─ Return next task or completion
   │   │◄────────────────────────────────────┘
   │   └─ If completed/error: break
   └─ Remove ctx from ORCHESTRATION_CTXS
```

### Key Rules for Orchestration Interop

1. **Always use `call_*_blocking` methods** for JS calls from the orchestration handler — never `call_async().await`
2. **Store ctx in `ORCHESTRATION_CTXS` before calling JS** — JS tracing needs it immediately
3. **Remove ctx from `ORCHESTRATION_CTXS` on ALL exit paths** (success, error, and early return)
4. **Call `dispose_fn` on completion** to clean up the JS generator

## Activity Interop (Async Promise)

Activities are simpler — they use normal `call_async` with a two-phase await:

```rust
let result: String = self.callback
    .call_async::<napi::bindgen_prelude::Promise<String>>(payload)
    .await  // Phase 1: get the Promise object
    .await  // Phase 2: resolve the Promise
```

Activities are NOT dropped by `poll_once()` — they run to completion on the worker dispatcher.

### Activity Handler Sequence

```
Rust                                        JS
────                                        ──
invoke(ctx, input)
  ├─ Generate unique token (act-0, act-1, ...)
  ├─ Store ctx in ACTIVITY_CTXS[token]
  ├─ call_async(payload).await.await ──────► wrappedFn(payload)
  │                                          ├─ Parse ctx, create ActivityContext
  │                                          ├─ Call user's async function
  │                                          └─ Return JSON result
  │◄─────────────────────────────────────────┘
  └─ Remove token from ACTIVITY_CTXS
```

## Cross-Thread Tracing

JS callbacks run on the Node event loop thread. Rust contexts live on tokio threads. Thread-locals don't cross this boundary.

**Solution: Global `HashMap`s protected by `Mutex`**

```rust
// Activity contexts — keyed by atomic token (unique per invocation)
static ACTIVITY_CTXS: LazyLock<Mutex<HashMap<String, ActivityContext>>>

// Orchestration contexts — keyed by instance_id
static ORCHESTRATION_CTXS: LazyLock<Mutex<HashMap<String, OrchestrationContext>>>
```

**JS calls napi functions that look up the Rust context:**

```javascript
// In OrchestrationContext (fire-and-forget, no yield)
traceInfo(message) {
    orchestrationTraceLog(this.instanceId, 'info', String(message));
}

// In ActivityContext (fire-and-forget)
traceInfo(message) {
    activityTraceLog(this._traceToken, 'info', String(message));
}
```

**Rust napi functions delegate to the stored context:**

```rust
#[napi]
pub fn orchestration_trace_log(instance_id: String, level: String, message: String) {
    handlers::orchestration_trace(&instance_id, &level, &message);
    // → ORCHESTRATION_CTXS.get(instance_id).trace(level, message)
    //   which internally checks is_replaying
}
```

### Rules for Tracing

1. **Never expose `is_replaying` to JS** — the Rust `OrchestrationContext.trace()` handles suppression
2. **Always use global maps, not thread-locals** — JS runs on a different thread
3. **Clean up map entries on ALL exit paths** — leaked entries cause stale traces
4. **Use atomic tokens for activities** (not instance_id) — multiple activities for the same instance can run concurrently

## ScheduledTask Protocol

JS yields plain objects. Rust deserializes them via `serde_json` into `ScheduledTask` enum variants:

```rust
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScheduledTask {
    Activity { name: String, input: String },
    ActivityWithRetry { name: String, input: String, retry: RetryPolicyConfig },
    Timer { delay_ms: u64 },
    #[serde(rename_all = "camelCase")]
    WaitEvent { name: String },
    SubOrchestration { name: String, input: String },
    SubOrchestrationWithId { name: String, instance_id: String, input: String },
    Orchestration { name: String, instance_id: String, input: String },
    NewGuid,
    UtcNow,
    ContinueAsNew { input: String },
    Join { tasks: Vec<ScheduledTask> },
    Select { tasks: Vec<ScheduledTask> },
}
```

### Adding a New ScheduledTask Type

1. Add variant to `ScheduledTask` in `src/types.rs` with correct `serde` attributes
2. Add execution branch in `execute_task()` in `src/handlers.rs`
3. If it should work in `select/race`, add branch in `make_select_future()`
4. If it should work in `join/all`, add branch in the `Join` match arm
5. Add JS method to `OrchestrationContext` in `lib/duroxide.js` returning `{ type: '...', ... }`
6. Add TypeScript type to `index.d.ts`
7. Add test in `__tests__/e2e.test.js`
8. Rebuild: `npx napi build --platform`

## Provider Polymorphism

napi-rs doesn't support trait objects in constructors. `JsRuntime` uses factory methods:

```rust
// In runtime.rs
#[napi]
impl JsRuntime {
    #[napi(constructor)]
    pub fn new(provider: &JsSqliteProvider, ...) -> Self { ... }  // SQLite

    #[napi(factory)]
    pub fn from_postgres(provider: &JsPostgresProvider, ...) -> Self { ... }  // PG
}
```

JS wrapper detects provider type:
```javascript
if (provider._type === 'postgres') {
    this._native = JsRuntime.fromPostgres(provider._native, options);
} else {
    this._native = new JsRuntime(provider._native, options);
}
```

When adding a new provider, follow this same pattern — constructor for default, factory for others.

## select/race Implementation

`select` maps to Rust's `ctx.select2()`, which requires exactly 2 futures. `make_select_future()` converts a `ScheduledTask` to `Pin<Box<dyn Future<Output = String> + Send + '_>>`:

```rust
fn make_select_future(ctx: &OrchestrationContext, task: ScheduledTask)
    -> Pin<Box<dyn Future<Output = String> + Send + '_>>
```

Supported in select: `Activity`, `Timer`, `WaitEvent`, `SubOrchestration`.
Unsupported: `Join`, `Select` (nested), `ContinueAsNew`, `NewGuid`, `UtcNow`.

## Common Pitfalls

| Pitfall | What Happens | Fix |
|---------|-------------|-----|
| Using `call_async().await` in orchestration handler | Future dropped by `poll_once()` — JS callback never executes | Use `block_in_place` + `block_on` |
| Thread-local for cross-thread context | Lookup returns `None` — traces silently fail | Use global `HashMap` |
| Exposing `is_replaying` to JS as static field | Stale after replay→live transition mid-execution | Let Rust handle it via `ctx.trace()` |
| Forgetting to clean up global map entries | Memory leak + stale context references | Clean up on ALL exit paths (Ok, Err, early return) |
| `cargo build` instead of `npx napi build --platform` | JS loads stale `.node` binary — changes don't take effect | Always use napi build |
| Missing `serde(rename_all)` on new ScheduledTask variants | Deserialization fails silently — task type not recognized | Match JS naming convention (camelCase) |

## Build Requirements

```bash
# MUST use napi build (not cargo build) for the .node binary
npx napi build --platform           # Debug
npx napi build --platform --release # Release

# Cargo build alone only produces a .dylib/.so — JS can't load it
```
