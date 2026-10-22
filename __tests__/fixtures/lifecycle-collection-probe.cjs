// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setImmediate: nextTurn, setTimeout: delay } = require('node:timers/promises');
const { SqliteProvider, Runtime } = require('../../lib/duroxide.js');
const { nativeProvenance } = require('../../ci/smoke/native-provenance.cjs');
const { incompleteTimeout, knownQuiescentCoreFailure, retiredState } = require('../helpers/lifecycle-oracles.cjs');

const { native, provenance } = nativeProvenance(path.resolve(__dirname, '..', '..'), {
  instrumented: process.env.DUROXIDE_LIFECYCLE_TEST_HOOKS === '1',
  manifestPath: process.env.DUROXIDE_NATIVE_MANIFEST,
});
const finalized = new Set();
const registry = new FinalizationRegistry(label => finalized.add(label));
const emit = (phase, detail) => console.log('LIFECYCLE_PROBE ' + JSON.stringify({ phase, ...detail }));

function capturingActivity(owner) {
  return async (_, input) => `${owner.prefix}:${input}`;
}

function noncapturingActivity() {
  return async (_, input) => input;
}

async function createOwner(label, scenario, captures) {
  const runtime = new Runtime(await SqliteProvider.inMemory(), { dispatcherPollIntervalMs: 5 });
  const owner = { runtime, prefix: label };
  const callback = captures ? capturingActivity(owner) : noncapturingActivity();
  const records = {};
  for (const [name, value] of Object.entries({ owner, runtime, native: runtime._native, callback })) {
    const key = `${label}:${name}`;
    registry.register(value, key);
    records[name] = { label: key, weak: new WeakRef(value) };
  }
  // Activity-only registration excludes the pre-existing global orchestration map.
  runtime.registerActivity(`Collection${label}`, callback);
  const hooks = scenario === 'completed' ? undefined : native._lifecycleTestHooks(runtime._native);
  if (scenario === 'quiescent-failure') {
    hooks.hold('worker');
    hooks.fail('worker', 'collection-private-sentinel');
  } else if (scenario.startsWith('late')) {
    hooks.hold('blocking-provider');
  }
  await runtime.start();
  if (scenario === 'quiescent-failure') {
    try { await hooks.waitEntered('worker'); }
    finally { hooks.release('worker'); }
    await assert.rejects(runtime.shutdown(100), knownQuiescentCoreFailure);
    await assert.rejects(runtime.shutdown(30_000), knownQuiescentCoreFailure);
    retiredState(JSON.parse(hooks.snapshot()), { rollback: true, executionWitness: true });
  } else if (scenario.startsWith('late')) {
    await hooks.waitEntered('blocking-provider');
    await assert.rejects(runtime.shutdown(0), incompleteTimeout);
    await assert.rejects(runtime.shutdown(30_000), incompleteTimeout);
    assert.ok(JSON.parse(hooks.snapshot()).active > 0);
  } else {
    await runtime.shutdown(100);
    await runtime.shutdown(0);
  }
  assert.equal(runtime.metricsSnapshot(), null);
  // Rejected async start calls can retain napi-rs receiver references. Terminal
  // rejection has separate tests and must not contaminate this collection control.
  return { records, hooks };
}

function observations(records) {
  return Object.fromEntries(Object.entries(records).map(([name, record]) => [name, {
    weakGone: record.weak.deref() === undefined,
    finalized: finalized.has(record.label),
  }]));
}

function collected(state) {
  return Object.values(state).every(value => value.weakGone && value.finalized);
}

async function settle(control, captured, milliseconds = 3000) {
  const deadline = performance.now() + milliseconds;
  let state;
  let cycles = 0;
  do {
    // A dereferenced WeakRef is kept alive until the end of that JS job.
    await nextTurn();
    global.gc();
    await delay(20);
    state = { control: observations(control), captured: observations(captured) };
    cycles++;
    if (collected(state.control) && collected(state.captured)) break;
  } while (performance.now() < deadline);
  return { ...state, cycles };
}

async function observeLateCompletion(runtimeRef) {
  const runtime = runtimeRef.deref();
  assert.ok(runtime, 'incomplete native ownership must keep its self-capturing Runtime alive');
  const deadline = performance.now() + 2000;
  while (true) {
    try { await runtime.shutdown(30_000); break; }
    catch (error) {
      incompleteTimeout(error);
      assert.ok(performance.now() < deadline, 'late cleanup did not complete');
      await delay(1);
    }
  }
  assert.equal(await runtime.shutdown(0), undefined);
  assert.equal(runtime.metricsSnapshot(), null);
}

async function main() {
  assert.equal(typeof global.gc, 'function', 'collection probe requires --expose-gc');
  const requested = process.argv[2];
  const scenario = requested === 'baseline' ? 'completed' : requested;
  assert.ok(['completed', 'quiescent-failure', 'late', 'late-unobserved'].includes(scenario));
  const [control, captured] = await Promise.all([
    createOwner('Control', 'completed', false),
    createOwner('Captured', scenario, true),
  ]);
  let retainedWhileIncomplete;
  if (scenario.startsWith('late')) {
    const pending = await settle(control.records, captured.records, 300);
    retainedWhileIncomplete = Object.values(pending.captured).every(value => !value.weakGone && !value.finalized);
    assert.ok(retainedWhileIncomplete, JSON.stringify(pending));
    assert.ok(JSON.parse(captured.hooks.snapshot()).active > 0);
    captured.hooks.release('blocking-provider');
    if (scenario === 'late') await observeLateCompletion(captured.records.runtime.weak);
  }
  // Only WeakRefs and non-owning test controls survive the creating/observing frames.
  const state = await settle(control.records, captured.records);
  if (scenario.startsWith('late')) {
    retiredState(JSON.parse(captured.hooks.snapshot()), { forced: true, executionWitness: true });
  }
  const result = {
    scenario: requested, native: provenance, ...state,
    controlCollected: collected(state.control),
    capturedCollected: collected(state.captured),
    retainedWhileIncomplete,
  };
  assert.ok(result.controlCollected, `noncapturing control did not collect: ${JSON.stringify(result)}`);
  if (requested !== 'baseline') assert.ok(result.capturedCollected, `self-capturing owner did not collect: ${JSON.stringify(result)}`);
  emit('COLLECTION', result);
}

main().catch(error => {
  emit('FAILED', { error: error.stack });
  process.exitCode = 1;
});
