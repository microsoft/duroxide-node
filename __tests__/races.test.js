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
