/**
 * Management / Admin API tests for duroxide Node.js SDK — PostgreSQL backend.
 *
 * Tests all client management APIs that were missing from the original binding:
 *   - listAllInstances / listInstancesByStatus
 *   - getInstanceInfo / getExecutionInfo
 *   - listExecutions / readExecutionHistory
 *   - getInstanceTree
 *   - deleteInstance / deleteInstanceBulk
 *   - pruneExecutions / pruneExecutionsBulk
 *   - Versioned orchestration context methods:
 *     - scheduleSubOrchestrationVersioned
 *     - startOrchestrationVersioned (detached, from ctx)
 *     - continueAsNewVersioned
 *
 * Requires: DATABASE_URL env var or .env file with a PostgreSQL connection string.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PostgresProvider, Client, Runtime } = require('../lib/duroxide.js');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCHEMA = 'duroxide_node_admin';

const RUN_ID = `adm${Date.now().toString(36)}`;
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

// Helper: run an orchestration to completion and return { client, result }
async function runToCompletion(orchName, input, setupFn, timeoutMs = 15_000) {
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
  setupFn(runtime);
  await runtime.start();

  try {
    const instanceId = uid(orchName);
    await client.startOrchestration(instanceId, orchName, input);
    const result = await client.waitForOrchestration(instanceId, timeoutMs);
    return { client, result, instanceId };
  } finally {
    await runtime.shutdown(100);
  }
}

// ─── 1. listAllInstances ─────────────────────────────────────────

describe('admin: listAllInstances', () => {
  it('returns instance IDs after starting orchestrations', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('echo', async (ctx, input) => input);
    runtime.registerOrchestration('ListTest', function* (ctx, input) {
      return yield ctx.scheduleActivity('echo', input);
    });

    await runtime.start();
    try {
      const id1 = uid('list-1');
      const id2 = uid('list-2');
      await client.startOrchestration(id1, 'ListTest', { a: 1 });
      await client.startOrchestration(id2, 'ListTest', { a: 2 });
      await client.waitForOrchestration(id1, 10000);
      await client.waitForOrchestration(id2, 10000);

      const instances = await client.listAllInstances();
      assert.ok(instances.includes(id1), `should contain ${id1}`);
      assert.ok(instances.includes(id2), `should contain ${id2}`);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 2. listInstancesByStatus ────────────────────────────────────

describe('admin: listInstancesByStatus', () => {
  it('filters by Completed status', async () => {
    const { client, instanceId } = await runToCompletion(
      'StatusFilter', 'hello',
      (rt) => {
        rt.registerActivity('echo', async (ctx, input) => input);
        rt.registerOrchestration('StatusFilter', function* (ctx, input) {
          return yield ctx.scheduleActivity('echo', input);
        });
      }
    );

    const completed = await client.listInstancesByStatus('Completed');
    assert.ok(completed.includes(instanceId), 'should list the completed instance');
  });
});

// ─── 3. getInstanceInfo ──────────────────────────────────────────

describe('admin: getInstanceInfo', () => {
  it('returns detailed instance metadata', async () => {
    const { client, instanceId } = await runToCompletion(
      'InfoTest', { x: 42 },
      (rt) => {
        rt.registerActivity('double', async (ctx, input) => input.x * 2);
        rt.registerOrchestration('InfoTest', function* (ctx, input) {
          return yield ctx.scheduleActivity('double', input);
        });
      }
    );

    const info = await client.getInstanceInfo(instanceId);
    assert.strictEqual(info.instanceId, instanceId);
    assert.strictEqual(info.orchestrationName, 'InfoTest');
    assert.strictEqual(info.status, 'Completed');
    assert.ok(info.currentExecutionId >= 1);
    assert.ok(info.createdAt > 0);
    assert.ok(info.updatedAt > 0);
  });
});

// ─── 4. getExecutionInfo ─────────────────────────────────────────

describe('admin: getExecutionInfo', () => {
  it('returns execution-level details', async () => {
    const { client, instanceId } = await runToCompletion(
      'ExecInfo', 'test',
      (rt) => {
        rt.registerActivity('echo', async (ctx, input) => input);
        rt.registerOrchestration('ExecInfo', function* (ctx, input) {
          return yield ctx.scheduleActivity('echo', input);
        });
      }
    );

    const info = await client.getExecutionInfo(instanceId, 1);
    assert.strictEqual(info.executionId, 1);
    assert.strictEqual(info.status, 'Completed');
    assert.ok(info.eventCount > 0, 'should have events');
    assert.ok(info.startedAt > 0);
  });
});

// ─── 5. listExecutions ───────────────────────────────────────────

describe('admin: listExecutions', () => {
  it('returns execution IDs for CAN workflows', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('count', async (ctx, input) => input);
    runtime.registerOrchestration('CANExec', function* (ctx, input) {
      const n = input.n || 0;
      if (n >= 2) {
        return { done: true, iterations: n };
      }
      return yield ctx.continueAsNew({ n: n + 1 });
    });

    await runtime.start();
    const instanceId = uid('can-exec');
    try {
      await client.startOrchestration(instanceId, 'CANExec', { n: 0 });
      await client.waitForOrchestration(instanceId, 15000);

      const executions = await client.listExecutions(instanceId);
      assert.ok(executions.length >= 3, `should have 3+ executions, got ${executions.length}`);
      assert.strictEqual(executions[0], 1);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 6. readExecutionHistory ─────────────────────────────────────

describe('admin: readExecutionHistory', () => {
  it('returns events for a specific execution', async () => {
    const { client, instanceId } = await runToCompletion(
      'HistoryTest', 'data',
      (rt) => {
        rt.registerActivity('echo', async (ctx, input) => input);
        rt.registerOrchestration('HistoryTest', function* (ctx, input) {
          return yield ctx.scheduleActivity('echo', input);
        });
      }
    );

    const events = await client.readExecutionHistory(instanceId, 1);
    assert.ok(events.length > 0, 'should have events');
    // First event should be OrchestrationStarted
    const firstEvent = events[0];
    assert.ok(firstEvent.kind.includes('OrchestrationStarted'), `first event should be OrchestrationStarted, got ${firstEvent.kind}`);
    assert.ok(firstEvent.timestampMs > 0);
  });

  it('includes data field with event-specific content', async () => {
    const { client, instanceId } = await runToCompletion(
      'HistoryDataTest', { greeting: 'hello' },
      (rt) => {
        rt.registerActivity('reverse', async (ctx, input) => ({ reversed: true, ...input }));
        rt.registerOrchestration('HistoryDataTest', function* (ctx, input) {
          return yield ctx.scheduleActivity('reverse', input);
        });
      }
    );

    const events = await client.readExecutionHistory(instanceId, 1);

    // OrchestrationStarted should have name, version, input
    const started = events.find(e => e.kind === 'OrchestrationStarted');
    assert.ok(started, 'should have OrchestrationStarted');
    assert.ok(started.data, 'OrchestrationStarted should have data');
    const startedData = JSON.parse(started.data);
    assert.strictEqual(startedData.name, 'HistoryDataTest');
    assert.deepStrictEqual(startedData.input, { greeting: 'hello' });

    // ActivityScheduled should have name and input
    const scheduled = events.find(e => e.kind === 'ActivityScheduled');
    assert.ok(scheduled, 'should have ActivityScheduled');
    assert.ok(scheduled.data, 'ActivityScheduled should have data');
    const scheduledData = JSON.parse(scheduled.data);
    assert.strictEqual(scheduledData.name, 'reverse');

    // ActivityCompleted should have the result
    const completed = events.find(e => e.kind === 'ActivityCompleted');
    assert.ok(completed, 'should have ActivityCompleted');
    assert.ok(completed.data, 'ActivityCompleted should have data');
    const completedData = JSON.parse(completed.data);
    assert.strictEqual(completedData.reversed, true);
    assert.strictEqual(completedData.greeting, 'hello');

    // OrchestrationCompleted should have output
    const orchCompleted = events.find(e => e.kind === 'OrchestrationCompleted');
    assert.ok(orchCompleted, 'should have OrchestrationCompleted');
    assert.ok(orchCompleted.data, 'OrchestrationCompleted should have data');
    const orchData = JSON.parse(orchCompleted.data);
    assert.strictEqual(orchData.reversed, true);
  });
});

// ─── 7. getInstanceTree ──────────────────────────────────────────

describe('admin: getInstanceTree', () => {
  it('returns the tree for a parent + child orchestration', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('echo', async (ctx, input) => input);
    runtime.registerOrchestration('Child', function* (ctx, input) {
      return yield ctx.scheduleActivity('echo', input);
    });
    runtime.registerOrchestration('Parent', function* (ctx, input) {
      const childResult = yield ctx.scheduleSubOrchestration('Child', input);
      return { parent: true, child: childResult };
    });

    await runtime.start();
    const instanceId = uid('tree-parent');
    try {
      await client.startOrchestration(instanceId, 'Parent', { val: 1 });
      const result = await client.waitForOrchestration(instanceId, 15000);
      assert.strictEqual(result.status, 'Completed');

      const tree = await client.getInstanceTree(instanceId);
      assert.strictEqual(tree.rootId, instanceId);
      assert.ok(tree.size >= 2, `tree should have ≥2 nodes, got ${tree.size}`);
      assert.ok(tree.allIds.includes(instanceId));
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 8. deleteInstance ───────────────────────────────────────────

describe('admin: deleteInstance', () => {
  it('deletes a completed instance and its data', async () => {
    const { client, instanceId } = await runToCompletion(
      'DeleteMe', 'bye',
      (rt) => {
        rt.registerActivity('echo', async (ctx, input) => input);
        rt.registerOrchestration('DeleteMe', function* (ctx, input) {
          return yield ctx.scheduleActivity('echo', input);
        });
      }
    );

    const result = await client.deleteInstance(instanceId, false);
    assert.ok(result.instancesDeleted >= 1, 'should delete at least 1 instance');
    assert.ok(result.eventsDeleted >= 1, 'should delete events');

    // Verify it's gone
    const status = await client.getStatus(instanceId);
    assert.strictEqual(status.status, 'NotFound');
  });
});

// ─── 9. deleteInstanceBulk ───────────────────────────────────────

describe('admin: deleteInstanceBulk', () => {
  it('bulk-deletes by instance ID list', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('echo', async (ctx, input) => input);
    runtime.registerOrchestration('BulkDel', function* (ctx, input) {
      return yield ctx.scheduleActivity('echo', input);
    });

    await runtime.start();
    const ids = [uid('bulk-1'), uid('bulk-2')];
    try {
      for (const id of ids) {
        await client.startOrchestration(id, 'BulkDel', { id });
      }
      for (const id of ids) {
        await client.waitForOrchestration(id, 10000);
      }
    } finally {
      await runtime.shutdown(100);
    }

    const result = await client.deleteInstanceBulk({ instanceIds: ids });
    assert.ok(result.instancesDeleted >= 2, `should delete 2+, got ${result.instancesDeleted}`);

    // Verify they're gone
    for (const id of ids) {
      const status = await client.getStatus(id);
      assert.strictEqual(status.status, 'NotFound');
    }
  });
});

// ─── 10. pruneExecutions ─────────────────────────────────────────

describe('admin: pruneExecutions', () => {
  it('prunes old executions from a CAN workflow (keep last 1)', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('PruneTarget', function* (ctx, input) {
      const n = input.n || 0;
      if (n >= 3) return { done: true, iterations: n };
      return yield ctx.continueAsNew({ n: n + 1 });
    });

    await runtime.start();
    const instanceId = uid('prune');
    try {
      await client.startOrchestration(instanceId, 'PruneTarget', { n: 0 });
      await client.waitForOrchestration(instanceId, 15000);
    } finally {
      await runtime.shutdown(100);
    }

    // Should have 4 executions (0,1,2,3)
    const beforeExecs = await client.listExecutions(instanceId);
    assert.ok(beforeExecs.length >= 4, `expected ≥4 executions, got ${beforeExecs.length}`);

    // Prune: keep last 1 (only the final execution)
    const result = await client.pruneExecutions(instanceId, { keepLast: 1 });
    assert.ok(result.executionsDeleted >= 3, `should prune ≥3, got ${result.executionsDeleted}`);

    const afterExecs = await client.listExecutions(instanceId);
    assert.strictEqual(afterExecs.length, 1, 'should have 1 execution left');
  });
});

// ─── 11. pruneExecutionsBulk ─────────────────────────────────────

describe('admin: pruneExecutionsBulk', () => {
  it('prunes executions across multiple CAN workflows', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerOrchestration('BulkPrune', function* (ctx, input) {
      const n = input.n || 0;
      if (n >= 2) return { done: true };
      return yield ctx.continueAsNew({ n: n + 1 });
    });

    await runtime.start();
    const ids = [uid('bprune-1'), uid('bprune-2')];
    try {
      for (const id of ids) {
        await client.startOrchestration(id, 'BulkPrune', { n: 0 });
      }
      for (const id of ids) {
        await client.waitForOrchestration(id, 15000);
      }
    } finally {
      await runtime.shutdown(100);
    }

    const result = await client.pruneExecutionsBulk(
      { instanceIds: ids },
      { keepLast: 1 }
    );
    assert.ok(result.instancesProcessed >= 2, `should process ≥2, got ${result.instancesProcessed}`);
    assert.ok(result.executionsDeleted >= 4, `should prune ≥4, got ${result.executionsDeleted}`);
  });
});

// ─── 12. Versioned sub-orchestration from ctx ────────────────────

describe('admin: versioned sub-orchestration', () => {
  it('schedules a versioned sub-orchestration', async () => {
    const { result } = await runToCompletion(
      'VersionedSubParent', { val: 10 },
      (rt) => {
        rt.registerActivity('double', async (ctx, input) => input * 2);
        rt.registerOrchestrationVersioned('VersionedChild', '2.0.0', function* (ctx, input) {
          const doubled = yield ctx.scheduleActivity('double', input.val);
          return { version: '2.0.0', result: doubled };
        });
        rt.registerOrchestration('VersionedSubParent', function* (ctx, input) {
          const child = yield ctx.scheduleSubOrchestrationVersioned('VersionedChild', '2.0.0', input);
          return { parent: true, child };
        });
      }
    );

    assert.strictEqual(result.status, 'Completed');
    assert.strictEqual(result.output.child.version, '2.0.0');
    assert.strictEqual(result.output.child.result, 20);
  });
});

// ─── 13. Versioned detached orchestration from ctx ───────────────

describe('admin: versioned detached orchestration', () => {
  it('starts a versioned detached orchestration from within an orchestration', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    runtime.registerActivity('echo', async (ctx, input) => input);
    runtime.registerOrchestrationVersioned('DetachedWorker', '3.0.0', function* (ctx, input) {
      const result = yield ctx.scheduleActivity('echo', input);
      return { version: '3.0.0', echoed: result };
    });
    runtime.registerOrchestration('DetachedStarter', function* (ctx, input) {
      yield ctx.startOrchestrationVersioned('DetachedWorker', '3.0.0', input.childId, { msg: 'hello' });
      return { started: true };
    });

    await runtime.start();
    const parentId = uid('detach-starter');
    const childId = uid('detach-worker');
    try {
      await client.startOrchestration(parentId, 'DetachedStarter', { childId });
      await client.waitForOrchestration(parentId, 15000);

      // Child should also complete
      const childResult = await client.waitForOrchestration(childId, 15000);
      assert.strictEqual(childResult.status, 'Completed');
      assert.strictEqual(childResult.output.version, '3.0.0');
      assert.strictEqual(childResult.output.echoed.msg, 'hello');
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 14. continueAsNewVersioned ──────────────────────────────────

describe('admin: continueAsNewVersioned', () => {
  it('continues as new to a specific version', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    // v1: upgrades to v2 via continueAsNewVersioned
    runtime.registerOrchestrationVersioned('VersionedCAN', '1.0.0', function* (ctx, input) {
      ctx.traceInfo('[v1.0.0] upgrading to v2');
      return yield ctx.continueAsNewVersioned({ upgraded: true, from: '1.0.0' }, '2.0.0');
    });

    // v2: the target version
    runtime.registerOrchestrationVersioned('VersionedCAN', '2.0.0', function* (ctx, input) {
      ctx.traceInfo('[v2.0.0] running upgraded logic');
      return { version: '2.0.0', input };
    });

    await runtime.start();
    const instanceId = uid('can-versioned');
    try {
      await client.startOrchestrationVersioned(instanceId, 'VersionedCAN', { start: true }, '1.0.0');
      const result = await client.waitForOrchestration(instanceId, 15000);
      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.version, '2.0.0');
      assert.strictEqual(result.output.input.upgraded, true);
    } finally {
      await runtime.shutdown(100);
    }
  });
});
