/**
 * Advanced features tests for duroxide Node.js SDK — PostgreSQL backend.
 * Covers typed registration, retry, cancellation, timers, custom status,
 * event queues, continue-as-new, versioning, error handling, and nondeterminism.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PostgresProvider, Client, Runtime } = require('../lib/duroxide.js');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCHEMA = 'duroxide_node_advanced_features';
const RUN_ID = `af${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

let provider;

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  provider = await PostgresProvider.connectWithSchema(dbUrl, SCHEMA);
});

async function runOrchestration(name, input, registerFn, timeoutMs = 10_000) {
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
  registerFn(runtime);
  await runtime.start();
  try {
    const instanceId = uid(name);
    await client.startOrchestration(instanceId, name, input);
    return await client.waitForOrchestration(instanceId, timeoutMs);
  } finally {
    await runtime.shutdown(100);
  }
}

// === TYPED REGISTRATION (1-3) ===

describe('advanced features', () => {

  it('typed registration round trip', async () => {
    const result = await runOrchestration('TypedRegRT', 21, (rt) => {
      rt.registerActivityTyped('Double', async (ctx, n) => n * 2);
      rt.registerOrchestrationTyped('TypedRegRT', function* (ctx, input) {
        const r = yield ctx.scheduleActivityTyped('Double', input);
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 42);
  });

  it('typed registration fan out', async () => {
    const result = await runOrchestration('TypedFanOut', 5, (rt) => {
      rt.registerActivityTyped('AddTen', async (ctx, n) => n + 10);
      rt.registerActivityTyped('MulThree', async (ctx, n) => n * 3);
      rt.registerOrchestration('TypedFanOut', function* (ctx, input) {
        const results = yield ctx.all([
          ctx.scheduleActivity('AddTen', input),
          ctx.scheduleActivity('MulThree', input),
        ]);
        const sum = results[0].ok + results[1].ok;
        return sum;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 30);
  });

  it('typed registration race wins', async () => {
    const result = await runOrchestration('TypedRace', null, (rt) => {
      rt.registerActivityTyped('QuickCalc', async (ctx, n) => n * 2);
      rt.registerOrchestration('TypedRace', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleActivity('QuickCalc', 21),
          ctx.scheduleTimer(2000),
        );
        return winner.value;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 42);
  });

  // === RETRY (4-5) ===

  it('retry succeeds after failures', async () => {
    let attempts = 0;
    const result = await runOrchestration('RetryAfterFail', null, (rt) => {
      rt.registerActivity('Flaky', async (ctx, input) => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return `success-on-${attempts}`;
      });
      rt.registerOrchestration('RetryAfterFail', function* (ctx) {
        const r = yield ctx.scheduleActivityWithRetry('Flaky', 'go', {
          maxAttempts: 5,
          backoff: 'fixed',
        });
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.includes('success'), `expected success, got: ${result.output}`);
  });

  it('retry exhaustion compensation', async () => {
    const result = await runOrchestration('RetryComp', null, (rt) => {
      rt.registerActivity('AlwaysFails', async () => {
        throw new Error('permanent error');
      });
      rt.registerActivity('Compensate', async () => 'compensated');
      rt.registerOrchestration('RetryComp', function* (ctx) {
        try {
          yield ctx.scheduleActivityWithRetry('AlwaysFails', null, {
            maxAttempts: 2,
            backoff: 'fixed',
          });
          return 'should not reach';
        } catch (e) {
          return yield ctx.scheduleActivity('Compensate', null);
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'compensated');
  });

  // === CANCELLATION (6-8) ===

  it('cancel propagates to sub orchestration', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('LongChild6', function* (ctx) {
      yield ctx.waitForEvent('never_comes');
      return 'child-done';
    });
    runtime.registerOrchestration('CancelParent', function* (ctx) {
      return yield ctx.scheduleSubOrchestration('LongChild6', null);
    });

    await runtime.start();
    try {
      const instanceId = uid('CancelParent');
      await client.startOrchestration(instanceId, 'CancelParent', null);
      await new Promise((r) => setTimeout(r, 2000));
      await client.cancelInstance(instanceId, 'test-cancel');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Failed');
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('cancel completed is noop', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('Echo7', async (ctx, input) => input);
    runtime.registerOrchestration('QuickOrch', function* (ctx) {
      return yield ctx.scheduleActivity('Echo7', 'hello');
    });

    await runtime.start();
    try {
      const instanceId = uid('QuickOrch');
      await client.startOrchestration(instanceId, 'QuickOrch', null);
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      // Cancelling a completed instance should not throw
      await client.cancelInstance(instanceId, 'test-cancel-noop');
      const status = await client.getStatus(instanceId);
      assert.strictEqual(status.status, 'Completed');
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('race sub orchestration wins', async () => {
    const result = await runOrchestration('RaceParent8', null, (rt) => {
      rt.registerActivity('Work8', async () => 'work-done');
      rt.registerOrchestration('FastChild8', function* (ctx) {
        return yield ctx.scheduleActivity('Work8', null);
      });
      rt.registerOrchestration('SlowChild8', function* (ctx) {
        yield ctx.waitForEvent('never');
        return 'slow-done';
      });
      rt.registerOrchestration('RaceParent8', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('FastChild8', null),
          ctx.scheduleSubOrchestration('SlowChild8', null),
        );
        return winner;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.index, 0);
    assert.strictEqual(result.output.value, 'work-done');
  });

  // === TIMERS (9-10) ===

  it('timer activity interleave', async () => {
    const result = await runOrchestration('TimerInterleave', null, (rt) => {
      rt.registerActivity('Step9', async (ctx, input) => `step:${input}`);
      rt.registerOrchestration('TimerInterleave', function* (ctx) {
        yield ctx.scheduleTimer(50);
        const r1 = yield ctx.scheduleActivity('Step9', '1');
        yield ctx.scheduleTimer(50);
        const r2 = yield ctx.scheduleActivity('Step9', '2');
        return `${r1},${r2}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'step:1,step:2');
  });

  it('zero duration timer', async () => {
    const result = await runOrchestration('ZeroTimer', null, (rt) => {
      rt.registerActivity('After10', async () => 'after-timer');
      rt.registerOrchestration('ZeroTimer', function* (ctx) {
        yield ctx.scheduleTimer(0);
        return yield ctx.scheduleActivity('After10', null);
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'after-timer');
  });

  // === CUSTOM STATUS (11-12) ===

  it('custom status multi turn lifecycle', async () => {
    const result = await runOrchestration('StatusLifecycle', null, (rt) => {
      rt.registerActivity('Noop11', async () => 'ok');
      rt.registerOrchestration('StatusLifecycle', function* (ctx) {
        ctx.setCustomStatus('phase1');
        yield ctx.scheduleActivity('Noop11', null);
        const s1 = ctx.getCustomStatus();
        ctx.setCustomStatus('phase2');
        yield ctx.scheduleActivity('Noop11', null);
        const s2 = ctx.getCustomStatus();
        ctx.resetCustomStatus();
        yield ctx.scheduleActivity('Noop11', null);
        const s3 = ctx.getCustomStatus();
        return `${s1},${s2},${s3 ?? 'none'}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'phase1,phase2,none');
  });

  it('custom status visible from client', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('StatusVisible', function* (ctx) {
      ctx.setCustomStatus('processing');
      yield ctx.waitForEvent('proceed');
      return 'done';
    });

    await runtime.start();
    try {
      const instanceId = uid('StatusVisible');
      await client.startOrchestration(instanceId, 'StatusVisible', null);
      await new Promise((r) => setTimeout(r, 2000));
      const status = await client.getStatus(instanceId);
      assert.strictEqual(status.customStatus, 'processing');
      await client.raiseEvent(instanceId, 'proceed', 'go');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output, 'done');
    } finally {
      await runtime.shutdown(100);
    }
  });

  // === EVENT QUEUES (13-14) ===

  it('event queue fifo ordering', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('FifoTest', function* (ctx) {
      const m1 = yield ctx.dequeueEvent('work');
      const m2 = yield ctx.dequeueEvent('work');
      const m3 = yield ctx.dequeueEvent('work');
      return `${m1},${m2},${m3}`;
    });

    await runtime.start();
    try {
      const instanceId = uid('FifoTest');
      await client.startOrchestration(instanceId, 'FifoTest', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.enqueueEvent(instanceId, 'work', 'first');
      await client.enqueueEvent(instanceId, 'work', 'second');
      await client.enqueueEvent(instanceId, 'work', 'third');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output, 'first,second,third');
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('event queue multi queue isolation', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('MultiQueue', function* (ctx) {
      const a1 = yield ctx.dequeueEvent('alpha');
      const b1 = yield ctx.dequeueEvent('beta');
      const a2 = yield ctx.dequeueEvent('alpha');
      return `a:${a1}+${a2},b:${b1}`;
    });

    await runtime.start();
    try {
      const instanceId = uid('MultiQueue');
      await client.startOrchestration(instanceId, 'MultiQueue', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.enqueueEvent(instanceId, 'alpha', 'a-first');
      await client.enqueueEvent(instanceId, 'beta', 'b-first');
      await client.enqueueEvent(instanceId, 'alpha', 'a-second');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output, 'a:a-first+a-second,b:b-first');
    } finally {
      await runtime.shutdown(100);
    }
  });

  // === CONTINUE-AS-NEW (15) ===

  it('continue as new with activity', async () => {
    const result = await runOrchestration('CanCounter', 3, (rt) => {
      rt.registerActivity('Record', async (ctx, input) => `recorded:${input}`);
      rt.registerOrchestration('CanCounter', function* (ctx, input) {
        const n = typeof input === 'number' ? input : Number(input);
        const r = yield ctx.scheduleActivity('Record', n);
        if (n > 1) {
          yield ctx.continueAsNew(n - 1);
          return null;
        }
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'recorded:1');
  });

  // === VERSIONING (16) ===

  it('versioned sub orchestration explicit pin', async () => {
    const result = await runOrchestration('VersionParent', null, (rt) => {
      rt.registerOrchestrationVersioned('VChild', '1.0.0', function* (ctx) {
        return 'v1-result';
      });
      rt.registerOrchestrationVersioned('VChild', '1.0.1', function* (ctx) {
        return 'v2-result';
      });
      rt.registerOrchestration('VersionParent', function* (ctx) {
        return yield ctx.scheduleSubOrchestrationVersioned('VChild', '1.0.0', null);
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'v1-result');
  });

  // === ERROR HANDLING (17-18) ===

  it('error sub orchestration propagates', async () => {
    const result = await runOrchestration('ErrorParent', null, (rt) => {
      rt.registerActivity('FailAct', async () => {
        throw new Error('child-error');
      });
      rt.registerOrchestration('FailChild', function* (ctx) {
        yield ctx.scheduleActivity('FailAct', null);
        return 'ok';
      });
      rt.registerOrchestration('ErrorParent', function* (ctx) {
        try {
          yield ctx.scheduleSubOrchestration('FailChild', null);
        } catch (e) {
          return `caught:${e.message || e}`;
        }
        return 'no-error';
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(
      result.output.startsWith('caught:'),
      `expected caught error, got: ${result.output}`,
    );
  });

  it('error compensation debit ship refund', async () => {
    const result = await runOrchestration('Saga', null, (rt) => {
      rt.registerActivity('Debit', async () => 'debited');
      rt.registerActivity('Ship', async () => {
        throw new Error('ship-failed');
      });
      rt.registerActivity('Refund', async () => 'refunded');
      rt.registerOrchestration('Saga', function* (ctx) {
        const debit = yield ctx.scheduleActivity('Debit', 'order-1');
        try {
          yield ctx.scheduleActivity('Ship', 'order-1');
        } catch (e) {
          const refund = yield ctx.scheduleActivity('Refund', 'order-1');
          return `compensated:${debit}:${refund}`;
        }
        return `shipped:${debit}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output, 'compensated:debited:refunded');
  });

  // === NONDETERMINISM (19-20) ===

  it('nondeterminism command type swap', async () => {
    const client = new Client(provider);
    const instanceId = uid('NondetSwap');

    // Phase 1: activity then waitForEvent
    const runtime1 = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    runtime1.registerActivity('Work19', async (ctx, input) => 'done');
    runtime1.registerOrchestration('NondetSwap', function* (ctx) {
      yield ctx.scheduleActivity('Work19', 'x');
      yield ctx.waitForEvent('proceed');
      return 'v1';
    });
    await runtime1.start();
    await client.startOrchestration(instanceId, 'NondetSwap', null);
    await new Promise((r) => setTimeout(r, 2000));
    await runtime1.shutdown(100);

    // Phase 2: timer then waitForEvent (different command type)
    const runtime2 = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    runtime2.registerActivity('Work19', async (ctx, input) => 'done');
    runtime2.registerOrchestration('NondetSwap', function* (ctx) {
      yield ctx.scheduleTimer(100);
      yield ctx.waitForEvent('proceed');
      return 'v2';
    });
    await runtime2.start();
    try {
      await client.raiseEvent(instanceId, 'proceed', 'go');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      // Nondeterminism should be detected: history has activity but code says timer
      assert.strictEqual(result.status, 'Failed',
        `expected Failed due to nondeterminism, got: ${result.status}`);
    } finally {
      await runtime2.shutdown(100);
    }
  });

  it('nondeterminism extra activity', async () => {
    const client = new Client(provider);
    const instanceId = uid('NondetExtra');

    // Phase 1: single activity then waitForEvent
    const runtime1 = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    runtime1.registerActivity('Work20', async (ctx, input) => 'done');
    runtime1.registerActivity('Extra20', async (ctx, input) => 'extra');
    runtime1.registerOrchestration('NondetExtra', function* (ctx) {
      yield ctx.scheduleActivity('Work20', 'x');
      yield ctx.waitForEvent('proceed');
      return 'v1';
    });
    await runtime1.start();
    await client.startOrchestration(instanceId, 'NondetExtra', null);
    await new Promise((r) => setTimeout(r, 2000));
    await runtime1.shutdown(100);

    // Phase 2: two activities then waitForEvent (extra activity not in history)
    const runtime2 = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    runtime2.registerActivity('Work20', async (ctx, input) => 'done');
    runtime2.registerActivity('Extra20', async (ctx, input) => 'extra');
    runtime2.registerOrchestration('NondetExtra', function* (ctx) {
      yield ctx.scheduleActivity('Work20', 'x');
      yield ctx.scheduleActivity('Extra20', 'x');
      yield ctx.waitForEvent('proceed');
      return 'v2';
    });
    await runtime2.start();
    try {
      await client.raiseEvent(instanceId, 'proceed', 'go');
      const result = await client.waitForOrchestration(instanceId, 10_000);
      // Nondeterminism should be detected: history replayed activity, then expects
      // waitForEvent but code yields an extra activity
      assert.strictEqual(result.status, 'Failed',
        `expected Failed due to nondeterminism, got: ${result.status}`);
    } finally {
      await runtime2.shutdown(100);
    }
  });

});
