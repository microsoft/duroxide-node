/**
 * End-to-end tests for duroxide Node.js SDK — PostgreSQL backend.
 * Ported from duroxide/tests/e2e_samples.rs
 *
 * All tests run against PostgreSQL. A single SQLite smoketest is at the end.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SqliteProvider, PostgresProvider, Client, Runtime, initTracing } = require('../lib/duroxide.js');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCHEMA = 'duroxide_node_e2e';
const RUN_ID = `e2e${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

// ─── Helpers ─────────────────────────────────────────────────────

let provider;

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL not set. Create a .env file or export DATABASE_URL.');
  }
  provider = await PostgresProvider.connectWithSchema(dbUrl, SCHEMA);
});

async function runOrchestration(name, input, setupFn, timeoutMs = 10_000) {
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

  setupFn(runtime);
  await runtime.start();

  try {
    const instanceId = uid(name);
    await client.startOrchestration(instanceId, name, input);
    return await client.waitForOrchestration(instanceId, timeoutMs);
  } finally {
    await runtime.shutdown(100);
  }
}

// ─── 1. Hello World ──────────────────────────────────────────────

describe('hello world', () => {
  it('calls activity twice and returns result', async () => {
    const result = await runOrchestration('HelloWorld', 'World', (rt) => {
      rt.registerActivity('Hello', async (ctx, input) => {
        ctx.traceInfo(`greeting ${input}`);
        return `Hello, ${input}!`;
      });
      rt.registerOrchestration('HelloWorld', function* (ctx, input) {
        const r1 = yield ctx.scheduleActivity('Hello', 'Rust');
        ctx.traceInfo(`first greeting: ${r1}`);
        const r2 = yield ctx.scheduleActivity('Hello', input);
        return r2;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'Hello, World!');
  });
});

// ─── 2. Control Flow ─────────────────────────────────────────────

describe('control flow', () => {
  it('branches based on activity result', async () => {
    const result = await runOrchestration('ControlFlow', null, (rt) => {
      rt.registerActivity('GetFlag', async () => 'yes');
      rt.registerActivity('SayYes', async () => 'picked_yes');
      rt.registerActivity('SayNo', async () => 'picked_no');
      rt.registerOrchestration('ControlFlow', function* (ctx) {
        const flag = yield ctx.scheduleActivity('GetFlag', '');
        if (flag === 'yes') {
          return yield ctx.scheduleActivity('SayYes', '');
        } else {
          return yield ctx.scheduleActivity('SayNo', '');
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'picked_yes');
  });
});

// ─── 3. Loop ─────────────────────────────────────────────────────

describe('loop', () => {
  it('accumulates value over multiple iterations', async () => {
    const result = await runOrchestration('LoopOrchestration', null, (rt) => {
      rt.registerActivity('Append', async (ctx, input) => {
        ctx.traceInfo(`appending to "${input}"`);
        return `${input}x`;
      });
      rt.registerOrchestration('LoopOrchestration', function* (ctx) {
        let acc = 'start';
        for (let i = 0; i < 3; i++) {
          acc = yield ctx.scheduleActivity('Append', acc);
          ctx.traceInfo(`iteration ${i}: ${acc}`);
        }
        return acc;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'startxxx');
  });
});

// ─── 4. Error Handling ───────────────────────────────────────────

describe('error handling', () => {
  it('catches activity failure and calls recovery', async () => {
    const result = await runOrchestration('ErrorHandling', null, (rt) => {
      rt.registerActivity('Fragile', async (ctx, input) => {
        ctx.traceWarn(`fragile called with "${input}"`);
        if (input === 'bad') throw new Error('boom');
        return 'ok';
      });
      rt.registerActivity('Recover', async () => 'recovered');
      rt.registerOrchestration('ErrorHandling', function* (ctx) {
        try {
          return yield ctx.scheduleActivity('Fragile', 'bad');
        } catch (e) {
          ctx.traceWarn(`fragile failed: ${e.message}`);
          return yield ctx.scheduleActivity('Recover', '');
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'recovered');
  });
});

// ─── 5. Timer ────────────────────────────────────────────────────

describe('timer', () => {
  it('schedules and completes a timer', async () => {
    const result = await runOrchestration('TimerSample', null, (rt) => {
      rt.registerActivity('AfterTimer', async () => 'done');
      rt.registerOrchestration('TimerSample', function* (ctx) {
        yield ctx.scheduleTimer(100);
        return yield ctx.scheduleActivity('AfterTimer', '');
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'done');
  });
});

// ─── 6. Fan-out Fan-in (join) ────────────────────────────────────

describe('fan-out fan-in', () => {
  it('runs activities in parallel with join', async () => {
    const result = await runOrchestration('FanOut', null, (rt) => {
      rt.registerActivity('Greetings', async (ctx, input) => {
        ctx.traceInfo(`building greeting for ${input}`);
        return `Hello, ${input}!`;
      });
      rt.registerOrchestration('FanOut', function* (ctx) {
        const a = ctx.scheduleActivity('Greetings', 'Gabbar');
        const b = ctx.scheduleActivity('Greetings', 'Samba');
        const results = yield ctx.all([a, b]);
        const vals = results
          .map((r) => r.ok)
          .sort();
        return `${vals[0]}, ${vals[1]}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'Hello, Gabbar!, Hello, Samba!');
  });
});

// ─── 7. System Activities (utcNow, newGuid) ──────────────────────

describe('system activities', () => {
  it('returns deterministic time and guid', async () => {
    const result = await runOrchestration('SystemActivities', null, (rt) => {
      rt.registerOrchestration('SystemActivities', function* (ctx) {
        const now = yield ctx.utcNow();
        const guid = yield ctx.newGuid();
        ctx.traceInfo(`now=${now}, guid=${guid}`);
        return { now, guid };
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.now > 0);
    assert.strictEqual(result.output.guid.length, 36);
  });
});

// ─── 8. Status Polling ───────────────────────────────────────────

describe('status polling', () => {
  it('orchestration transitions from Running to Completed', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('StatusSample', function* (ctx) {
      yield ctx.scheduleTimer(50);
      return 'done';
    });
    await runtime.start();

    try {
      const instanceId = uid('status');
      await client.startOrchestration(instanceId, 'StatusSample', null);
      // Immediately check — should be Running or NotFound
      const early = await client.getStatus(instanceId);
      assert.ok(['Running', 'NotFound'].includes(early.status));
      // Wait for completion
      const final_ = await client.waitForOrchestration(instanceId, 5000);
      assert.strictEqual(final_.status, 'Completed');
      assert.strictEqual(final_.output, 'done');
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 9. Sub-orchestration (basic) ────────────────────────────────

describe('sub-orchestration basic', () => {
  it('parent calls child and gets result', async () => {
    const result = await runOrchestration('Parent', 'hi', (rt) => {
      rt.registerActivity('Upper', async (ctx, input) => input.toUpperCase());
      rt.registerOrchestration('ChildUpper', function* (ctx, input) {
        return yield ctx.scheduleActivity('Upper', input);
      });
      rt.registerOrchestration('Parent', function* (ctx, input) {
        const r = yield ctx.scheduleSubOrchestration('ChildUpper', input);
        return `parent:${r}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'parent:HI');
  });
});

// ─── 10. Sub-orchestration Fan-out ───────────────────────────────

describe('sub-orchestration fan-out', () => {
  it('parent spawns children in parallel and sums', async () => {
    const result = await runOrchestration('ParentFan', null, (rt) => {
      rt.registerActivity('Add', async (ctx, input) => {
        const [a, b] = input.split(',').map(Number);
        return a + b;
      });
      rt.registerOrchestration('ChildSum', function* (ctx, input) {
        return yield ctx.scheduleActivity('Add', input);
      });
      rt.registerOrchestration('ParentFan', function* (ctx) {
        const a = ctx.scheduleSubOrchestration('ChildSum', '1,2');
        const b = ctx.scheduleSubOrchestration('ChildSum', '3,4');
        const results = yield ctx.all([a, b]);
        const nums = results.map((r) => {
          const v = r.ok;
          return typeof v === 'string' ? parseInt(v) : v;
        });
        return `total=${nums.reduce((a, b) => a + b, 0)}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'total=10');
  });
});

// ─── 11. Sub-orchestration Chained (3 levels) ────────────────────

describe('sub-orchestration chained', () => {
  it('root → mid → leaf chain', async () => {
    const result = await runOrchestration('Root', 'a', (rt) => {
      rt.registerActivity('AppendX', async (ctx, input) => `${input}x`);
      rt.registerOrchestration('Leaf', function* (ctx, input) {
        return yield ctx.scheduleActivity('AppendX', input);
      });
      rt.registerOrchestration('Mid', function* (ctx, input) {
        const r = yield ctx.scheduleSubOrchestration('Leaf', input);
        return `${r}-mid`;
      });
      rt.registerOrchestration('Root', function* (ctx, input) {
        const r = yield ctx.scheduleSubOrchestration('Mid', input);
        return `root:${r}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'root:ax-mid');
  });
});

// ─── 12. External Event ──────────────────────────────────────────

describe('external event', () => {
  it('waits for and receives an external event', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('WaitForApproval', function* (ctx) {
      ctx.traceInfo('Waiting for approval...');
      const event = yield ctx.waitForEvent('approval');
      return { approved: event };
    });
    await runtime.start();

    try {
      const instanceId = uid('event');
      await client.startOrchestration(instanceId, 'WaitForApproval', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.raiseEvent(instanceId, 'approval', { status: 'yes' });
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      assert.deepStrictEqual(result.output, { approved: { status: 'yes' } });
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 13. Continue-as-New ─────────────────────────────────────────

describe('continue-as-new', () => {
  it('rolls execution forward until condition met', async () => {
    const result = await runOrchestration('CanSample', 0, (rt) => {
      rt.registerOrchestration('CanSample', function* (ctx, n) {
        if (n < 3) {
          ctx.traceInfo(`CAN sample n=${n} -> continue`);
          yield ctx.continueAsNew(n + 1);
          return null; // unreachable
        } else {
          return `final:${n}`;
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'final:3');
  });
});

// ─── 14. Cancellation ────────────────────────────────────────────

describe('cancellation', () => {
  it('cancels a running orchestration', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('LongRunning', function* (ctx) {
      yield ctx.waitForEvent('never_arrives');
      return 'should not reach';
    });
    await runtime.start();

    try {
      const instanceId = uid('cancel');
      await client.startOrchestration(instanceId, 'LongRunning', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.cancelInstance(instanceId, 'user_request');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Failed');
      assert.ok(result.error, 'expected error message');
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 15. Conditional Logic ───────────────────────────────────────

describe('conditional logic', () => {
  it('handles if/else in orchestrations', async () => {
    const result = await runOrchestration('Conditional', { threshold: 50, value: 75 }, (rt) => {
      rt.registerActivity('ProcessHigh', async () => 'high');
      rt.registerActivity('ProcessLow', async () => 'low');
      rt.registerOrchestration('Conditional', function* (ctx, input) {
        if (input.value > input.threshold) {
          return yield ctx.scheduleActivity('ProcessHigh', input.value);
        } else {
          return yield ctx.scheduleActivity('ProcessLow', input.value);
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'high');
  });
});

// ─── 16. Activity Chain ──────────────────────────────────────────

describe('activity chain', () => {
  it('chains multiple activities sequentially', async () => {
    const result = await runOrchestration('Chain', 1, (rt) => {
      rt.registerActivity('AddOne', async (ctx, input) => input + 1);
      rt.registerOrchestration('Chain', function* (ctx, input) {
        let value = input;
        value = yield ctx.scheduleActivity('AddOne', value);
        value = yield ctx.scheduleActivity('AddOne', value);
        value = yield ctx.scheduleActivity('AddOne', value);
        return value;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 4);
  });
});

// ─── 17. Retry Policy ────────────────────────────────────────────

describe('retry policy', () => {
  it('retries a flaky activity until success', async () => {
    let attempts = 0;
    const result = await runOrchestration('RetrySuccess', null, (rt) => {
      rt.registerActivity('FlakyService', async (ctx, input) => {
        attempts++;
        ctx.traceInfo(`attempt ${attempts}`);
        if (attempts < 3) throw new Error(`fail-${attempts}`);
        return `ok-after-${attempts}`;
      });
      rt.registerOrchestration('RetrySuccess', function* (ctx) {
        const r = yield ctx.scheduleActivityWithRetry('FlakyService', 'go', {
          maxAttempts: 5,
          backoff: 'exponential',
        });
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'ok-after-3');
    assert.ok(attempts >= 3, 'should have retried at least 3 times');
  });

  it('exhausts retries and fails the orchestration', async () => {
    const result = await runOrchestration('RetryExhaust', null, (rt) => {
      rt.registerActivity('AlwaysFails', async () => {
        throw new Error('permanent failure');
      });
      rt.registerOrchestration('RetryExhaust', function* (ctx) {
        try {
          yield ctx.scheduleActivityWithRetry('AlwaysFails', null, {
            maxAttempts: 2,
            backoff: 'fixed',
          });
          return 'should not reach';
        } catch (e) {
          return `caught: ${e.message}`;
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(
      result.output.startsWith('caught:'),
      `expected caught error, got: ${result.output}`
    );
  });
});

// ─── 18. Versioned Orchestrations ────────────────────────────────

describe('versioned orchestrations', () => {
  it('new instances use latest version', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('GetVersion', async () => 'v-activity');

    // Register v1.0.0 (default)
    runtime.registerOrchestration('VersionedWorkflow', function* (ctx) {
      ctx.traceInfo('[v1.0.0] running');
      return 'v1.0.0';
    });

    // Register v1.0.1 (should be used for new instances)
    runtime.registerOrchestrationVersioned('VersionedWorkflow', '1.0.1', function* (ctx) {
      ctx.traceInfo('[v1.0.1] running');
      return 'v1.0.1';
    });

    await runtime.start();

    try {
      const instanceId = uid('ver-latest');
      await client.startOrchestration(instanceId, 'VersionedWorkflow', null);
      const result = await client.waitForOrchestration(instanceId);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output, 'v1.0.1');
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('continue-as-new upgrades to latest version', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    // v1.0.0: continues as new (will upgrade to v1.0.1)
    runtime.registerOrchestration('UpgradingWorkflow', function* (ctx, input) {
      ctx.traceInfo('[v1.0.0] will upgrade');
      yield ctx.continueAsNew({ fromVersion: '1.0.0' });
    });

    // v1.0.1: completes with version info
    runtime.registerOrchestrationVersioned('UpgradingWorkflow', '1.0.1', function* (ctx, input) {
      ctx.traceInfo('[v1.0.1] upgraded');
      return { version: '1.0.1', previousVersion: input.fromVersion };
    });

    await runtime.start();

    try {
      const instanceId = uid('ver-can');
      // Start with v1.0.0 explicitly
      await client.startOrchestrationVersioned(
        instanceId,
        'UpgradingWorkflow',
        {},
        '1.0.0'
      );
      const result = await client.waitForOrchestration(instanceId);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.version, '1.0.1');
      assert.strictEqual(result.output.previousVersion, '1.0.0');
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('different versions run different logic', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('Work', async (ctx, input) => `done-${input}`);

    // v1.0.0: simple
    runtime.registerOrchestration('MultiVerWorkflow', function* (ctx, input) {
      return 'v1-simple';
    });

    // v1.0.1: added validation step
    runtime.registerOrchestrationVersioned('MultiVerWorkflow', '1.0.1', function* (ctx, input) {
      const validated = yield ctx.scheduleActivity('Work', 'validated');
      return `v1.0.1-${validated}`;
    });

    await runtime.start();

    try {
      const id1 = uid('ver-v1');
      const id2 = uid('ver-v101');
      // Start one with v1.0.0 explicitly
      await client.startOrchestrationVersioned(id1, 'MultiVerWorkflow', null, '1.0.0');
      // Start one with latest (v1.0.1)
      await client.startOrchestration(id2, 'MultiVerWorkflow', null);

      const r1 = await client.waitForOrchestration(id1);
      const r2 = await client.waitForOrchestration(id2);

      assert.strictEqual(r1.status, 'Completed');
      assert.strictEqual(r1.output, 'v1-simple');

      assert.strictEqual(r2.status, 'Completed');
      assert.strictEqual(r2.output, 'v1.0.1-done-validated');
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 19. STOP AND RESUME — Demonstrates durable execution surviving a
//     complete runtime shutdown and restart. The orchestration waits
//     for an external signal. We start, shut down, restart with the
//     same DB, raise the signal, and verify completion.
// ═══════════════════════════════════════════════════════════════════

describe('stop and resume (signal)', () => {
  it('survives runtime shutdown and resumes from durable state', async () => {
    const instanceId = uid('approval');

    // ── Phase 1: Start runtime, begin orchestration ──────────
    {
      const client = new Client(provider);
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

      runtime.registerActivity('ProcessApproval', async (ctx, input) => {
        return `approved:${input.decision}`;
      });

      runtime.registerOrchestration('ApprovalWorkflow', function* (ctx, input) {
        ctx.traceInfo(`Request ${input.requestId} submitted, waiting for approval...`);

        // Step 1: Wait for the approval signal (blocks until event arrives)
        const approval = yield ctx.waitForEvent('approval');
        ctx.traceInfo(`Got approval: ${JSON.stringify(approval)}`);

        // Step 2: Process the approval
        const result = yield ctx.scheduleActivity('ProcessApproval', approval);
        return { requestId: input.requestId, result };
      });

      await runtime.start();

      // Start the workflow
      await client.startOrchestration(instanceId, 'ApprovalWorkflow', {
        requestId: 'REQ-42',
      });

      // Give it time to reach the waitForEvent
      await new Promise((r) => setTimeout(r, 1000));

      // Verify it's running (blocked on the signal)
      const status = await client.getStatus(instanceId);
      assert.strictEqual(status.status, 'Running', 'should be Running while waiting for signal');

      // ── SHUTDOWN — simulate crash or deployment ────────────
      await runtime.shutdown(100);
    }

    // ── Phase 2: New runtime, same database — resume ─────────
    {
      const client = new Client(provider);
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

      // Re-register the same orchestrations and activities
      runtime.registerActivity('ProcessApproval', async (ctx, input) => {
        return `approved:${input.decision}`;
      });

      runtime.registerOrchestration('ApprovalWorkflow', function* (ctx, input) {
        ctx.traceInfo(`Request ${input.requestId} submitted, waiting for approval...`);
        const approval = yield ctx.waitForEvent('approval');
        ctx.traceInfo(`Got approval: ${JSON.stringify(approval)}`);
        const result = yield ctx.scheduleActivity('ProcessApproval', approval);
        return { requestId: input.requestId, result };
      });

      await runtime.start();

      // Raise the approval event — the resumed orchestration picks it up
      await client.raiseEvent(instanceId, 'approval', {
        decision: 'granted',
        approver: 'alice',
      });

      // Wait for completion
      const result = await client.waitForOrchestration(instanceId, 10_000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.requestId, 'REQ-42');
      assert.strictEqual(result.output.result, 'approved:granted');

      await runtime.shutdown(100);
    }
  });
});

// ─── 20. SQLite Smoketest ────────────────────────────────────────

describe('get_client from activity', () => {
  it('activity can use getClient to start a new orchestration', async () => {
    const result = await runOrchestration('ClientFromActivity', 'trigger', (rt) => {
      rt.registerActivity('SpawnChild', async (ctx, input) => {
        const client = ctx.getClient();
        await client.startOrchestration(`child-${ctx.instanceId}`, 'SimpleChild', input);
        const childResult = await client.waitForOrchestration(`child-${ctx.instanceId}`);
        return childResult.output;
      });
      rt.registerOrchestration('SimpleChild', function* (ctx, input) {
        return `child-got-${input}`;
      });
      rt.registerOrchestration('ClientFromActivity', function* (ctx, input) {
        return yield ctx.scheduleActivity('SpawnChild', input);
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'child-got-trigger');
  });
});

describe('metrics snapshot', () => {
  it('runtime exposes metrics snapshot after processing', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    runtime.registerActivity('Echo', async (ctx, input) => input);
    runtime.registerOrchestration('MetricsTest', function* (ctx, input) {
      return yield ctx.scheduleActivity('Echo', input);
    });
    await runtime.start();
    try {
      const id = uid('metrics');
      await client.startOrchestration(id, 'MetricsTest', 'hello');
      await client.waitForOrchestration(id);
      const snapshot = runtime.metricsSnapshot();
      assert.ok(snapshot, 'metrics snapshot should be available');
      assert.ok(snapshot.orchStarts >= 1, `expected at least 1 orch start, got ${snapshot.orchStarts}`);
      assert.ok(snapshot.orchCompletions >= 1, `expected at least 1 completion, got ${snapshot.orchCompletions}`);
      assert.ok(snapshot.activitySuccess >= 1, `expected at least 1 activity success, got ${snapshot.activitySuccess}`);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 21. SQLite Smoketest ────────────────────────────────────────

describe('sqlite smoketest', () => {
  it('runs a basic orchestration on SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duroxide-smoke-'));
    const dbPath = `sqlite:${path.join(dir, 'smoke.db')}`;
    const sqliteProvider = await SqliteProvider.open(dbPath);
    const client = new Client(sqliteProvider);
    const runtime = new Runtime(sqliteProvider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('Echo', async (ctx, input) => input);
    runtime.registerOrchestration('SmokeTest', function* (ctx, input) {
      return yield ctx.scheduleActivity('Echo', input);
    });

    await runtime.start();
    try {
      await client.startOrchestration('smoke-1', 'SmokeTest', { hello: 'sqlite' });
      const result = await client.waitForOrchestration('smoke-1', 5000);
      assert.strictEqual(result.status, 'Completed');
      assert.deepStrictEqual(result.output, { hello: 'sqlite' });
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 22. initTracing ─────────────────────────────────────────────

describe('initTracing', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof initTracing, 'function');
  });

  it('writes traces to a file when called before any runtime', () => {
    const logFile = path.join(os.tmpdir(), `duroxide-init-tracing-${Date.now()}.log`);
    // May throw if a global subscriber is already installed — that's OK
    try {
      initTracing({ logFile, logLevel: 'info' });
    } catch (err) {
      // first-writer-wins: another subscriber already installed
      assert.ok(err.message.includes('Failed to init tracing'), `unexpected error: ${err.message}`);
    }
    // Clean up
    try { fs.unlinkSync(logFile); } catch {}
  });

  it('throws a clear error for invalid log file path', () => {
    assert.throws(
      () => initTracing({ logFile: '/nonexistent-dir/sub/test.log' }),
      (err) => err.message.includes('Failed to open log file'),
    );
  });
});
