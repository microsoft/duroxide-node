/**
 * Activity tag routing tests for duroxide Node.js SDK.
 * Tests run against SQLite (no external database required).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SqliteProvider, Client, Runtime } = require('../lib/duroxide.js');

async function withSqlite(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duroxide-tags-'));
  const dbPath = `sqlite:${path.join(dir, 'tags.db')}`;
  const provider = await SqliteProvider.open(dbPath);
  try {
    await fn(provider);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 1. Basic tag scheduling ─────────────────────────────────────

describe('activity tags', () => {
  it('schedules activity with tag and ctx.tag() returns it', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        workerTagFilter: { defaultAnd: ['gpu'] },
      });

      runtime.registerActivity('GpuTask', async (ctx, input) => {
        const tag = ctx.tag();
        return { input, tag };
      });

      runtime.registerOrchestration('TagOrch', function* (ctx, input) {
        const result = yield ctx.scheduleActivity('GpuTask', input).withTag('gpu');
        return result;
      });

      await runtime.start();
      try {
        await client.startOrchestration('tag-1', 'TagOrch', 'data');
        const result = await client.waitForOrchestration('tag-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.deepStrictEqual(result.output, { input: 'data', tag: 'gpu' });
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('untagged activity has null tag', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

      runtime.registerActivity('Plain', async (ctx, input) => {
        return { tag: ctx.tag() };
      });

      runtime.registerOrchestration('NoTagOrch', function* (ctx) {
        return yield ctx.scheduleActivity('Plain', 'x');
      });

      await runtime.start();
      try {
        await client.startOrchestration('notag-1', 'NoTagOrch');
        const result = await client.waitForOrchestration('notag-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.deepStrictEqual(result.output, { tag: null });
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('withTag is chainable and returns the descriptor', async () => {
    await withSqlite(async (provider) => {
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
      runtime.registerOrchestration('ChainTest', function* (ctx) {
        const task = ctx.scheduleActivity('Noop', null);
        const chained = task.withTag('cpu');
        // withTag returns the same descriptor (chainable)
        assert.strictEqual(task, chained);
        assert.strictEqual(task.tag, 'cpu');
        return 'ok';
      });

      runtime.registerActivity('Noop', async () => null);

      const client = new Client(provider);
      await runtime.start();
      try {
        await client.startOrchestration('chain-1', 'ChainTest');
        const result = await client.waitForOrchestration('chain-1', 10000);
        assert.strictEqual(result.status, 'Completed');
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('workerTagFilter "any" processes all activities', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        workerTagFilter: 'any',
      });

      runtime.registerActivity('Work', async (ctx, input) => {
        return `done:${input}`;
      });

      runtime.registerOrchestration('AnyOrch', function* (ctx) {
        const r1 = yield ctx.scheduleActivity('Work', 'untagged');
        const r2 = yield ctx.scheduleActivity('Work', 'tagged').withTag('special');
        return `${r1},${r2}`;
      });

      await runtime.start();
      try {
        await client.startOrchestration('any-1', 'AnyOrch');
        const result = await client.waitForOrchestration('any-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.strictEqual(result.output, 'done:untagged,done:tagged');
      } finally {
        await runtime.shutdown(100);
      }
    });
  });
});
