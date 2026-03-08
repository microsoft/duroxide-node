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
      const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        workerTagFilter: { defaultAnd: ['cpu'] },
      });
      runtime.registerOrchestration('ChainTest', function* (ctx) {
        const task = ctx.scheduleActivity('Echo', 'hello');
        const chained = task.withTag('cpu');
        // withTag returns the same descriptor (chainable)
        assert.strictEqual(task, chained);
        assert.strictEqual(task.tag, 'cpu');
        // Actually yield to execute the tagged activity e2e
        const result = yield chained;
        return result;
      });

      runtime.registerActivity('Echo', async (ctx, input) => `echo:${input}`);

      const client = new Client(provider);
      await runtime.start();
      try {
        await client.startOrchestration('chain-1', 'ChainTest');
        const result = await client.waitForOrchestration('chain-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.strictEqual(result.output, 'echo:hello');
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('defaultOnly rejects tagged activities (timer wins race)', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      // No workerTagFilter → defaults to DefaultOnly
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

      runtime.registerActivity('TaggedWork', async (ctx, input) => 'done');

      runtime.registerOrchestration('DefaultOnlyOrch', function* (ctx) {
        const activity = ctx.scheduleActivity('TaggedWork', 'data').withTag('gpu');
        const timer = ctx.scheduleTimer(500);
        const result = yield ctx.race(activity, timer);
        if (result.index === 1) {
          return 'timeout:no_gpu_worker';
        }
        return `completed:${result.value}`;
      });

      await runtime.start();
      try {
        await client.startOrchestration('default-only-1', 'DefaultOnlyOrch');
        const result = await client.waitForOrchestration('default-only-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.strictEqual(result.output, 'timeout:no_gpu_worker');
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('TagFilter values accepted by Runtime constructor', async () => {
    await withSqlite(async (provider) => {
      const filters = [
        'any',
        'none',
        'defaultOnly',
        { tags: ['gpu'] },
        { defaultAnd: ['gpu'] },
      ];
      for (const workerTagFilter of filters) {
        const runtime = new Runtime(provider, {
          dispatcherPollIntervalMs: 50,
          workerTagFilter,
        });
        // Constructed without throwing — register a no-op orch so start/shutdown are clean
        runtime.registerOrchestration(`Noop_${JSON.stringify(workerTagFilter)}`, function* () {});
        await runtime.start();
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

  it('heterogeneous workers: GPU render → CPU encode → untagged upload', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        workerTagFilter: { defaultAnd: ['gpu', 'cpu'] },
      });

      runtime.registerActivity('Render', async (ctx, input) => `rendered:${input}`);
      runtime.registerActivity('Encode', async (ctx, input) => `encoded:${input}`);
      runtime.registerActivity('Upload', async (ctx, input) => `uploaded:${input}`);

      runtime.registerOrchestration('VideoPipeline', function* (ctx) {
        const rendered = yield ctx.scheduleActivity('Render', 'frame42').withTag('gpu');
        const encoded = yield ctx.scheduleActivity('Encode', rendered).withTag('cpu');
        const uploaded = yield ctx.scheduleActivity('Upload', encoded);
        return uploaded;
      });

      await runtime.start();
      try {
        await client.startOrchestration('video-1', 'VideoPipeline');
        const result = await client.waitForOrchestration('video-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.strictEqual(result.output, 'uploaded:encoded:rendered:frame42');
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('starvation-safe: tagged activity races timer, falls back to CPU', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        workerTagFilter: 'defaultOnly',
      });

      runtime.registerActivity('GpuInference', async (ctx, input) => `inference:${input}`);
      runtime.registerActivity('CpuFallback', async (ctx, input) => `cpu_fallback:${input}`);

      runtime.registerOrchestration('InferenceWithFallback', function* (ctx, input) {
        const gpuTask = ctx.scheduleActivity('GpuInference', input).withTag('gpu');
        const timeout = ctx.scheduleTimer(500);
        const winner = yield ctx.race(gpuTask, timeout);
        if (winner.index === 0) {
          return winner.value;
        } else {
          // Timer won — no GPU worker, fall back to CPU
          const result = yield ctx.scheduleActivity('CpuFallback', input);
          return result;
        }
      });

      await runtime.start();
      try {
        await client.startOrchestration('infer-1', 'InferenceWithFallback', 'model-v3');
        const result = await client.waitForOrchestration('infer-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.strictEqual(result.output, 'cpu_fallback:model-v3');
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('dual runtime: orchestrator + GPU worker cooperate on same store', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);

      // Runtime A: orchestrator + default (CPU) worker
      const rtA = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        workerTagFilter: 'defaultOnly',
      });

      rtA.registerActivity('PreProcess', async (ctx, input) => `preprocessed:${input}`);
      rtA.registerActivity('GpuTrain', async (ctx, input) => `trained:${input}`);
      rtA.registerActivity('SaveModel', async (ctx, input) => `saved:${input}`);

      rtA.registerOrchestration('MLPipeline', function* (ctx, input) {
        const preprocessed = yield ctx.scheduleActivity('PreProcess', input);
        const model = yield ctx.scheduleActivity('GpuTrain', preprocessed).withTag('gpu');
        const saved = yield ctx.scheduleActivity('SaveModel', model);
        return saved;
      });

      // Runtime B: GPU worker only (no orchestration dispatcher)
      const rtB = new Runtime(provider, {
        dispatcherPollIntervalMs: 50,
        orchestrationConcurrency: 0,
        workerTagFilter: { tags: ['gpu'] },
      });

      rtB.registerActivity('PreProcess', async (ctx, input) => `preprocessed:${input}`);
      rtB.registerActivity('GpuTrain', async (ctx, input) => `trained:${input}`);
      rtB.registerActivity('SaveModel', async (ctx, input) => `saved:${input}`);

      rtB.registerOrchestration('MLPipeline', function* (ctx, input) {
        const preprocessed = yield ctx.scheduleActivity('PreProcess', input);
        const model = yield ctx.scheduleActivity('GpuTrain', preprocessed).withTag('gpu');
        const saved = yield ctx.scheduleActivity('SaveModel', model);
        return saved;
      });

      await rtA.start();
      await rtB.start();
      try {
        await client.startOrchestration('ml-1', 'MLPipeline', 'dataset-v5');
        const result = await client.waitForOrchestration('ml-1', 10000);
        assert.strictEqual(result.status, 'Completed');
        assert.strictEqual(result.output, 'saved:trained:preprocessed:dataset-v5');
      } finally {
        await rtB.shutdown(100);
        await rtA.shutdown(100);
      }
    });
  });

  it('nested function error handling: ? propagation through helper', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

      runtime.registerActivity('ProcessData', async (ctx, input) => {
        if (input.includes('error')) throw new Error('Processing failed');
        return `Processed: ${input}`;
      });
      runtime.registerActivity('FormatOutput', async (ctx, input) => `Final: ${input}`);

      runtime.registerOrchestration('NestedErrorHandling', function* (ctx, input) {
        const processed = yield ctx.scheduleActivity('ProcessData', input);
        const formatted = yield ctx.scheduleActivity('FormatOutput', processed);
        return formatted;
      });

      await runtime.start();
      try {
        // Success case
        await client.startOrchestration('nested-ok', 'NestedErrorHandling', 'test');
        const ok = await client.waitForOrchestration('nested-ok', 5000);
        assert.strictEqual(ok.status, 'Completed');
        assert.strictEqual(ok.output, 'Final: Processed: test');

        // Error case
        await client.startOrchestration('nested-err', 'NestedErrorHandling', 'error');
        const err = await client.waitForOrchestration('nested-err', 5000);
        assert.strictEqual(err.status, 'Failed');
        assert.ok(err.error.includes('Processing failed'));
      } finally {
        await runtime.shutdown(100);
      }
    });
  });

  it('error recovery: catches activity error and logs before failing', async () => {
    await withSqlite(async (provider) => {
      const client = new Client(provider);
      const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

      runtime.registerActivity('ProcessData', async (ctx, input) => {
        if (input.includes('error')) throw new Error('Processing failed');
        return `Processed: ${input}`;
      });
      runtime.registerActivity('LogError', async (ctx, error) => `Logged: ${error}`);

      runtime.registerOrchestration('ErrorRecovery', function* (ctx, input) {
        try {
          const result = yield ctx.scheduleActivity('ProcessData', input);
          return result;
        } catch (e) {
          yield ctx.scheduleActivity('LogError', e.message || String(e));
          throw new Error(`Failed to process '${input}': ${e.message || e}`);
        }
      });

      await runtime.start();
      try {
        // Success case
        await client.startOrchestration('recovery-ok', 'ErrorRecovery', 'test');
        const ok = await client.waitForOrchestration('recovery-ok', 5000);
        assert.strictEqual(ok.status, 'Completed');
        assert.strictEqual(ok.output, 'Processed: test');

        // Error recovery case
        await client.startOrchestration('recovery-err', 'ErrorRecovery', 'error');
        const err = await client.waitForOrchestration('recovery-err', 5000);
        assert.strictEqual(err.status, 'Failed');
        assert.ok(err.error.includes("Failed to process 'error'"));
      } finally {
        await runtime.shutdown(100);
      }
    });
  });
});
