// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Tests for ctx.all() (join) and ctx.race() (select) with mixed task types,
 * including activity cooperative cancellation via isCancelled().
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PostgresProvider, Client, Runtime } = require('../lib/duroxide.js');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCHEMA = 'duroxide_node_races';
const RUN_ID = `rc${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

let provider;

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL not set. Create a .env file or export DATABASE_URL.');
  }
  provider = await PostgresProvider.connectWithSchema(dbUrl, SCHEMA);
});

// ─── Helper ──────────────────────────────────────────────────────

async function runOrchestration(name, input, registerFn) {
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
  registerFn(runtime);
  await runtime.start();
  try {
    const instanceId = uid(name);
    await client.startOrchestration(instanceId, name, input);
    return await client.waitForOrchestration(instanceId, 10000);
  } finally {
    await runtime.shutdown(100);
  }
}

// ─── ctx.all() with mixed task types ─────────────────────────────

describe('all() with mixed task types', () => {
  it('joins activity + timer', async () => {
    const result = await runOrchestration('AllActivityTimer', null, (rt) => {
      rt.registerActivity('Slow', async (ctx, input) => `done-${input}`);
      rt.registerOrchestration('AllActivityTimer', function* (ctx) {
        const results = yield ctx.all([
          ctx.scheduleActivity('Slow', 'work'),
          ctx.scheduleTimer(50),
        ]);
        return results;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.length, 2);
    assert.strictEqual(result.output[0].ok, 'done-work');
    assert.strictEqual(result.output[1].ok, null);
  });

  it('joins activity + waitEvent', async () => {
    const instanceId = uid('all-wait');
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('Quick', async (ctx, input) => `quick-${input}`);
    runtime.registerOrchestration('AllActivityWait', function* (ctx) {
      const results = yield ctx.all([
        ctx.scheduleActivity('Quick', 'go'),
        ctx.waitForEvent('signal'),
      ]);
      return results;
    });

    await runtime.start();
    try {
      await client.startOrchestration(instanceId, 'AllActivityWait', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.raiseEvent(instanceId, 'signal', { msg: 'hi' });
      const result = await client.waitForOrchestration(instanceId, 10000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.length, 2);
      assert.strictEqual(result.output[0].ok, 'quick-go');
      assert.deepStrictEqual(result.output[1].ok, { msg: 'hi' });
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('joins multiple timers', async () => {
    const result = await runOrchestration('AllTimers', null, (rt) => {
      rt.registerOrchestration('AllTimers', function* (ctx) {
        const results = yield ctx.all([
          ctx.scheduleTimer(50),
          ctx.scheduleTimer(100),
        ]);
        return results;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.length, 2);
    assert.strictEqual(result.output[0].ok, null);
    assert.strictEqual(result.output[1].ok, null);
  });
  it('joins activity + dequeueEvent — value is not double-serialized', async () => {
    const instanceId = uid('all-deq');
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('Quick', async (ctx, input) => `quick-${input}`);
    runtime.registerOrchestration('AllActivityDequeue', function* (ctx) {
      const results = yield ctx.all([
        ctx.scheduleActivity('Quick', 'go'),
        ctx.dequeueEvent('inbox'),
      ]);
      return results;
    });

    await runtime.start();
    try {
      await client.startOrchestration(instanceId, 'AllActivityDequeue', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.enqueueEvent(instanceId, 'inbox', { prompt: 'HELLO' });
      const result = await client.waitForOrchestration(instanceId, 10000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.length, 2);
      assert.strictEqual(result.output[0].ok, 'quick-go');
      // Verify dequeue value is properly structured, not double-serialized
      assert.strictEqual(typeof result.output[1].ok, 'object',
        'all() dequeue value should be an object, not a double-serialized string');
      assert.deepStrictEqual(result.output[1].ok, { prompt: 'HELLO' });
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── ctx.race() with mixed task types ────────────────────────────

describe('race() with mixed task types', () => {
  it('races activity vs timer (activity wins)', async () => {
    const result = await runOrchestration('RaceActTimer', null, (rt) => {
      rt.registerActivity('Fast', async (ctx, input) => `fast-${input}`);
      rt.registerOrchestration('RaceActTimer', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleActivity('Fast', 'go'),
          ctx.scheduleTimer(60000),
        );
        return winner;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.index, 0);
    assert.strictEqual(result.output.value, 'fast-go');
  });

  it('races timer vs activity (timer wins, activity cooperatively cancels)', async () => {
    const instanceId = uid('race-timer-act');
    const client = new Client(provider);
    // Short lock timeout so cancellation is detected quickly
    const runtime = new Runtime(provider, {
      dispatcherPollIntervalMs: 50,
      workerLockTimeoutMs: 2000,
    });
    let activityCancelled = false;

    runtime.registerActivity('Glacial', async (ctx, input) => {
      // Cooperative cancellation: poll isCancelled() instead of sleeping forever
      while (!ctx.isCancelled()) {
        await new Promise((r) => setTimeout(r, 50));
      }
      activityCancelled = true;
      return 'cancelled';
    });
    runtime.registerOrchestration('RaceTimerAct', function* (ctx) {
      const winner = yield ctx.race(
        ctx.scheduleTimer(50),
        ctx.scheduleActivity('Glacial', 'x'),
      );
      return winner;
    });

    await runtime.start();
    try {
      await client.startOrchestration(instanceId, 'RaceTimerAct', null);
      const result = await client.waitForOrchestration(instanceId, 15000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.index, 0);
      assert.strictEqual(result.output.value, null);

      // Wait for the cancellation signal to propagate to the activity
      for (let i = 0; i < 60 && !activityCancelled; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(activityCancelled, 'activity should have seen isCancelled()');
    } finally {
      await runtime.shutdown(2000);
    }
  });

  it('isCancelled() stays true after the cancellation grace period', async () => {
    const instanceId = uid('race-cancel-sticky');
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
      dispatcherPollIntervalMs: 50,
      workerLockTimeoutMs: 2000,
    });
    // After it cancels an activity the runtime waits 10 s (the cancellation grace period),
    // then gives up on the invocation. The JS function keeps running after that.
    const GRACE_MS = 10000;
    const AFTER_GRACE_MS = 3000;
    const samples = [];
    let firstCancelledAt = null;
    let activityDone = false;

    runtime.registerActivity('Stubborn', async (ctx) => {
      const start = Date.now();
      for (;;) {
        const cancelled = ctx.isCancelled();
        const now = Date.now();
        if (cancelled && firstCancelledAt === null) firstCancelledAt = now;
        samples.push({ at: now, cancelled });
        if (firstCancelledAt !== null && now - firstCancelledAt > GRACE_MS + AFTER_GRACE_MS) break;
        if (now - start > 40000) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      activityDone = true;
      return 'late';
    });
    runtime.registerOrchestration('RaceTimerStubborn', function* (ctx) {
      const winner = yield ctx.race(
        ctx.scheduleTimer(50),
        ctx.scheduleActivity('Stubborn', 'x'),
      );
      return winner;
    });

    await runtime.start();
    try {
      await client.startOrchestration(instanceId, 'RaceTimerStubborn', null);
      const result = await client.waitForOrchestration(instanceId, 15000);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.index, 0);

      for (let i = 0; i < 450 && !activityDone; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(activityDone, 'activity should have finished its loop');
      assert.notStrictEqual(firstCancelledAt, null, 'activity should have seen isCancelled()');

      const sinceCancel = samples.filter((s) => s.at >= firstCancelledAt);
      const last = sinceCancel[sinceCancel.length - 1];
      assert.ok(
        last.at - firstCancelledAt > GRACE_MS,
        'the activity should have kept checking after the grace period',
      );
      const wentBack = sinceCancel.find((s) => !s.cancelled);
      assert.strictEqual(
        wentBack,
        undefined,
        wentBack && `isCancelled() went back to false ${wentBack.at - firstCancelledAt} ms after it was first true`,
      );
    } finally {
      await runtime.shutdown(2000);
    }
  });

  it('races waitEvent vs timer (event wins)', async () => {
    const instanceId = uid('race-wait');
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('RaceWaitTimer', function* (ctx) {
      const winner = yield ctx.race(
        ctx.waitForEvent('approval'),
        ctx.scheduleTimer(60000),
      );
      return winner;
    });

    await runtime.start();
    try {
      await client.startOrchestration(instanceId, 'RaceWaitTimer', null);
      await new Promise((r) => setTimeout(r, 300));
      await client.raiseEvent(instanceId, 'approval', { ok: true });
      const result = await client.waitForOrchestration(instanceId, 10000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.index, 0);
      assert.deepStrictEqual(result.output.value, { ok: true });
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('race(timer, dequeueEvent) — value is not double-serialized (#59)', async () => {
    const instanceId = uid('race-deq');
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('RaceDequeue', function* (ctx) {
      const winner = yield ctx.race(
        ctx.scheduleTimer(60000),
        ctx.dequeueEvent('messages'),
      );
      return winner;
    });

    await runtime.start();
    try {
      await client.startOrchestration(instanceId, 'RaceDequeue', null);
      await new Promise((r) => setTimeout(r, 500));
      // Pass object directly — enqueueEvent handles JSON.stringify internally
      await client.enqueueEvent(instanceId, 'messages', { prompt: 'HELLO' });
      const result = await client.waitForOrchestration(instanceId, 10000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.index, 1);

      // Before the fix, value was double-serialized: a string needing two JSON.parse() calls.
      // After the fix, value is the properly parsed object after one parse.
      assert.strictEqual(typeof result.output.value, 'object',
        'race dequeue value should be an object, not a double-serialized string');
      assert.deepStrictEqual(result.output.value, { prompt: 'HELLO' });
    } finally {
      await runtime.shutdown(100);
    }
  });

  it('races two timers (shorter wins)', async () => {
    const result = await runOrchestration('RaceTwoTimers', null, (rt) => {
      rt.registerOrchestration('RaceTwoTimers', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleTimer(50),
          ctx.scheduleTimer(60000),
        );
        return winner;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.index, 0);
  });
});

// ─── ctx.race() when the winner failed ──────────────────────────
//
// A winner that failed makes the yield throw. The error is the one the orchestration
// gets when it yields that task on its own: same type, same message.

describe('race() with a failed winner', () => {
  it('throws the error of a failed activity, and the orchestration can go on', async () => {
    const result = await runOrchestration('RaceFailedActivity', null, (rt) => {
      rt.registerActivity('Boom', async (ctx, input) => {
        throw new Error(`boom-${input}`);
      });
      rt.registerActivity('Fast', async (ctx, input) => `fast-${input}`);
      rt.registerOrchestration('RaceFailedActivity', function* (ctx) {
        let direct;
        try {
          yield ctx.scheduleActivity('Boom', 'x');
        } catch (e) {
          direct = { message: e.message, isError: e instanceof Error };
        }
        let raced;
        try {
          const winner = yield ctx.race(
            ctx.scheduleActivity('Boom', 'x'),
            ctx.scheduleTimer(60000),
          );
          raced = { returned: winner };
        } catch (e) {
          raced = { message: e.message, isError: e instanceof Error };
        }
        // The orchestration catches the error and schedules more work.
        const after = yield ctx.scheduleActivity('Fast', 'after');
        return { direct, raced, after };
      });
    });
    assert.strictEqual(result.status, 'Completed');
    const { direct, raced, after } = result.output;
    assert.ok(direct && direct.isError, 'the direct yield should throw');
    assert.match(direct.message, /boom-x/);
    assert.strictEqual(raced.returned, undefined, 'the race should throw, not return');
    assert.strictEqual(raced.isError, true);
    assert.strictEqual(raced.message, direct.message);
    assert.strictEqual(after, 'fast-after');
  });

  it('throws when the failed winner is the second task', async () => {
    const result = await runOrchestration('RaceFailedSecond', null, (rt) => {
      rt.registerActivity('Boom', async () => {
        throw new Error('second-boom');
      });
      rt.registerOrchestration('RaceFailedSecond', function* (ctx) {
        try {
          return yield ctx.race(
            ctx.scheduleTimer(60000),
            ctx.scheduleActivity('Boom', null),
          );
        } catch (e) {
          return { caught: e.message };
        }
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.match(result.output.caught, /second-boom/);
  });

  it('throws the error of a failed sub-orchestration', async () => {
    const result = await runOrchestration('RaceFailedChildParent', null, (rt) => {
      rt.registerOrchestration('RaceFailedChild', function* () {
        throw new Error('child-boom');
      });
      rt.registerOrchestration('RaceFailedChildParent', function* (ctx) {
        let direct;
        try {
          yield ctx.scheduleSubOrchestration('RaceFailedChild', null);
        } catch (e) {
          direct = e.message;
        }
        let raced;
        try {
          raced = { returned: yield ctx.race(
            ctx.scheduleSubOrchestration('RaceFailedChild', null),
            ctx.scheduleTimer(60000),
          ) };
        } catch (e) {
          raced = { message: e.message };
        }
        return { direct, raced };
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.match(result.output.direct, /child-boom/);
    assert.strictEqual(result.output.raced.returned, undefined, 'the race should throw, not return');
    assert.strictEqual(result.output.raced.message, result.output.direct);
  });

  it('an uncaught failed winner fails the orchestration', async () => {
    const result = await runOrchestration('RaceFailedUncaught', null, (rt) => {
      rt.registerActivity('Boom', async () => {
        throw new Error('uncaught-boom');
      });
      rt.registerOrchestration('RaceFailedUncaught', function* (ctx) {
        return yield ctx.race(
          ctx.scheduleActivity('Boom', null),
          ctx.scheduleTimer(60000),
        );
      });
    });
    assert.strictEqual(result.status, 'Failed');
    assert.match(result.error, /uncaught-boom/);
  });

  it('a timer that wins over a failing activity returns as before', async () => {
    const result = await runOrchestration('RaceTimerBeatsBoom', null, (rt) => {
      rt.registerActivity('SlowBoom', async (ctx) => {
        for (let i = 0; i < 40 && !ctx.isCancelled(); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('too-late');
      });
      rt.registerOrchestration('RaceTimerBeatsBoom', function* (ctx) {
        return yield ctx.race(
          ctx.scheduleTimer(50),
          ctx.scheduleActivity('SlowBoom', null),
        );
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.index, 0);
    assert.strictEqual(result.output.value, null);
  });

  it('raceTyped throws the same error, and still parses a successful winner', async () => {
    const result = await runOrchestration('RaceTypedFailed', null, (rt) => {
      rt.registerActivity('Boom', async () => {
        throw new Error('typed-boom');
      });
      rt.registerActivity('Obj', async () => ({ a: 1 }));
      rt.registerOrchestration('RaceTypedFailed', function* (ctx) {
        let caught;
        try {
          yield ctx.raceTyped(
            ctx.scheduleActivityTyped('Boom', null),
            ctx.scheduleTimer(60000),
          );
        } catch (e) {
          caught = { message: e.message, isError: e instanceof Error };
        }
        const winner = yield ctx.raceTyped(
          ctx.scheduleActivityTyped('Obj', null),
          ctx.scheduleTimer(60000),
        );
        return { caught, winner };
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.caught.isError, true);
    assert.match(result.output.caught.message, /typed-boom/);
    assert.deepStrictEqual(result.output.winner, { index: 0, value: { a: 1 } });
  });
});

// ─── Type preservation through all() and race() ─────────────────

describe('type preservation', () => {
  it('all() preserves all value types (string, number, object, array, null, boolean)', async () => {
    const result = await runOrchestration('AllTypes', null, (rt) => {
      rt.registerActivity('ReturnString', async () => 'hello');
      rt.registerActivity('ReturnNumber', async () => 42);
      rt.registerActivity('ReturnObject', async () => ({ key: 'val' }));
      rt.registerActivity('ReturnArray', async () => [1, 2, 3]);
      rt.registerActivity('ReturnNull', async () => null);
      rt.registerActivity('ReturnBool', async () => true);
      rt.registerOrchestration('AllTypes', function* (ctx) {
        return yield ctx.all([
          ctx.scheduleActivity('ReturnString', null),
          ctx.scheduleActivity('ReturnNumber', null),
          ctx.scheduleActivity('ReturnObject', null),
          ctx.scheduleActivity('ReturnArray', null),
          ctx.scheduleActivity('ReturnNull', null),
          ctx.scheduleActivity('ReturnBool', null),
        ]);
      });
    });
    assert.strictEqual(result.status, 'Completed');
    const vals = result.output.map((r) => r.ok);

    assert.strictEqual(vals[0], 'hello');
    assert.strictEqual(typeof vals[0], 'string');

    assert.strictEqual(vals[1], 42);
    assert.strictEqual(typeof vals[1], 'number');

    assert.deepStrictEqual(vals[2], { key: 'val' });
    assert.strictEqual(typeof vals[2], 'object');

    assert.deepStrictEqual(vals[3], [1, 2, 3]);
    assert.ok(Array.isArray(vals[3]));

    assert.strictEqual(vals[4], null);

    assert.strictEqual(vals[5], true);
    assert.strictEqual(typeof vals[5], 'boolean');
  });

  it('race() preserves all value types (string, number, object)', async () => {
    // Test string
    const r1 = await runOrchestration('RaceString', null, (rt) => {
      rt.registerActivity('FastStr', async () => 'hello');
      rt.registerOrchestration('RaceString', function* (ctx) {
        return yield ctx.race(
          ctx.scheduleActivity('FastStr', null),
          ctx.scheduleTimer(60000),
        );
      });
    });
    assert.strictEqual(r1.output.value, 'hello');
    assert.strictEqual(typeof r1.output.value, 'string');

    // Test number
    const r2 = await runOrchestration('RaceNumber', null, (rt) => {
      rt.registerActivity('FastNum', async () => 42);
      rt.registerOrchestration('RaceNumber', function* (ctx) {
        return yield ctx.race(
          ctx.scheduleActivity('FastNum', null),
          ctx.scheduleTimer(60000),
        );
      });
    });
    assert.strictEqual(r2.output.value, 42);
    assert.strictEqual(typeof r2.output.value, 'number');

    // Test object
    const r3 = await runOrchestration('RaceObject', null, (rt) => {
      rt.registerActivity('FastObj', async () => ({ key: 'val' }));
      rt.registerOrchestration('RaceObject', function* (ctx) {
        return yield ctx.race(
          ctx.scheduleActivity('FastObj', null),
          ctx.scheduleTimer(60000),
        );
      });
    });
    assert.deepStrictEqual(r3.output.value, { key: 'val' });
    assert.strictEqual(typeof r3.output.value, 'object');
  });
});
