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

Run multiple tasks in parallel and wait for all to complete:

```javascript
runtime.registerOrchestration('FanOut', function* (ctx, input) {
  const tasks = input.items.map(item =>
    ctx.scheduleActivity('ProcessItem', item)
  );
  const results = yield ctx.all(tasks);
  return results;
});
```

### Race / Select

Wait for the first of two tasks to complete:

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
  observability: {
    logLevel: 'info',
    serviceName: 'my-service',
    gaugePollInterval: 60000,     // Metrics polling interval in ms
  },
});
```

## Client Operations

```javascript
const client = new Client(provider);

// Start an orchestration
await client.startOrchestration('id', 'WorkflowName', inputData);
await client.startOrchestrationVersioned('id', 'WorkflowName', inputData, '1.0.2');

// Wait for completion (with timeout in ms)
const status = await client.waitForOrchestration('id', 30000);
// status.status: 'Completed' | 'Failed' | 'Running' | 'Terminated' | ...

// Cancel a running orchestration
await client.cancelOrchestration('id');

// Raise an event
await client.raiseEvent('id', 'eventName', eventData);

// Get status without waiting
const status = await client.getOrchestrationStatus('id');

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
