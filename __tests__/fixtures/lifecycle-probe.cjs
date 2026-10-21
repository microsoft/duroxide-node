// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { SqliteProvider, Runtime } = require('../../lib/duroxide.js');
const { nativeProvenance } = require('../../ci/smoke/native-provenance.cjs');
const { incompleteTimeout, retiredState } = require('../helpers/lifecycle-oracles.cjs');
const { native, provenance } = nativeProvenance(path.resolve(__dirname, '..', '..'), {
  instrumented: process.env.DUROXIDE_LIFECYCLE_TEST_HOOKS === '1',
  manifestPath: process.env.DUROXIDE_NATIVE_MANIFEST,
});
const emit = (phase, detail = {}) => console.log('LIFECYCLE_PROBE ' + JSON.stringify({ phase, ...detail }));
console.log('LIFECYCLE_NATIVE ' + JSON.stringify(provenance));

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
  hooks.hold('blocking-provider');
  runtime.registerActivity('PendingCleanupActivity', async (_, value) => value);
  await runtime.start();
  await hooks.waitEntered('blocking-provider');
  const standalone = scenario === 'incomplete-liveness';
  const input = standalone ? undefined : createInterface({ input: process.stdin });
  const command = input && new Promise(resolve => input.once('line', resolve));
  emit('STOPPING');
  const start = performance.now();
  await assert.rejects(runtime.shutdown(scenario === 'late' ? undefined : 0), incompleteTimeout);
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
  if (standalone) {
    globalThis.retainedRuntime = runtime;
    process.once('beforeExit', () => emit('PREMATURE_BEFORE_EXIT', { state: JSON.parse(hooks.snapshot()) }));
    let pulse = 0;
    setInterval(() => emit('ALIVE', { pulse: ++pulse, state: JSON.parse(hooks.snapshot()) }), 100).unref();
    return;
  }
  if (await command === 'retain') {
    runtime = null;
    global.gc();
    const state = JSON.parse(hooks.snapshot());
    assert.ok(state.active > 0);
    assert.equal(state.coordinators, 1);
    emit('RETAINED');
    await new Promise(() => {});
  } else {
    hooks.release('blocking-provider');
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
    retiredState(state, { forced: true, executionWitness: true });
    await assert.rejects(runtime.start(), /lifecycle_terminal/);
    emit('RECLAIMED');
    input.close();
  }
}

main().catch(error => {
  emit('FAILED', { error: error.stack });
  process.exitCode = 1;
});
