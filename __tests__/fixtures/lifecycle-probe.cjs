// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { SqliteProvider, Runtime } = require('../../lib/duroxide.js');
const native = require(Object.keys(require.cache).find(file => file.endsWith('.node')));
const emit = (phase, detail = {}) => console.log('LIFECYCLE_PROBE ' + JSON.stringify({ phase, ...detail }));

async function main() {
  const scenario = process.argv[2];
  let runtime = new Runtime(await SqliteProvider.inMemory(), {
    dispatcherPollIntervalMs: 5, serviceName: 'lifecycle-private-sentinel',
  });
  if (scenario === 'registry-invalid' || scenario === 'registry-descending') {
    const versions = scenario === 'registry-invalid' ? ['not-semver'] : ['2.0.0', '1.0.0'];
    for (const version of versions) {
      runtime.registerOrchestrationVersioned('registry-private-sentinel', version, function* () { return 'ok'; });
    }
    let startMessage;
    await assert.rejects(runtime.start(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /lifecycle_start_failed/);
      assert.doesNotMatch(error.message, /sentinel|Panic in async function/);
      startMessage = error.message;
      return true;
    });
    for (const timeout of [0, 30_000]) {
      await assert.rejects(runtime.shutdown(timeout), error => {
        assert.equal(error.message, startMessage);
        return true;
      });
    }
    assert.equal(runtime.metricsSnapshot(), null);
    await assert.rejects(runtime.start(), /lifecycle_terminal/);
    assert.throws(() => runtime.registerActivity('late', async () => 'late'), /lifecycle_terminal/);
    assert.throws(() => runtime.registerOrchestration('late', function* () {}), /lifecycle_terminal/);
    assert.throws(() => runtime.registerOrchestrationVersioned('late', '3.0.0', function* () {}), /lifecycle_terminal/);
    globalThis.retainedRuntime = runtime;
    emit('REGISTRY_FAILURE_RETAINED', { scenario });
    return;
  }
  if (scenario === 'exit') {
    runtime.registerActivity('ExitActivity', async (_, value) => value);
    runtime.registerOrchestration('ExitFlow', function* () { return 'ok'; });
    await runtime.start();
    await runtime.shutdown(100);
    globalThis.retainedRuntime = runtime;
    emit('EXIT_READY');
    return;
  }
  const hooks = native._lifecycleTestHooks(runtime._native);
  hooks.hold('provider');
  await runtime.start();
  await hooks.waitEntered('provider');
  const input = createInterface({ input: process.stdin });
  const command = new Promise(resolve => input.once('line', resolve));
  emit('STOPPING');
  const start = performance.now();
  await assert.rejects(runtime.shutdown(scenario === 'late' ? undefined : 0), error => {
    assert.match(error.message, /lifecycle_shutdown_timed_out/);
    assert.match(error.message, /cleanup.*incomplete/);
    assert.match(error.message, /terminate the process/);
    assert.ok(!error.message.includes('sentinel'));
    return true;
  });
  const elapsedMs = performance.now() - start;
  const repeated = performance.now();
  await assert.rejects(runtime.shutdown(30_000), error => {
    assert.match(error.message, /lifecycle_shutdown_timed_out/);
    assert.ok(!error.message.includes('sentinel'));
    return true;
  });
  const repeatedMs = performance.now() - repeated;
  assert.ok(JSON.parse(hooks.snapshot()).active > 0);
  assert.equal(runtime.metricsSnapshot(), null);
  emit('TIMED_OUT', { elapsedMs, repeatedMs });
  if (await command === 'retain') {
    runtime = null;
    global.gc();
    const state = JSON.parse(hooks.snapshot());
    assert.ok(state.active > 0);
    assert.equal(state.coordinators, 1);
    emit('RETAINED');
    await new Promise(() => {});
  } else {
    hooks.release('provider');
    const deadline = performance.now() + 2000;
    while (true) {
      try { await runtime.shutdown(30_000); break; }
      catch (error) {
        assert.match(error.message, /lifecycle_shutdown_timed_out/);
        assert.ok(performance.now() < deadline);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    const state = JSON.parse(hooks.snapshot());
    assert.equal(state.active, 0);
    assert.equal(state.cleanupActive, 0);
    assert.equal(state.started, state.completed);
    assert.equal(state.coordinators, 1);
    assert.equal(state.forceRequests, 1);
    await assert.rejects(runtime.start(), /lifecycle_terminal/);
    emit('RECLAIMED');
    input.close();
  }
}

main().catch(error => {
  emit('FAILED', { error: error.stack });
  process.exitCode = 1;
});
