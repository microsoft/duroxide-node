# User Guide

This guide covers how to build workflows with duroxide-node. For architecture details and internals, see [architecture.md](architecture.md).

## Installation

```bash
npm install duroxide
```

## Core Concepts

| Concept | What It Is |
|---------|-----------|
| **Orchestration** | A durable workflow (generator function). Survives restarts via replay. |
| **Activity** | An async function for side effects (HTTP calls, DB writes). Runs once, result is cached. |
| **Provider** | Storage backend (SQLite or PostgreSQL). Stores orchestration state. |
| **Client** | Starts orchestrations, raises events, queries status. |
| **Runtime** | Runs the dispatchers that execute orchestrations and activities. |

## Minimal Example

```javascript
const { SqliteProvider, Client, Runtime } = require('duroxide');

async function main() {
  const provider = await SqliteProvider.inMemory();
  const client = new Client(provider);
  const runtime = new Runtime(provider);

  runtime.registerActivity('SayHello', async (ctx, name) => {
    return `Hello, ${name}!`;
  });

  runtime.registerOrchestration('HelloWorkflow', function* (ctx, input) {
    const greeting = yield ctx.scheduleActivity('SayHello', input.name);
    return greeting;
  });

  await runtime.start();

  await client.startOrchestration('hello-1', 'HelloWorkflow', { name: 'World' });
  const result = await client.waitForOrchestration('hello-1');
  console.log(result.output); // "Hello, World!"

  await runtime.shutdown();
}

main();
```

## Orchestration Patterns

### Sequential Steps

```javascript
runtime.registerOrchestration('Pipeline', function* (ctx, input) {
  const step1 = yield ctx.scheduleActivity('Extract', input);
  const step2 = yield ctx.scheduleActivity('Transform', step1);
  const step3 = yield ctx.scheduleActivity('Load', step2);
  return step3;
});
```

### Fan-Out / Fan-In

Run multiple tasks in parallel and wait for all to complete. `ctx.all()` supports all task types — activities, timers, waits, and sub-orchestrations:

```javascript
runtime.registerOrchestration('FanOut', function* (ctx, input) {
  const tasks = input.items.map(item =>
    ctx.scheduleActivity('ProcessItem', item)
  );
  const results = yield ctx.all(tasks);
  return results;
});
```

Mixed task types in `ctx.all()`:

```javascript
runtime.registerOrchestration('MixedAll', function* (ctx, input) {
  const [actResult, _, eventData] = yield ctx.all([
    ctx.scheduleActivity('Work', input),
    ctx.scheduleTimer(1000),           // timers return { ok: null }
    ctx.waitForEvent('approval'),      // waits return { ok: eventData }
  ]);
  return actResult;
});
```

> **Note:** Nesting `ctx.all()` or `ctx.race()` inside each other is not supported — the runtime will reject it.

### Race / Select

Wait for the first of two tasks to complete. `ctx.race()` supports all task types:

```javascript
runtime.registerOrchestration('RaceExample', function* (ctx, input) {
  const winner = yield ctx.race(
    ctx.scheduleActivity('FastService', input),
    ctx.scheduleTimer(5000)  // 5 second timeout
  );

  if (winner.index === 0) {
    return winner.value;  // FastService completed first
  } else {
    return 'timed out';
  }
});
```

`ctx.race()` supports exactly 2 tasks (maps to Rust `select2`). Nesting `ctx.all()` or `ctx.race()` inside each other is not supported.

### Durable Timers

```javascript
runtime.registerOrchestration('DelayedNotification', function* (ctx, input) {
  yield ctx.scheduleTimer(60 * 60 * 1000); // wait 1 hour (survives restarts)
  yield ctx.scheduleActivity('SendReminder', input);
  return 'done';
});
```

### External Events

Wait for a signal from outside the orchestration:

```javascript
runtime.registerOrchestration('ApprovalWorkflow', function* (ctx, input) {
  yield ctx.scheduleActivity('RequestApproval', input);
  ctx.traceInfo('waiting for approval...');

  const approval = yield ctx.waitForEvent('approval');

  if (approval.approved) {
    yield ctx.scheduleActivity('Execute', input);
    return 'approved';
  } else {
    return 'rejected';
  }
});

// Raise the event from outside:
await client.raiseEvent('instance-1', 'approval', { approved: true });
```

### Sub-Orchestrations

Compose workflows from smaller workflows:

```javascript
runtime.registerOrchestration('Parent', function* (ctx, input) {
  const childResult = yield ctx.scheduleSubOrchestration('Child', input);
  return { parentResult: childResult };
});

runtime.registerOrchestration('Child', function* (ctx, input) {
  const r = yield ctx.scheduleActivity('DoWork', input);
  return r;
});
```

With an explicit instance ID:

```javascript
const result = yield ctx.scheduleSubOrchestrationWithId(
  'Child',
  `child-${input.id}`,
  input
);
```

### Fire-and-Forget Orchestrations

Start another orchestration without waiting for it to complete:

```javascript
runtime.registerOrchestration('CreateInstance', function* (ctx, input) {
  yield ctx.scheduleActivity('ProvisionVM', input);

  // Launch monitor — runs independently
  yield ctx.startOrchestration(
    'InstanceMonitor',
    `monitor-${input.instanceId}`,
    { instanceId: input.instanceId }
  );

  return { status: 'provisioned' };
});
```

### Continue-as-New (Eternal Orchestrations)

For long-running orchestrations that need periodic refresh (e.g., monitoring loops):

```javascript
runtime.registerOrchestration('Monitor', function* (ctx, input) {
  const state = input.state || { checkCount: 0 };

  // Do periodic work
  const health = yield ctx.scheduleActivity('CheckHealth', input.target);
  ctx.traceInfo(`health check #${state.checkCount}: ${health.status}`);

  // Wait before next check
  yield ctx.scheduleTimer(30000); // 30 seconds

  // Restart with updated state (keeps history from growing unbounded)
  yield ctx.continueAsNew({
    target: input.target,
    state: { checkCount: state.checkCount + 1 }
  });
});
```

### Error Handling

Use try/catch around yielded operations:

```javascript
runtime.registerOrchestration('SafeWorkflow', function* (ctx, input) {
  try {
    const result = yield ctx.scheduleActivity('RiskyCall', input);
    return result;
  } catch (error) {
    ctx.traceError(`activity failed: ${error.message}`);
    yield ctx.scheduleActivity('Cleanup', { error: error.message });
    return { status: 'failed', error: error.message };
  }
});
```

### Retry Policies

```javascript
const result = yield ctx.scheduleActivityWithRetry('FlakeyApi', input, {
  maxAttempts: 3,
  backoff: 'exponential',
  timeoutMs: 5000,       // per-attempt timeout
  totalTimeoutMs: 30000, // total timeout across all attempts
});
```

### Custom Status — Progress Reporting

Set progress visible to external clients. Fire-and-forget — no `yield` needed:

```javascript
runtime.registerOrchestration('LongProcess', function* (ctx, input) {
  ctx.setCustomStatus('step 1: validating');
  yield ctx.scheduleActivity('Validate', input);

  ctx.setCustomStatus('step 2: processing');
  const result = yield ctx.scheduleActivity('Process', input);

  ctx.setCustomStatus('step 3: complete');
  return result;
});

// Client-side: poll for progress
let lastVersion = 0;
while (true) {
  const change = await client.waitForStatusChange(instanceId, lastVersion, 100, 30000);
  if (!change) break; // timeout — orchestration probably completed
  console.log(`Progress: ${change.customStatus}`);
  lastVersion = change.customStatusVersion;
}
```

Use `ctx.resetCustomStatus()` to clear the status back to null.

The `customStatus` and `customStatusVersion` fields are also available on the status object returned by `getOrchestrationStatus()` and `waitForOrchestration()`.

### Event Queues — Persistent FIFO Messaging

Event queues provide durable, ordered message passing. Unlike `waitForEvent` (one-shot), queues are persistent mailboxes that survive `continueAsNew`:

```javascript
runtime.registerOrchestration('WorkProcessor', function* (ctx) {
  // Block until a message arrives on the 'tasks' queue
  const taskJson = yield ctx.dequeueEvent('tasks');
  const task = JSON.parse(taskJson);

  const result = yield ctx.scheduleActivity('ProcessTask', task);
  ctx.setCustomStatus(JSON.stringify({ done: task.id, result }));

  // Loop forever by restarting — queue state survives
  return yield ctx.continueAsNew('');
});

// Send work from outside
await client.enqueueEvent(instanceId, 'tasks', JSON.stringify({ id: 1, type: 'resize' }));
await client.enqueueEvent(instanceId, 'tasks', JSON.stringify({ id: 2, type: 'compress' }));
```

Key properties:
- **FIFO ordering** — messages delivered in enqueue order
- **Survives continue-as-new** — queue state persists across restarts
- **Blocks until available** — orchestration suspends until a message arrives

### Retry with Session Affinity

Pin all retry attempts to the same worker session:

```javascript
const result = yield ctx.scheduleActivityWithRetryOnSession(
  'StatefulOperation',
  input,
  {
    maxAttempts: 3,
    backoff: 'exponential',
    timeoutMs: 5000,
    totalTimeoutMs: 30000,
  },
  sessionId
);
```

This is useful when retry attempts should reuse local state (caches, connections, locks) that are pinned to a session.

### Real-World Pattern: Multi-Turn Chat

Combine event queues, custom status, and continue-as-new for a Copilot-style conversational agent:

```javascript
runtime.registerOrchestration('ChatBot', function* (ctx) {
  // Wait for the next user message
  const msgJson = yield ctx.dequeueEvent('inbox');
  const msg = JSON.parse(msgJson);

  // Generate a response
  const response = yield ctx.scheduleActivity('Generate', msg.text);

  // Publish the reply via custom status
  ctx.setCustomStatus(JSON.stringify({ state: 'replied', response, seq: msg.seq }));

  // End conversation on "bye"
  if (msg.text.includes('bye')) return `Done after ${msg.seq} msgs`;

  // Otherwise loop — queue state and status survive continue-as-new
  return yield ctx.continueAsNew('');
});

// Client side: send a message and wait for the reply
await client.enqueueEvent(instanceId, 'inbox', JSON.stringify({ seq: 1, text: 'Hello!' }));
const status = await client.waitForStatusChange(instanceId, 0, 50, 10000);
const reply = JSON.parse(status.customStatus);
console.log(reply.response); // AI-generated reply
```

## Activity Patterns

### Basic Activity

```javascript
runtime.registerActivity('SendEmail', async (ctx, input) => {
  ctx.traceInfo(`sending to ${input.to}`);
  await emailService.send(input.to, input.subject, input.body);
  return { sent: true };
});
```

### Activity with Client Access

Activities can start other orchestrations or raise events:

```javascript
runtime.registerActivity('TriggerCleanup', async (ctx, input) => {
  const client = ctx.getClient();
  await client.startOrchestration(
    `cleanup-${input.id}`,
    'CleanupWorkflow',
    { resourceId: input.id }
  );
  return { triggered: true };
});
```

### Returning Errors

Throw an error (or return a rejected promise) to mark the activity as failed:

```javascript
runtime.registerActivity('ValidateInput', async (ctx, input) => {
  if (!input.email) {
    throw new Error('email is required');
  }
  return { valid: true };
});
```

## Activity Sessions

Sessions provide worker affinity — all activities scheduled with the same `sessionId` are routed to the same worker. This is useful for stateful activities that need local caches, connections, or locks.

### Schedule Activity on Session

```javascript
runtime.registerOrchestration('GameTurn', function* (ctx) {
  const sessionId = yield ctx.newGuid(); // deterministic session ID
  const r1 = yield ctx.scheduleActivityOnSession('RunTurn', { turn: 1 }, sessionId);
  const r2 = yield ctx.scheduleActivityOnSession('RunTurn', { turn: 2 }, sessionId);
  return { r1, r2 }; // both ran on the same worker
});
```

You can also pass `sessionId` as an option to `scheduleActivity`:

```javascript
const r = yield ctx.scheduleActivity('RunTurn', { turn: 1 }, { sessionId: 'my-session' });
```

### Reading Session ID in Activities

```javascript
runtime.registerActivity('RunTurn', async (ctx, input) => {
  ctx.traceInfo(`session: ${ctx.sessionId}`); // null for regular activities
  return `turn-${input.turn}`;
});
```

### Session Runtime Options

```javascript
const runtime = new Runtime(provider, {
  maxSessionsPerRuntime: 10,           // Max concurrent sessions (default: 10)
  sessionIdleTimeoutMs: 300_000,       // Session unpin after idle (default: 5 min)
  workerNodeId: 'pod-name',            // Stable identity for session ownership
});
```

## Tracing

### Orchestration Tracing

Tracing calls are automatically suppressed during replay — no duplicates:

```javascript
runtime.registerOrchestration('Traced', function* (ctx, input) {
  ctx.traceInfo('[v1.0.0] starting workflow');
  ctx.traceDebug(`input: ${JSON.stringify(input)}`);

  const result = yield ctx.scheduleActivity('Work', input);

  ctx.traceInfo(`[v1.0.0] completed: ${result}`);
  return result;
});
```

### Activity Tracing

Activity traces include full structured metadata (activity name, ID, worker ID):

```javascript
runtime.registerActivity('FetchData', async (ctx, input) => {
  ctx.traceInfo(`fetching data for ${input.id}`);
  const data = await fetch(input.url);
  ctx.traceInfo(`got ${data.length} bytes`);
  return data;
});
```

### Controlling Log Level

```bash
RUST_LOG=info node app.js                         # INFO and above
RUST_LOG=duroxide::orchestration=debug node app.js # Orchestration debug
RUST_LOG=duroxide::activity=info node app.js       # Activity info only
```

## Providers

### SQLite

Good for development, testing, and single-node deployments:

```javascript
// File-backed (persistent)
const provider = await SqliteProvider.open('sqlite:myapp.db');

// In-memory (ephemeral, great for tests)
const provider = await SqliteProvider.inMemory();
```

### PostgreSQL

For production multi-node deployments:

```javascript
const provider = await PostgresProvider.connect(
  'postgresql://user:pass@host:5432/mydb'
);

// With schema isolation
const provider = await PostgresProvider.connectWithSchema(
  'postgresql://user:pass@host:5432/mydb',
  'duroxide_app'
);
```

## Runtime Options

```javascript
const runtime = new Runtime(provider, {
  orchestrationConcurrency: 4,    // Max concurrent orchestration dispatches
  workerConcurrency: 8,           // Max concurrent activity workers
  dispatcherPollInterval: 100,    // Polling interval in ms
  logLevel: 'info',               // Tracing log level
  logFormat: 'pretty',            // 'pretty' or 'json'
  serviceName: 'my-service',      // Service name for tracing metadata
  serviceVersion: '1.0.0',        // Service version for tracing metadata
  maxSessionsPerRuntime: 10,      // Max concurrent sessions per runtime
  sessionIdleTimeoutMs: 300_000,  // Session idle timeout in ms (5 min)
  workerNodeId: 'pod-1',          // Stable worker identity for sessions
});
```

## Metrics

Get a snapshot of runtime metrics (requires observability to be configured):

```javascript
const snapshot = runtime.metricsSnapshot();
if (snapshot) {
  console.log(`Orchestrations started: ${snapshot.orchStarts}`);
  console.log(`Orchestrations completed: ${snapshot.orchCompletions}`);
  console.log(`Activity successes: ${snapshot.activitySuccess}`);
  console.log(`Provider errors: ${snapshot.providerErrors}`);
}
```

Returns `null` if observability is not enabled. The snapshot includes counters for orchestration starts/completions/failures, activity results, dispatcher stats, and provider errors.

## Client Operations

```javascript
const client = new Client(provider);

// Start an orchestration
await client.startOrchestration('id', 'WorkflowName', inputData);
await client.startOrchestrationVersioned('id', 'WorkflowName', inputData, '1.0.2');

// Wait for completion (with timeout in ms)
const status = await client.waitForOrchestration('id', 30000);
// status.status: 'Completed' | 'Failed' | 'Running' | 'Terminated' | ...
// status.customStatus: string | undefined — current custom status
// status.customStatusVersion: number — monotonically increasing version counter

// Cancel a running orchestration
await client.cancelOrchestration('id');

// Raise an event
await client.raiseEvent('id', 'eventName', eventData);

// Get status without waiting
const status = await client.getOrchestrationStatus('id');

// Event queues
await client.enqueueEvent('id', 'queueName', JSON.stringify(data));

// Custom status polling
const change = await client.waitForStatusChange('id', lastVersion, 100, 30000);
// change: { customStatus, customStatusVersion } or null on timeout

// Admin operations
await client.deleteInstance('id', { force: false });
const metrics = await client.getSystemMetrics();
const depths = await client.getQueueDepths();
```

## Versioning

Register multiple versions of an orchestration:

```javascript
runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
  // v1.0.0 — original
  const r = yield ctx.scheduleActivity('Work', input);
  return r;
});

runtime.registerOrchestrationVersioned('MyWorkflow', '1.0.1', function* (ctx, input) {
  // v1.0.1 — with validation
  yield ctx.scheduleActivity('Validate', input);
  const r = yield ctx.scheduleActivity('Work', input);
  return r;
});
```

New orchestrations use the latest version. Running orchestrations stay on their original version until they complete or call `continueAsNew`.

## Multi-Step Parallel Blocks (Sub-Orchestration Pattern)

In Rust, arbitrary async blocks can be composed with `join()`/`select()`. In the Node.js SDK, `all()`/`race()` only accept single task descriptors — multi-step blocks must be wrapped as sub-orchestrations.

```javascript
// Pattern: wrap multi-step logic as a sub-orchestration
runtime.registerOrchestration('BlockA', function* (ctx, input) {
  const first = yield ctx.scheduleActivity('Step', 'A1');
  if (first.includes('step')) {
    const second = yield ctx.scheduleActivity('Step', 'A2');
    return `A:[${first},${second}]`;
  }
  return 'A:fallback';
});

runtime.registerOrchestration('BlockB', function* (ctx, input) {
  yield ctx.scheduleTimer(5);
  const result = yield ctx.scheduleActivity('Step', 'B1');
  return `B:[timer,${result}]`;
});

// Parent: join/race sub-orchestration descriptors
runtime.registerOrchestration('Parent', function* (ctx, input) {
  // Join multiple multi-step blocks
  const [a, b] = yield ctx.all([
    ctx.scheduleSubOrchestration('BlockA', ''),
    ctx.scheduleSubOrchestration('BlockB', ''),
  ]);
  return `${a},${b}`;
});
```

Use `all()` for joining (all must complete) and `race()` for racing (first wins, loser is cancelled). For 3+ way races, nest `race()` calls. See `async_blocks.test.js` for 12 examples covering join, race, nested chains, and timeout patterns.

## Determinism Rules

Orchestration functions **must be deterministic**. The replay engine re-executes the generator from the beginning on every dispatch, feeding back cached results. If the code path changes, replay breaks.

**Do:**
- Use `yield ctx.utcNow()` for timestamps
- Use `yield ctx.newGuid()` for random IDs
- Use `ctx.traceInfo()` for logging (auto-suppressed during replay)

**Don't:**
- Use `Date.now()`, `Math.random()`, `crypto.randomUUID()`
- Make HTTP calls or read files in orchestrations
- Use `console.log()` (will duplicate on replay — use `ctx.traceInfo()` instead)
- Read environment variables that might change between restarts

Activities have no such restrictions — they run once and can do anything.
