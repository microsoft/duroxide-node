// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * KV store end-to-end tests for duroxide Node.js SDK.
 * Ported from duroxide/tests/e2e_samples.rs.
 * Uses SqliteProvider.inMemory() for fast, self-contained tests.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SqliteProvider, Client, Runtime, MAX_KV_KEYS } = require('../lib/duroxide.js');

const RUN_ID = `kv${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

async function withRuntime(setupFn, testFn) {
  const provider = await SqliteProvider.inMemory();
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

  setupFn(runtime, client);
  await runtime.start();

  try {
    await testFn(client);
  } finally {
    await runtime.shutdown(100);
  }
}

describe('kv store', () => {
  it('kv request response', async () => {
    await withRuntime((runtime) => {
      runtime.registerActivity('ProcessCommand', async (_ctx, input) => {
        return String(input).split('').reverse().join('');
      });

      runtime.registerOrchestration('RequestServer', function* (ctx) {
        ctx.setValue('scratch', 'temp');
        assert.strictEqual(ctx.getValue('scratch'), 'temp');
        ctx.clearValue('scratch');
        assert.strictEqual(ctx.getValue('scratch'), null);
        ctx.setValue('scratch', 'temp-again');
        ctx.clearAllValues();
        assert.strictEqual(ctx.getValue('scratch'), null);

        ctx.setValue('status', 'ready');

        for (let i = 0; i < 3; i++) {
          const request = yield ctx.waitForEvent('request');
          const { op_id, command } = request;

          ctx.setValue('status', 'processing');
          const result = yield ctx.scheduleActivity('ProcessCommand', command);
          ctx.setValue(`response:${op_id}`, result);
          ctx.setValue('status', 'ready');
        }

        ctx.setValue('status', 'shutdown');
        return 'served 3 requests';
      });
    }, async (client) => {
      const instanceId = uid('req-resp-server');
      await client.startOrchestration(instanceId, 'RequestServer', null);

      assert.strictEqual(await client.waitForValue(instanceId, 'status', 5000), 'ready');

      const requests = [
        ['op-1', 'hello'],
        ['op-2', 'world'],
        ['op-3', 'rust'],
      ];

      for (const [opId, command] of requests) {
        await client.raiseEvent(instanceId, 'request', { op_id: opId, command });
        const response = await client.waitForValue(instanceId, `response:${opId}`, 5000);
        assert.strictEqual(response, command.split('').reverse().join(''));
      }

      const status = await client.waitForOrchestration(instanceId, 5000);
      assert.strictEqual(status.status, 'Completed');
      assert.strictEqual(status.output, 'served 3 requests');

      assert.strictEqual(await client.getValue(instanceId, 'status'), 'shutdown');
      assert.strictEqual(await client.getValue(instanceId, 'response:op-1'), 'olleh');
      assert.strictEqual(await client.getValue(instanceId, 'response:op-2'), 'dlrow');
      assert.strictEqual(await client.getValue(instanceId, 'response:op-3'), 'tsur');
    });
  });

  it('kv keys are listed and pruned in key order, and the prune replays', async () => {
    // duroxide 0.1.31 lists and prunes keys in key order (microsoft/duroxide#57). Before, both
    // used hash order, which differs between replays, so the replay of a prune that cleared
    // several keys failed with "nondeterministic: kv clear mismatch".
    const keys = ['k7', 'k3', 'k5', 'k1', 'k8', 'k2', 'k6', 'k4'];
    await withRuntime((runtime) => {
      runtime.registerOrchestration('KvKeyOrder', function* (ctx) {
        for (const key of keys) ctx.setValue(key, key);
        const listed = ctx.getKvAllKeys();
        // A cutoff after every write prunes all eight keys.
        const pruned = ctx.pruneKvValuesUpdatedBefore(Number.MAX_SAFE_INTEGER);
        // The next turn replays the writes and the prune, and must clear the keys in the
        // order this turn recorded.
        yield ctx.scheduleTimer(5);
        return { listed, pruned, after: ctx.getKvAllKeys() };
      });
    }, async (client) => {
      const instanceId = uid('kv-key-order');
      await client.startOrchestration(instanceId, 'KvKeyOrder', null);

      const status = await client.waitForOrchestration(instanceId, 5000);
      assert.strictEqual(status.status, 'Completed', `orchestration failed: ${status.error}`);
      assert.deepStrictEqual(status.output, {
        listed: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'],
        pruned: 8,
        after: [],
      });
    });
  });

  it('kv bulk snapshot and prune', async () => {
    await withRuntime((runtime) => {
      runtime.registerOrchestration('KvBulk', function* (ctx, input) {
        if (!input || input.phase !== 'prune') {
          ctx.setValue('old-a', '1');
          ctx.setValue('old-b', '2');
          yield ctx.continueAsNew({ phase: 'prune' });
          return;
        }

        assert.strictEqual(MAX_KV_KEYS, 150);
        assert.deepStrictEqual(ctx.getKvAllKeys().slice().sort(), ['old-a', 'old-b']);
        assert.strictEqual(ctx.getKvLength(), 2);
        assert.deepStrictEqual(sortObject(ctx.getKvAllValues()), {
          'old-a': '1',
          'old-b': '2',
        });

        const cutoffMs = yield ctx.utcNow();
        yield ctx.scheduleTimer(5);
        ctx.setValue('fresh', '3');

        const removed = ctx.pruneKvValuesUpdatedBefore(cutoffMs);
        assert.strictEqual(removed, 2);
        assert.deepStrictEqual(ctx.getKvAllKeys().slice().sort(), ['fresh']);
        assert.strictEqual(ctx.getKvLength(), 1);
        assert.deepStrictEqual(ctx.getKvAllValues(), { fresh: '3' });

        return 'bulk-ready';
      });
    }, async (client) => {
      const instanceId = uid('kv-bulk');
      await client.startOrchestration(instanceId, 'KvBulk', null);

      const status = await client.waitForOrchestration(instanceId, 5000);
      assert.strictEqual(status.status, 'Completed');
      assert.strictEqual(status.output, 'bulk-ready');
      assert.deepStrictEqual(await client.getKvAllValues(instanceId), { fresh: '3' });
      assert.strictEqual(await client.getValue(instanceId, 'fresh'), '3');
      assert.strictEqual(await client.getValue(instanceId, 'old-a'), null);
      assert.strictEqual(await client.getValue(instanceId, 'old-b'), null);
    });
  });

  it('kv read-modify-write counter', async () => {
    await withRuntime((runtime) => {
      runtime.registerActivity('ProcessBatch', async (_ctx, input) => {
        return `processed:${input}`;
      });

      runtime.registerOrchestration('BatchProcessor', function* (ctx) {
        const batches = ['alpha', 'beta', 'gamma'];

        for (const batchName of batches) {
          const processed = ctx.getValue('batches_processed') ?? '0';
          const count = Number.parseInt(processed, 10);

          const result = yield ctx.scheduleActivity('ProcessBatch', batchName);
          ctx.setValue('batches_processed', String(count + 1));
          ctx.setValue('last_result', result);
        }

        return ctx.getValue('batches_processed') ?? '0';
      });
    }, async (client) => {
      const instanceId = uid('batch-processor');
      await client.startOrchestration(instanceId, 'BatchProcessor', null);

      const status = await client.waitForOrchestration(instanceId, 5000);
      assert.strictEqual(status.status, 'Completed');
      assert.strictEqual(status.output, '3');
      assert.strictEqual(await client.getValue(instanceId, 'batches_processed'), '3');
      assert.strictEqual(await client.getValue(instanceId, 'last_result'), 'processed:gamma');
    });
  });

  it('kv cross orchestration read', async () => {
    await withRuntime((runtime) => {
      runtime.registerActivity('ComputeResult', async (_ctx, input) => {
        const n = Number(input);
        return String(n * n);
      });

      runtime.registerOrchestration('Producer', function* (ctx, input) {
        ctx.setValue('status', 'computing');

        const squared = yield ctx.scheduleActivity('ComputeResult', input);
        ctx.setValue('result', squared);
        ctx.setValue('status', 'done');

        yield ctx.waitForEvent('ack');
        return `produced:${squared}`;
      });

      runtime.registerOrchestration('Consumer', function* (ctx, producerId) {
        let attempts = 0;

        while (true) {
          const status = yield ctx.getValueFromInstance(producerId, 'status');
          if (status === 'done') {
            break;
          }

          attempts += 1;
          if (attempts > 20) {
            throw new Error('producer never finished');
          }

          yield ctx.scheduleTimer(100);
        }

        const result = yield ctx.getValueFromInstance(producerId, 'result');
        if (result == null) {
          throw new Error('result key missing');
        }

        return `consumed:${result}`;
      });
    }, async (client) => {
      const producerId = uid('producer-1');
      const consumerId = uid('consumer-1');

      await client.startOrchestration(producerId, 'Producer', 7);
      assert.strictEqual(await client.waitForValue(producerId, 'result', 5000), '49');

      await client.startOrchestration(consumerId, 'Consumer', producerId);
      const consumerStatus = await client.waitForOrchestration(consumerId, 10000);
      assert.strictEqual(consumerStatus.status, 'Completed');
      assert.strictEqual(consumerStatus.output, 'consumed:49');

      await client.raiseEvent(producerId, 'ack', '');
      const producerStatus = await client.waitForOrchestration(producerId, 5000);
      assert.strictEqual(producerStatus.status, 'Completed');
      assert.strictEqual(producerStatus.output, 'produced:49');

      assert.strictEqual(await client.getValue(producerId, 'result'), '49');
      assert.strictEqual(await client.getValue(producerId, 'status'), 'done');
    });
  });
});
