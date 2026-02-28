/**
 * Typed convenience API tests for duroxide Node.js SDK.
 * Covers all typed methods on OrchestrationContext and Client.
 * Uses SqliteProvider.inMemory() for fast, self-contained tests.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SqliteProvider, Client, Runtime } = require('../lib/duroxide.js');

const RUN_ID = `ta${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

async function runTypedTest(name, input, setupFn, timeoutMs = 10_000) {
  const provider = await SqliteProvider.inMemory();
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

  setupFn(runtime, client);
  await runtime.start();

  try {
    const instanceId = uid(name);
    await client.startOrchestration(instanceId, name, input);
    return await client.waitForOrchestration(instanceId, timeoutMs);
  } finally {
    await runtime.shutdown(100);
  }
}

// === TYPED ORCHESTRATION CONTEXT METHODS ===

describe('typed convenience APIs', () => {

  // 1. scheduleActivityOnSessionTyped
  it('typed activity on session round trip', async () => {
    const result = await runTypedTest('SessionTypedAdd', { a: 2, b: 3 }, (rt) => {
      rt.registerActivityTyped('Add', async (ctx, input) => ({ sum: input.a + input.b }));
      rt.registerOrchestrationTyped('SessionTypedAdd', function* (ctx, input) {
        const r = yield ctx.scheduleActivityOnSessionTyped('Add', input, 'sess-1');
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.deepStrictEqual(result.output, { sum: 5 });
  });

  // 2. scheduleActivityWithRetryTyped
  it('typed activity with retry', async () => {
    let attempts = 0;
    const result = await runTypedTest('RetryTyped', { x: 1 }, (rt) => {
      rt.registerActivityTyped('Flaky', async (ctx, input) => {
        attempts++;
        if (attempts < 2) throw new Error('transient');
        return { result: 42 };
      });
      rt.registerOrchestrationTyped('RetryTyped', function* (ctx, input) {
        const r = yield ctx.scheduleActivityWithRetryTyped('Flaky', input, { maxAttempts: 3 });
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.deepStrictEqual(result.output, { result: 42 });
    assert.ok(attempts >= 2, 'should have retried at least once');
  });

  // 3. scheduleActivityWithRetryOnSessionTyped
  it('typed activity with retry on session', async () => {
    let attempts = 0;
    const result = await runTypedTest('RetrySessionTyped', { v: 1 }, (rt) => {
      rt.registerActivityTyped('SessionFlaky', async (ctx, input) => {
        attempts++;
        if (attempts < 2) throw new Error('transient');
        return { ok: true, v: input.v };
      });
      rt.registerOrchestrationTyped('RetrySessionTyped', function* (ctx, input) {
        const r = yield ctx.scheduleActivityWithRetryOnSessionTyped('SessionFlaky', input, { maxAttempts: 3 }, 'sess-retry');
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.deepStrictEqual(result.output, { ok: true, v: 1 });
    assert.ok(attempts >= 2);
  });

  // 4. waitForEventTyped
  it('typed wait for event', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestrationTyped('WaitEventTyped', function* (ctx) {
      const data = yield ctx.waitForEventTyped('Ready');
      return data;
    });

    await runtime.start();
    try {
      const instanceId = uid('WaitEventTyped');
      await client.startOrchestration(instanceId, 'WaitEventTyped', null);
      await new Promise((r) => setTimeout(r, 500));
      await client.raiseEvent(instanceId, 'Ready', { ok: true });
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      assert.deepStrictEqual(result.output, { ok: true });
    } finally {
      await runtime.shutdown(100);
    }
  });

  // 5. dequeueEventTyped
  it('typed dequeue event', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestrationTyped('DequeueTyped', function* (ctx) {
      const msg = yield ctx.dequeueEventTyped('inbox');
      return msg;
    });

    const instanceId = uid('DequeueTyped');
    await client.startOrchestration(instanceId, 'DequeueTyped', null);
    await client.enqueueEvent(instanceId, 'inbox', { msg: 'hello' });

    await runtime.start();
    try {
      const result = await client.waitForOrchestration(instanceId, 10_000);
      assert.strictEqual(result.status, 'Completed');
      assert.deepStrictEqual(result.output, { msg: 'hello' });
    } finally {
      await runtime.shutdown(100);
    }
  });

  // 6. scheduleSubOrchestrationWithIdTyped
  it('typed sub-orchestration with explicit id', async () => {
    const result = await runTypedTest('ParentSubIdTyped', { n: 99 }, (rt) => {
      rt.registerOrchestrationTyped('ChildIdTyped', function* (ctx, input) {
        return { computed: input.n };
      });
      rt.registerOrchestrationTyped('ParentSubIdTyped', function* (ctx, input) {
        const r = yield ctx.scheduleSubOrchestrationWithIdTyped('ChildIdTyped', uid('child-123'), input);
        return r;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.deepStrictEqual(result.output, { computed: 99 });
  });

  // 7. startOrchestrationTyped (fire-and-forget)
  it('typed detached orchestration', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestrationTyped('Worker', function* (ctx, input) {
      return { done: true, task: input.task };
    });
    runtime.registerOrchestrationTyped('Launcher', function* (ctx) {
      yield ctx.startOrchestrationTyped('Worker', uid('detached-1'), { task: 'go' });
      return 'launched';
    });

    await runtime.start();
    try {
      const parentId = uid('Launcher');
      await client.startOrchestration(parentId, 'Launcher', null);
      const parentResult = await client.waitForOrchestration(parentId, 10_000);
      assert.strictEqual(parentResult.status, 'Completed');
      assert.strictEqual(parentResult.output, 'launched');

      const childResult = await client.waitForOrchestration(uid('detached-1'), 10_000);
      assert.strictEqual(childResult.status, 'Completed');
      assert.deepStrictEqual(childResult.output, { done: true, task: 'go' });
    } finally {
      await runtime.shutdown(100);
    }
  });

  // 8. continueAsNewTyped
  it('typed continue as new', async () => {
    const result = await runTypedTest('CanTyped', { counter: 0 }, (rt) => {
      rt.registerOrchestrationTyped('CanTyped', function* (ctx, input) {
        if (input.counter < 3) {
          yield ctx.continueAsNewTyped({ counter: input.counter + 1 });
          return null; // unreachable
        }
        return { final: input.counter };
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.deepStrictEqual(result.output, { final: 3 });
  });

  // 9. Client typed start and wait
  it('typed client start and wait', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestrationTyped('Echo', function* (ctx, input) {
      return input;
    });

    await runtime.start();
    try {
      const instanceId = uid('ClientTyped');
      await client.startOrchestrationTyped(instanceId, 'Echo', { echo: 'ping' });
      const output = await client.waitForOrchestrationTyped(instanceId);
      assert.deepStrictEqual(output, { echo: 'ping' });
    } finally {
      await runtime.shutdown(100);
    }
  });

  // 10. Client typed events
  it('typed client events', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestrationTyped('EventReceiver', function* (ctx) {
      const evt = yield ctx.waitForEventTyped('Evt');
      const q = yield ctx.dequeueEventTyped('Q');
      return { evt, q };
    });

    const instanceId = uid('EventReceiver');
    await client.startOrchestrationTyped(instanceId, 'EventReceiver', null);

    // Enqueue the queue event before starting runtime so it's ready
    await client.enqueueEventTyped(instanceId, 'Q', { typed: true });

    await runtime.start();
    try {
      // Give orchestration time to reach waitForEvent
      await new Promise((r) => setTimeout(r, 500));
      await client.raiseEventTyped(instanceId, 'Evt', { typed: true });
      const output = await client.waitForOrchestrationTyped(instanceId);
      assert.deepStrictEqual(output, { evt: { typed: true }, q: { typed: true } });
    } finally {
      await runtime.shutdown(100);
    }
  });

  // 11. Typed versioned orchestration paths
  it('typed versioned start paths', async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestrationVersionedTyped('VersionedWorker', '1.0.0', function* (ctx, input) {
      return { done: true, task: input.task, version: 'v1' };
    });

    runtime.registerOrchestrationTyped('VersionedLauncher', function* (ctx) {
      yield ctx.startOrchestrationVersionedTyped('VersionedWorker', '1.0.0', uid('detached-v1'), { task: 'go-v1' });
      return 'launched-v1';
    });

    await runtime.start();
    try {
      const parentId = uid('VersionedLauncher');
      await client.startOrchestration(parentId, 'VersionedLauncher', null);
      const parentResult = await client.waitForOrchestration(parentId, 10_000);
      assert.strictEqual(parentResult.status, 'Completed');
      assert.strictEqual(parentResult.output, 'launched-v1');

      const detachedResult = await client.waitForOrchestration(uid('detached-v1'), 10_000);
      assert.strictEqual(detachedResult.status, 'Completed');
      assert.deepStrictEqual(detachedResult.output, { done: true, task: 'go-v1', version: 'v1' });

      const directId = uid('ClientVersionedTyped');
      await client.startOrchestrationVersionedTyped(directId, 'VersionedWorker', { task: 'direct-v1' }, '1.0.0');
      const directOutput = await client.waitForOrchestrationTyped(directId);
      assert.deepStrictEqual(directOutput, { done: true, task: 'direct-v1', version: 'v1' });
    } finally {
      await runtime.shutdown(100);
    }
  });
});
