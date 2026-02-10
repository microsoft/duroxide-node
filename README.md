# duroxide-node

Node.js/TypeScript SDK for the [Duroxide](https://github.com/afdaraern/duroxide) durable execution runtime. Write reliable, long-running workflows in JavaScript using generator functions — backed by a Rust runtime that handles persistence, replay, and fault tolerance.

## Features

- **Durable orchestrations** — generator-based workflows that survive process restarts
- **Automatic replay** — the Rust runtime replays history on restart, your code picks up where it left off
- **Activities** — async functions for side effects (API calls, DB writes, etc.)
- **Timers** — durable delays that persist across restarts
- **Sub-orchestrations** — compose workflows from smaller workflows
- **External events** — pause workflows and wait for signals
- **Fan-out/fan-in** — run tasks in parallel with `ctx.all()`
- **Race conditions** — wait for the first of multiple tasks with `ctx.race()`
- **Continue-as-new** — restart orchestrations with fresh history for eternal workflows
- **Structured tracing** — orchestration and activity logs route through Rust's `tracing` crate
- **SQLite & PostgreSQL** — pluggable storage backends

## Quick Start

```bash
npm install duroxide
```

```javascript
const { SqliteProvider, Client, Runtime } = require('duroxide');

async function main() {
  // 1. Open a storage backend
  const provider = await SqliteProvider.open('sqlite:myapp.db');
  const client = new Client(provider);
  const runtime = new Runtime(provider);

  // 2. Register activities (async functions with side effects)
  runtime.registerActivity('Greet', async (ctx, name) => {
    ctx.traceInfo(`greeting ${name}`);
    return `Hello, ${name}!`;
  });

  // 3. Register orchestrations (generator functions)
  runtime.registerOrchestration('GreetWorkflow', function* (ctx, input) {
    const greeting = yield ctx.scheduleActivity('Greet', input.name);
    ctx.traceInfo(`got: ${greeting}`);
    return greeting;
  });

  // 4. Start the runtime
  await runtime.start();

  // 5. Start an orchestration and wait for it
  await client.startOrchestration('greet-1', 'GreetWorkflow', { name: 'World' });
  const result = await client.waitForOrchestration('greet-1');
  console.log(result.output); // "Hello, World!"

  await runtime.shutdown();
}

main();
```

## Why Generators (not async/await)?

Duroxide uses `function*` generators instead of `async function` for orchestrations. This is a deliberate design choice — see [Architecture](docs/architecture.md#yield-vs-await) for the full explanation. The short version: generators give Rust full control over when and how each step executes, which is essential for deterministic replay.

```javascript
// ✅ Orchestrations use yield
runtime.registerOrchestration('MyWorkflow', function* (ctx, input) {
  const result = yield ctx.scheduleActivity('DoWork', input);
  return result;
});

// ✅ Activities use async/await (normal async functions)
runtime.registerActivity('DoWork', async (ctx, input) => {
  const data = await fetch(`https://api.example.com/${input}`);
  return data;
});
```

## Orchestration Context API

All scheduling methods return descriptors that must be **yielded**:

| Method | Description |
|--------|-------------|
| `yield ctx.scheduleActivity(name, input)` | Run an activity |
| `yield ctx.scheduleActivityWithRetry(name, input, retryPolicy)` | Run with retry |
| `yield ctx.scheduleTimer(delayMs)` | Durable delay |
| `yield ctx.waitForEvent(eventName)` | Wait for external signal |
| `yield ctx.scheduleSubOrchestration(name, input)` | Run child workflow (await result) |
| `yield ctx.scheduleSubOrchestrationWithId(name, id, input)` | Child with explicit ID |
| `yield ctx.startOrchestration(name, id, input)` | Fire-and-forget orchestration |
| `yield ctx.all([task1, task2, ...])` | Parallel execution (like `Promise.all`) |
| `yield ctx.race(task1, task2)` | First-to-complete (like `Promise.race`) |
| `yield ctx.utcNow()` | Deterministic timestamp |
| `yield ctx.newGuid()` | Deterministic GUID |
| `yield ctx.continueAsNew(newInput)` | Restart with fresh history |

Tracing methods are **fire-and-forget** (no yield needed):

| Method | Description |
|--------|-------------|
| `ctx.traceInfo(message)` | INFO log (suppressed during replay) |
| `ctx.traceWarn(message)` | WARN log |
| `ctx.traceError(message)` | ERROR log |
| `ctx.traceDebug(message)` | DEBUG log |

## Storage Backends

### SQLite

```javascript
const provider = await SqliteProvider.open('sqlite:path/to/db.db');
// or in-memory:
const provider = await SqliteProvider.inMemory();
```

### PostgreSQL

```javascript
const provider = await PostgresProvider.connectWithSchema(
  'postgresql://user:pass@host:5432/db',
  'my_schema'
);
```

## Logging

Duroxide uses Rust's `tracing` crate. Control verbosity with `RUST_LOG`:

```bash
RUST_LOG=info node app.js              # INFO and above
RUST_LOG=duroxide=debug node app.js    # DEBUG for duroxide only
RUST_LOG=duroxide::activity=info node app.js  # Activity traces only
```

## Documentation

- [Architecture](docs/architecture.md) — how the Rust/JS interop works, yield vs await, limitations
- [User Guide](docs/user-guide.md) — patterns, recipes, and best practices

## Tests

```bash
npm test                 # SQLite e2e tests (17 tests)
npm run test:pg          # PostgreSQL e2e tests (13 tests)
npm run test:scenarios   # Toygres scenario tests (6 tests)
npm run test:all         # Everything
```

## License

[MIT](LICENSE)
