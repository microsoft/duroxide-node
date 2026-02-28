# Architecture

duroxide-node is a Node.js wrapper around the Rust [duroxide](https://github.com/afdaraern/duroxide) durable execution runtime, built with [napi-rs](https://napi.rs). This document explains how the interop works, key design decisions, and current limitations.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Node.js Process                       │
│                                                         │
│  ┌─────────────────────┐    ┌────────────────────────┐  │
│  │    User Code (JS)   │    │  Generator Driver (JS) │  │
│  │                     │    │                        │  │
│  │  function*(ctx) {   │    │  generators Map        │  │
│  │    yield ctx.sched  │◄──►│  createGenerator()     │  │
│  │    ...              │    │  nextStep()            │  │
│  │  }                  │    │  disposeGenerator()    │  │
│  └─────────────────────┘    └───────────┬────────────┘  │
│                                         │ ThreadsafeFunction │
│  ┌──────────────────────────────────────┼────────────┐  │
│  │              Rust (napi-rs)          │            │  │
│  │                                     ▼            │  │
│  │  ┌──────────────┐    ┌──────────────────────┐    │  │
│  │  │  JsRuntime   │    │ JsOrchestrationHandler│   │  │
│  │  │  JsClient    │    │  execute_task()       │   │  │
│  │  │  Providers   │    │  call_create_blocking()│  │  │
│  │  └──────┬───────┘    │  call_next_blocking() │   │  │
│  │         │            └──────────┬───────────┘    │  │
│  │         │                       │                │  │
│  │         ▼                       ▼                │  │
│  │  ┌──────────────────────────────────────────┐    │  │
│  │  │         duroxide (Rust crate)            │    │  │
│  │  │                                          │    │  │
│  │  │  Runtime, ReplayEngine, Client           │    │  │
│  │  │  OrchestrationContext, ActivityContext    │    │  │
│  │  │  DurableFuture, Provider trait           │    │  │
│  │  └──────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Storage (SQLite / PostgreSQL)       │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Yield vs Await

This is the most important design decision in duroxide-node and the most common source of confusion.

### The Rule

- **Orchestrations** use `function*` (generators) and `yield`
- **Activities** use `async function` and `await`

```javascript
// Orchestration: generator, yield for durable operations
runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
  const a = yield ctx.scheduleActivity('Step1', input);
  const b = yield ctx.scheduleActivity('Step2', a);
  return b;
});

// Activity: async function, await for I/O
runtime.registerActivity('Step1', async (ctx, input) => {
  const response = await fetch(`https://api.example.com/${input}`);
  return await response.json();
});
```

### Why Not async/await for Orchestrations?

Durable orchestrations require **deterministic replay**. When a process restarts, the runtime replays the orchestration's history — re-executing the generator function from the beginning, feeding back previously recorded results. This means the runtime must control exactly when each step executes and what value it returns.

**Generators give Rust full control:**

```
Generator: yield descriptor ──► Rust: execute DurableFuture ──► Generator: receive result
                                     │
                                     ├─ First run: actually execute
                                     └─ Replay: return cached result
```

The generator yields a plain descriptor object (e.g., `{ type: 'activity', name: 'Greet', input: '...' }`). Rust decides whether to execute it for real or return a cached result from history. The generator doesn't know the difference.

**async/await would break this** because:

1. `await` suspends the JS function and creates a Promise. The runtime cannot intercept what happens between `await` calls — JS controls the scheduling.
2. The Rust replay engine uses `poll_once()` on its `DurableFuture` type. These are not JS Promises — they're Rust futures driven by the replay engine's event loop. There's no way to bridge `await` in JS to `poll_once()` in Rust without generators as the intermediary.
3. If you `await` a durable operation, the JS event loop takes over scheduling. During replay, the runtime needs to feed cached results back synchronously within a single `poll_once()` cycle. `await` would yield control back to the event loop, breaking the replay engine's assumptions.

**Temporal (another durable execution framework) faces the same problem** with TypeScript. Their solution is to run orchestration code in a V8 isolate with patched globals that intercept Promise resolution. duroxide-node takes the simpler approach: use generators, which are natively designed for cooperative, step-by-step execution.

### Why async/await Is Fine for Activities

Activities are **not replayed**. They run once, their result is persisted, and on replay the cached result is used. An activity is just a regular async function — it can make HTTP calls, query databases, write files. The runtime doesn't need to control its internal execution, only its input and output.

### The Tracing Exception

Orchestration context tracing methods (`ctx.traceInfo()`, etc.) are fire-and-forget — they do **not** require `yield`:

```javascript
function* (ctx, input) {
  ctx.traceInfo('starting workflow');          // no yield — fire-and-forget
  const result = yield ctx.scheduleActivity('Work', input);  // yield — durable
  ctx.traceInfo(`done: ${result}`);           // no yield
  return result;
}
```

Tracing works by looking up the Rust `OrchestrationContext` from a global map (keyed by instance ID) and calling `ctx.trace()` synchronously. The Rust side handles the `is_replaying` guard — traces are suppressed during replay automatically.

## Orchestration Handler Loop

The core of the interop is in `src/handlers.rs`. Here's the sequence for a single orchestration execution:

```
                    Rust (tokio thread)                    JS (Node event loop)
                    ──────────────────                    ────────────────────
1. invoke(ctx, input)
   │
   ├─ Store ctx in ORCHESTRATION_CTXS map
   │
   ├─ call_create_blocking(payload) ──────────────────► createGenerator(payload)
   │   (block_in_place + block_on)                       │
   │                                                     ├─ Create OrchestrationContext
   │                                                     ├─ Create generator: fn(ctx, input)
   │                                                     ├─ gen.next() → first yield
   │                                                     └─ Return { status: 'yielded', task }
   │◄────────────────────────────────────────────────────┘
   │
   ├─ Loop:
   │   │
   │   ├─ execute_task(ctx, task)
   │   │   └─ ctx.schedule_activity / timer / wait / etc
   │   │      (DurableFuture — replayed or executed)
   │   │
   │   ├─ call_next_blocking(result) ─────────────────► nextStep(result)
   │   │                                                 │
   │   │                                                 ├─ gen.next(value) or gen.throw(err)
   │   │                                                 └─ Return next yielded task or completion
   │   │◄───────────────────────────────────────────────┘
   │   │
   │   └─ If completed/error: dispose generator, return
   │
   └─ Remove ctx from ORCHESTRATION_CTXS map
```

### The block_in_place Fix

The replay engine's `poll_once()` drops the handler future after a single poll. If we used `call_async` (which sends a callback to the Node event loop and returns a future), the future would be dropped before the callback fires.

Solution: `tokio::task::block_in_place()` + `Handle::block_on()`. This blocks the current tokio thread to synchronously wait for the JS callback to complete. It works because:
- napi-rs `ThreadsafeFunction` schedules the callback on the Node event loop
- `block_on` waits for the callback to resolve
- `block_in_place` tells tokio this thread is doing blocking work, so it can schedule other tasks elsewhere

### Activity Handler

Activities are simpler — they're async functions, not generators:

```
Rust                                          JS
────                                          ──
invoke(ctx, input)
  │
  ├─ Store ctx in ACTIVITY_CTXS map (token-keyed)
  ├─ Serialize ctx + input as payload
  │
  ├─ call_async::<Promise<String>>(payload) ──────► wrappedFn(payload)
  │   .await (Phase 1: get Promise)                  │
  │   .await (Phase 2: resolve Promise)              ├─ Parse ctx, create ActivityContext
  │                                                  ├─ Call user's async function
  │                                                  │   (can use ctx.traceInfo() etc)
  │                                                  └─ Return JSON result
  │◄─────────────────────────────────────────────────┘
  │
  └─ Remove token from ACTIVITY_CTXS map
```

Activities use a two-phase await because JS activity functions are async — `call_async` first returns the Promise object, then we await the Promise's resolution.

## Tracing Architecture

Both orchestration and activity tracing delegate to the Rust context objects, which use `tracing::info!` etc. with structured fields.

### Orchestration Tracing

```
JS: ctx.traceInfo("message")
  │
  └─► orchestrationTraceLog(instanceId, "info", "message")  [napi function]
        │
        └─► ORCHESTRATION_CTXS.get(instanceId).trace("INFO", "message")
              │
              ├─ if is_replaying → suppressed (no output)
              └─ if live → tracing::info!(target: "duroxide::orchestration",
                              instance_id, execution_id, orchestration_name, ...)
```

The `is_replaying` guard is on the Rust side — it tracks the replay→live transition correctly even mid-execution. JS never needs to know about replay state.

### Activity Tracing

```
JS: ctx.traceInfo("message")
  │
  └─► activityTraceLog(token, "info", "message")  [napi function]
        │
        └─► ACTIVITY_CTXS.get(token).trace_info("message")
              │
              └─► tracing::info!(target: "duroxide::activity",
                      instance_id, activity_name, activity_id, worker_id, ...)
```

Activities use a token-keyed global map (not thread-local) because the Rust handler runs on a tokio thread while JS runs on the Node event loop thread.

## Provider Polymorphism

napi-rs doesn't support trait objects in constructors, so we use factory methods:

```rust
// SQLite (constructor)
let runtime = new JsRuntime(sqliteProvider, options);

// PostgreSQL (factory)
let runtime = JsRuntime.fromPostgres(pgProvider, options);
```

The JS wrapper class detects the provider type via a `_type` field and calls the right factory:

```javascript
class Runtime {
  constructor(provider, options) {
    if (provider._type === 'postgres') {
      this._native = JsRuntime.fromPostgres(provider._native, options);
    } else {
      this._native = new JsRuntime(provider._native, options);
    }
  }
}
```

Internally, `JsRuntime` stores `Arc<dyn Provider>` so all provider operations are polymorphic.

## Crate Version Alignment

duroxide-node depends on both `duroxide` (local path) and `duroxide-pg` (which depends on duroxide from crates.io). To avoid "two versions of crate `duroxide`" errors:

```toml
[patch.crates-io]
duroxide = { path = "../duroxide" }
```

This forces all transitive dependencies to use the local duroxide.

## Custom Status Data Path

Custom status is a fire-and-forget mechanism — orchestrations set progress strings that external clients can poll. No `yield` is needed because the status write is handled synchronously via the global `ORCHESTRATION_CTXS` map, similar to tracing.

```
Orchestration: ctx.setCustomStatus(str)
  │
  └─► orchestrationSetCustomStatus(instanceId, str)  [napi function]
        │
        └─► ORCHESTRATION_CTXS.get(instanceId).set_custom_status(str)
              │
              └─► Writes to provider (customStatusVersion increments monotonically)

Client: client.waitForStatusChange(id, lastVer, pollMs, timeoutMs)
  │
  └─► JsClient.waitForStatusChange(id, lastVer, pollMs, timeoutMs)  [napi async]
        │
        └─► Polls provider until customStatusVersion > lastVer
              │
              ├─ Changed → return { customStatus, customStatusVersion }
              └─ Timeout → return null
```

`ctx.resetCustomStatus()` sets the status back to null (also fire-and-forget, also increments the version).

## Event Queue Flow

Event queues provide persistent FIFO message passing between clients and orchestrations. Unlike `waitForEvent` (which is a one-shot signal), event queues are durable mailboxes that survive `continueAsNew`.

```
Client: client.enqueueEvent(instanceId, queueName, data)
  │
  └─► JsClient.enqueueEvent(id, queue, data)  [napi async]
        │
        └─► Provider: insert into event queue table (FIFO order preserved)

Orchestration: yield ctx.dequeueEvent(queueName)
  │
  └─► Generator yields { type: 'dequeueEvent', queueName }
        │
        └─► Rust execute_task() → ctx.dequeue_event(queueName)
              │
              ├─ Message available → returns data immediately
              └─ No message → DurableFuture blocks until enqueued
                    │
                    └─ On replay: returns cached result
```

Key properties:
- **FIFO ordering** — messages are delivered in the order they were enqueued
- **Survives continue-as-new** — queue state persists across orchestration restarts
- **Blocks until available** — `dequeueEvent` suspends the orchestration until a message arrives
- **One consumer** — each message is delivered to exactly one `dequeueEvent` call

## Limitations

### No Parallel Orchestration Steps Without yield

Each orchestration step is sequential. To run tasks in parallel, you must use `ctx.all()` or `ctx.race()`:

```javascript
// ❌ This runs sequentially (each yield blocks)
const a = yield ctx.scheduleActivity('A', input);
const b = yield ctx.scheduleActivity('B', input);

// ✅ This runs in parallel
const [a, b] = yield ctx.all([
  ctx.scheduleActivity('A', input),
  ctx.scheduleActivity('B', input),
]);
```

### Generator Functions Cannot Be async

Orchestration functions must be `function*`, not `async function*`. JavaScript async generators use `for await...of` and Promises internally, which conflicts with the replay engine's synchronous step-by-step execution model.

### No Direct Access to Rust OrchestrationContext

The JS `OrchestrationContext` is a plain JS object with scheduling methods that return descriptors. It does not hold a reference to the Rust `OrchestrationContext`. All interaction goes through the yield/execute loop or global maps (for tracing).

### Single Node.js Thread

All JS callbacks (generator steps, activity functions) run on the Node.js main thread. The Rust runtime is multi-threaded (tokio), but JS execution is single-threaded. This means:
- Activity functions run one at a time on the JS side (even though Rust dispatches them concurrently)
- Generator steps are synchronous blocking calls from Rust's perspective
- Heavy computation in activities will block other JS callbacks

### Multi-Step Parallel Blocks Require Sub-Orchestrations

In the Rust core SDK, arbitrary `async {}` blocks can be composed with `join()`/`select2()`/`select3()`. In the Node.js SDK, orchestrations are generator functions — `all()` and `race()` only accept **single task descriptors** (activity, sub-orchestration, timer, or event). Multi-step blocks (sequential activities with control flow) cannot be directly passed to `all()`/`race()`.

**Workaround**: Wrap each multi-step block as a sub-orchestration, then use `all()`/`race()` on the sub-orchestration descriptors.

```javascript
// ❌ Cannot race multi-step blocks directly
// (each yield is a single step — no block composition)

// ✅ Wrap blocks as sub-orchestrations
runtime.registerOrchestration('FastBlock', function* (ctx, input) {
  const a = yield ctx.scheduleActivity('Fast', '1');
  const b = yield ctx.scheduleActivity('Fast', '2');
  return `[${a},${b}]`;
});

runtime.registerOrchestration('SlowBlock', function* (ctx, input) {
  yield ctx.scheduleTimer(60000);
  const a = yield ctx.scheduleActivity('Slow', '1');
  return `[${a}]`;
});

runtime.registerOrchestration('Parent', function* (ctx, input) {
  // Race two multi-step blocks via sub-orchestrations
  const winner = yield ctx.race(
    ctx.scheduleSubOrchestration('FastBlock', ''),
    ctx.scheduleSubOrchestration('SlowBlock', ''),
  );
  return `winner:${winner.index}`;
});
```

This is the **only fundamental limitation** vs the Rust core — all other features (typed APIs, cancellation propagation, etc.) have full parity. See the `async_blocks.test.js` tests for 12 comprehensive examples of this pattern.

### select/race Supports 2 Tasks

`ctx.race()` currently supports exactly 2 tasks (maps to `select2` in Rust). More tasks require nesting or a future `selectN` implementation.

### SQLite Lock Contention

File-based SQLite can hit "database is locked" errors under concurrent orchestration load. The runtime retries automatically, but high-throughput scenarios should use PostgreSQL.

### Runtime Shutdown

`Runtime.shutdown(timeoutMs)` waits for the full timeout duration unconditionally (the Rust runtime doesn't short-circuit when dispatchers drain). Use a small timeout (e.g., 100ms) in tests.

### Platform-Specific Binary

napi-rs compiles to a platform-specific `.node` binary (e.g., `duroxide.darwin-arm64.node`). Cross-platform distribution requires building on each target platform or using napi-rs's pre-built binary publishing flow.
