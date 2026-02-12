---
name: duroxide-node-orchestrations
description: Writing durable workflows in JavaScript using duroxide-node. Use when creating orchestrations, activities, writing tests, or when the user mentions generator workflows, yield patterns, or duroxide-node development.
---

# Duroxide-Node Orchestration Development

## Core Rule: Yield vs Await

| Context | Syntax | Why |
|---------|--------|-----|
| Orchestrations | `function*` + `yield` | Rust replay engine needs step-by-step control |
| Activities | `async function` + `await` | Run once, result cached — no replay constraints |
| Orchestration tracing | Direct call (no yield) | Fire-and-forget, delegates to Rust |

```javascript
// ✅ Orchestration
runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
  ctx.traceInfo('starting');                                // no yield
  const result = yield ctx.scheduleActivity('Work', input); // yield
  return result;
});

// ✅ Activity
runtime.registerActivity('Work', async (ctx, input) => {
  ctx.traceInfo(`processing ${input}`);                     // no yield
  const data = await fetch(input.url);                      // await is fine
  return data;
});
```

**Never use `async function*` for orchestrations** — async generators break the replay model.

## Orchestration Context API

### Scheduling (MUST yield)

```javascript
function* (ctx, input) {
  // Activity
  const result = yield ctx.scheduleActivity('Name', input);

  // Activity with retry
  const result = yield ctx.scheduleActivityWithRetry('Name', input, {
    maxAttempts: 3,
    backoff: 'exponential',
    timeoutMs: 5000,
    totalTimeoutMs: 30000,
  });

  // Timer (durable delay)
  yield ctx.scheduleTimer(60000); // 1 minute

  // External event
  const eventData = yield ctx.waitForEvent('approval');

  // Sub-orchestration (waits for completion)
  const childResult = yield ctx.scheduleSubOrchestration('Child', childInput);

  // Sub-orchestration with explicit ID
  const childResult = yield ctx.scheduleSubOrchestrationWithId('Child', 'child-1', childInput);

  // Fire-and-forget orchestration (returns immediately)
  yield ctx.startOrchestration('BackgroundWork', 'bg-1', bgInput);

  // Deterministic values
  const now = yield ctx.utcNow();      // timestamp in ms
  const guid = yield ctx.newGuid();    // deterministic UUID

  // Continue as new (restart with fresh history)
  yield ctx.continueAsNew(newInput);
}
```

### Composition (MUST yield)

```javascript
// Fan-out / fan-in — wait for ALL tasks (supports all task types)
const results = yield ctx.all([
  ctx.scheduleActivity('TaskA', inputA),
  ctx.scheduleActivity('TaskB', inputB),
  ctx.scheduleTimer(5000),                    // timers work too
  ctx.waitForEvent('approval'),               // waits work too
]);
// results = [resultA, resultB, { ok: null }, { ok: eventData }]

// Race — wait for FIRST of 2 tasks (supports all task types)
const winner = yield ctx.race(
  ctx.scheduleActivity('FastService', input),
  ctx.scheduleTimer(5000)
);
// winner = { index: 0|1, value: ... }
```

**`ctx.race()` supports exactly 2 tasks** (maps to Rust `select2`). Nesting `all()`/`race()` inside `all()` or `race()` is **not supported** — the runtime rejects it.

### Cooperative Activity Cancellation

```javascript
runtime.registerActivity('LongTask', async (ctx, input) => {
  for (let i = 0; i < 1000; i++) {
    if (ctx.isCancelled()) {
      ctx.traceInfo('cancelled, cleaning up');
      return { status: 'cancelled' };
    }
    await doChunk(i);
  }
  return { status: 'done' };
});
```

`ctx.isCancelled()` checks whether the orchestration no longer needs the activity result (e.g., lost a race). Detection latency is `workerLockTimeoutMs / 2` (default 30s → ~15s).

### Tracing (NO yield — fire-and-forget)

```javascript
ctx.traceInfo('message');   // suppressed during replay automatically
ctx.traceWarn('message');
ctx.traceError('message');
ctx.traceDebug('message');
```

Tracing delegates to the Rust `OrchestrationContext` which has the `is_replaying` guard. **Do not use `console.log()`** in orchestrations — it will duplicate on replay.

## Activity Context API

```javascript
runtime.registerActivity('MyActivity', async (ctx, input) => {
  // Available fields
  ctx.instanceId;
  ctx.executionId;
  ctx.orchestrationName;
  ctx.orchestrationVersion;
  ctx.activityName;
  ctx.workerId;

  // Cooperative cancellation (check if orchestration no longer needs this result)
  if (ctx.isCancelled()) {
    ctx.traceInfo('cancelled');
    return { status: 'cancelled' };
  }

  // Tracing (delegates to Rust ActivityContext — full structured fields)
  ctx.traceInfo(`processing ${input.id}`);
  ctx.traceWarn('slow response');
  ctx.traceError('connection failed');
  ctx.traceDebug('raw payload: ...');

  // Activities can do anything — I/O, HTTP, DB, etc.
  const data = await fetch(input.url);
  return data;
});
```

## Determinism Rules

Orchestrations **must be deterministic** — the replay engine re-executes from the beginning on every dispatch:

| ✅ Safe | ❌ Breaks Replay |
|---------|-----------------|
| `yield ctx.utcNow()` | `Date.now()` |
| `yield ctx.newGuid()` | `crypto.randomUUID()` |
| `ctx.traceInfo()` | `console.log()` (duplicates) |
| `yield ctx.scheduleTimer(ms)` | `setTimeout()` / `await sleep()` |
| Pure computation, conditionals | `fetch()`, file I/O, DB queries |
| `JSON.parse()`, `JSON.stringify()` | `process.env.X` (may change) |

**All I/O belongs in activities**, not orchestrations.

## Common Patterns

### Error Handling

```javascript
function* (ctx, input) {
  try {
    const result = yield ctx.scheduleActivity('RiskyOp', input);
    return result;
  } catch (error) {
    ctx.traceError(`failed: ${error.message}`);
    yield ctx.scheduleActivity('Cleanup', { error: error.message });
    return { status: 'failed' };
  }
}
```

### Eternal Orchestration (continue-as-new)

```javascript
function* (ctx, input) {
  const state = input.state || { iteration: 0 };

  // Do periodic work
  const health = yield ctx.scheduleActivity('CheckHealth', input.target);
  ctx.traceInfo(`check #${state.iteration}: ${health.status}`);

  // Wait
  yield ctx.scheduleTimer(30000);

  // Restart with updated state (prevents unbounded history)
  yield ctx.continueAsNew({
    target: input.target,
    state: { iteration: state.iteration + 1 },
  });
}
```

### Race with Timeout

```javascript
function* (ctx, input) {
  const winner = yield ctx.race(
    ctx.scheduleActivity('SlowOperation', input),
    ctx.scheduleTimer(10000)
  );

  if (winner.index === 1) {
    ctx.traceWarn('operation timed out');
    return { status: 'timeout' };
  }
  return { status: 'ok', result: winner.value };
}
```

### Fire-and-Forget + Cleanup on Failure

```javascript
function* (ctx, input) {
  try {
    yield ctx.scheduleActivity('ProvisionResource', input);
    yield ctx.scheduleActivity('ConfigureResource', input);

    // Launch background monitor (runs independently)
    yield ctx.startOrchestration('ResourceMonitor', `monitor-${input.id}`, {
      resourceId: input.id,
    });

    return { status: 'created' };
  } catch (error) {
    ctx.traceError(`provisioning failed: ${error.message}`);
    yield ctx.scheduleActivity('DeleteResource', { id: input.id });
    throw error;
  }
}
```

### Polling Loop (Activity-Level)

```javascript
runtime.registerActivity('WaitForReady', async (ctx, input) => {
  for (let i = 0; i < input.maxAttempts; i++) {
    ctx.traceInfo(`poll attempt ${i + 1}`);
    const status = await checkStatus(input.resourceId);
    if (status === 'ready') return { ready: true };
    await new Promise(r => setTimeout(r, input.intervalMs));
  }
  throw new Error(`not ready after ${input.maxAttempts} attempts`);
});
```

### Versioned Orchestrations

```javascript
// Register multiple versions — old for running instances, new for future
runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
  // v1.0.0
  ctx.traceInfo('[v1.0.0] starting');
  return yield ctx.scheduleActivity('Work', input);
});

runtime.registerOrchestrationVersioned('MyWorkflow', '1.0.1', function* (ctx, input) {
  // v1.0.1 — added validation step
  ctx.traceInfo('[v1.0.1] starting');
  yield ctx.scheduleActivity('Validate', input);
  return yield ctx.scheduleActivity('Work', input);
});
```

## Writing Tests

Tests use Node.js built-in test runner (`node:test`):

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SqliteProvider, Client, Runtime } = require('../lib/duroxide');

describe('My Feature', () => {
  it('should do something', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider);

    runtime.registerActivity('MyActivity', async (ctx, input) => {
      return `result-${input}`;
    });

    runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
      return yield ctx.scheduleActivity('MyActivity', input);
    });

    await runtime.start();

    await client.startOrchestration('test-1', 'MyWorkflow', 'hello');
    const result = await client.waitForOrchestration('test-1');

    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'result-hello');

    await runtime.shutdown(100);
  });
});
```

### Test Commands

```bash
npm test                    # PostgreSQL e2e (24 tests + 1 SQLite smoketest)
npm run test:races          # Race/join composition tests (7 tests)
npm run test:admin          # Admin API tests (14 tests)
npm run test:scenarios      # Scenario tests (6 tests)
npm run test:all            # Everything (52 tests)
```

### Test Tips

- Use `SqliteProvider.inMemory()` for fast isolated tests (SQLite smoketest only)
- All PG tests need `DATABASE_URL` in `.env` (loaded by `dotenv`)
- Each test file uses a separate PG schema for isolation
- Use short `runtime.shutdown(100)` timeout — it waits the full duration
- Set `RUST_LOG=info` to see traces in test output
- Use `workerLockTimeoutMs: 2000` in tests needing fast activity cancellation detection

## Client API

```javascript
const client = new Client(provider);

// Start orchestration
await client.startOrchestration('instance-1', 'WorkflowName', inputData);
await client.startOrchestrationVersioned('instance-1', 'WorkflowName', inputData, '1.0.1');

// Wait for completion
const result = await client.waitForOrchestration('instance-1', 30000);
// result.status: 'Completed' | 'Failed' | 'Running' | ...
// result.output: parsed JSON output

// Raise event (for waitForEvent)
await client.raiseEvent('instance-1', 'approval', { approved: true });

// Cancel
await client.cancelInstance('instance-1', 'no longer needed');

// Metrics
const metrics = await client.getSystemMetrics();
const depths = await client.getQueueDepths();
```

## Logging Control

```bash
RUST_LOG=info node app.js                           # All INFO
RUST_LOG=duroxide::orchestration=debug node app.js   # Orchestration DEBUG
RUST_LOG=duroxide::activity=info node app.js         # Activity INFO only
```

Traces include structured fields automatically:
- **Orchestration**: `instance_id`, `execution_id`, `orchestration_name`, `orchestration_version`
- **Activity**: above + `activity_name`, `activity_id`, `worker_id`
