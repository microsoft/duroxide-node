// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { SqliteProvider, Client, Runtime } = require('../lib/duroxide.js');
const { nativeProvenance } = require('../ci/smoke/native-provenance.cjs');
const { startProbe } = require('./helpers/lifecycle-probe.cjs');
const {
  diagnostic, knownQuiescentCoreFailure, retiredState,
  shutdownTiming, assertShutdownTiming, orderedRaceAttempt,
} = require('./helpers/lifecycle-oracles.cjs');

const root = path.resolve(__dirname, '..');
const instrumented = process.env.DUROXIDE_LIFECYCLE_TEST_HOOKS === '1';
const { native, provenance } = nativeProvenance(root, {
  instrumented, manifestPath: process.env.DUROXIDE_NATIVE_MANIFEST,
});
const SECRET = 'Password=lifecycle-secret-sentinel;Host=private-sentinel';
const MAX_GRACE_MS = Number(((2n ** 64n) - 1n) / 1_000_000n) - 5000;

const hookTest = (name, body) => test(`[instrumented] ${name}`, { skip: !instrumented }, body);
const record = (name, value) => console.log(`${name} ${Buffer.from(JSON.stringify(value)).toString('base64')}`);

async function fixture(options) {
  const provider = await SqliteProvider.inMemory();
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 5, ...options });
  return { provider, runtime, hooks: instrumented ? native._lifecycleTestHooks(runtime._native) : null };
}

function retired(hooks, options) {
  retiredState(JSON.parse(hooks.snapshot()), options);
}

test('native provenance and production export boundary', () => {
  console.log('LIFECYCLE_NATIVE ' + JSON.stringify(provenance));
  record('LIFECYCLE_NATIVE_RECORD', provenance);
});

test('invalid durations preserve registration, startup, and repeated-stop ownership', async () => {
  const { runtime, hooks } = await fixture();
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, MAX_GRACE_MS + 1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runtime.shutdown(value), diagnostic('lifecycle_invalid_timeout'));
  }
  runtime.registerOrchestration('LifecycleInvalidInput', function* () { return 'ok'; });
  await runtime.start();
  assert.notEqual(runtime.metricsSnapshot(), null);
  await assert.rejects(runtime.shutdown(-1), diagnostic('lifecycle_invalid_timeout'));
  assert.notEqual(runtime.metricsSnapshot(), null);
  assert.equal(await runtime.shutdown(0), undefined);
  assert.equal(runtime.metricsSnapshot(), null);
  await assert.rejects(runtime.shutdown(Number.MAX_SAFE_INTEGER), diagnostic('lifecycle_invalid_timeout'));
  assert.equal(await runtime.shutdown(), undefined);
  if (hooks) retired(hooks);
});

test('direct-native negative integers do not consume registered work or stop ownership', async () => {
  const { runtime, provider, hooks } = await fixture();
  const client = new Client(provider);
  runtime.registerActivity('NativeNegativeActivity', async (_, input) => `original:${input}`);
  runtime.registerOrchestration('NativeNegativeFlow', function* (context, input) {
    return yield context.scheduleActivity('NativeNegativeActivity', input);
  });
  const rejectsNative = value => assert.rejects(
    async () => runtime._native.shutdown(value), diagnostic('lifecycle_invalid_timeout'));
  for (const value of [-1, -1000, -Number.MAX_SAFE_INTEGER]) await rejectsNative(value);
  await runtime.start();
  try {
    await rejectsNative(-1);
    assert.notEqual(runtime.metricsSnapshot(), null);
    await client.startOrchestration('native-negative-first', 'NativeNegativeFlow', 'before-stop');
    const result = await client.waitForOrchestration('native-negative-first', 5000);
    assert.equal(result.status, 'Completed');
    assert.equal(result.output, 'original:before-stop');
  } finally { await runtime.shutdown(100); }
  await rejectsNative(-1);
  assert.equal(await runtime._native.shutdown(0), undefined);
  assert.equal(await runtime.shutdown(), undefined);
  if (hooks) retired(hooks, { executionWitness: true });
});

test('maximum representable default-total boundary is checked on no-work and repeated stop', async () => {
  const { runtime } = await fixture();
  assert.equal(await runtime.shutdown(MAX_GRACE_MS), undefined);
  await assert.rejects(runtime.shutdown(MAX_GRACE_MS + 1), diagnostic('lifecycle_invalid_timeout'));
  assert.equal(await runtime.shutdown(), undefined);
});

test('pre-start shutdown is a terminal no-work success', async () => {
  const { runtime } = await fixture();
  assert.equal(await runtime.shutdown(0), undefined);
  assert.equal(await runtime.shutdown(), undefined);
  await assert.rejects(runtime.start(), diagnostic('lifecycle_terminal'));
  assert.throws(() => runtime.registerActivity('late', async () => 'late'), /lifecycle_terminal/);
  assert.throws(() => runtime.registerOrchestration('late', function* () {}), /lifecycle_terminal/);
  assert.throws(() => runtime.registerOrchestrationVersioned('late', '1.0.0', function* () {}), /lifecycle_terminal/);
  assert.equal(runtime.metricsSnapshot(), null);
});

for (const typed of [false, true]) {
  test(`rejected ${typed ? 'typed' : 'raw'} registrations cannot replace live handlers or shadow plain fallback`, async () => {
    const { runtime: live, provider } = await fixture();
    const terminal = new Runtime(provider);
    const client = new Client(provider);
    const suffix = typed ? 'Typed' : 'Raw';
    const plain = `RegistrationOriginal${suffix}`;
    const versioned = `RegistrationVersioned${suffix}`;
    const fallback = `RegistrationFallback${suffix}`;
    const register = typed ? 'registerOrchestrationTyped' : 'registerOrchestration';
    const registerVersioned = typed ? 'registerOrchestrationVersionedTyped' : 'registerOrchestrationVersioned';
    live[register](plain, function* (_, input) { return `plain:${input}`; });
    live[registerVersioned](versioned, '1.0.0', function* (_, input) { return `versioned:${input}`; });
    live[register](fallback, function* (_, input) { return `fallback:${input}`; });
    await terminal.shutdown(0);
    await live.start();
    try {
      const replacement = function* () { return 'rejected-replacement'; };
      assert.throws(() => terminal[register](plain, replacement), /lifecycle_terminal/);
      assert.throws(() => terminal[registerVersioned](versioned, '1.0.0', replacement), /lifecycle_terminal/);
      assert.throws(() => terminal[registerVersioned](fallback, '1.0.0', replacement), /lifecycle_terminal/);
      for (const [name, expected, version] of [
        [plain, 'plain:fresh', undefined],
        [versioned, 'versioned:fresh', '1.0.0'],
        [fallback, 'fallback:fresh', '1.0.0'],
      ]) {
        const id = `rejected-registration-${name}`;
        if (version) await client.startOrchestrationVersioned(id, name, 'fresh', version);
        else await client.startOrchestration(id, name, 'fresh');
        const result = await client.waitForOrchestration(id, 5000);
        assert.equal(result.status, 'Completed');
        assert.equal(result.output, expected, `${name} must resolve its original handler after rejection`);
      }
    } finally {
      await live.shutdown(100);
      await terminal.shutdown(0);
    }
  });
}

test('fallible preparation rejects invalid options without an escaping panic', async () => {
  const { runtime } = await fixture({ sessionIdleTimeoutMs: 0 });
  await assert.rejects(runtime.start(), diagnostic('lifecycle_start_failed'));
  await assert.rejects(runtime.shutdown(0), diagnostic('lifecycle_start_failed'));
  await assert.rejects(runtime.start(), diagnostic('lifecycle_terminal'));
  assert.equal(runtime.metricsSnapshot(), null);
});

for (const scenario of ['registry-invalid', 'registry-descending']) {
  test(`pre-core startup failure is ordinary and retained: ${scenario}`, async () => {
    const probe = startProbe(scenario);
    try {
      await probe.successfulExit(5000);
      assert.ok(probe.messages.some(message => message.phase === 'REGISTRY_FAILURE_RETAINED'), probe.describe());
    } finally { await probe.dispose(); }
  });
}

test('ascending and duplicate version registration keep their existing successful startup policy', async () => {
  const { runtime } = await fixture();
  for (const version of ['1.0.0', '1.0.0', '2.0.0']) {
    runtime.registerOrchestrationVersioned('LifecycleVersionPolicy', version, function* () { return 'ok'; });
  }
  assert.equal(await runtime.start(), undefined);
  assert.equal(await runtime.shutdown(100), undefined);
  assert.equal(await runtime.shutdown(0), undefined);
});

test('idle shutdown short-circuits long grace and preserves successful shapes', async () => {
  const { runtime, hooks } = await fixture();
  await runtime.start();
  const start = performance.now();
  assert.equal(await runtime.shutdown(30_000), undefined);
  assert.ok(performance.now() - start < 2000);
  assert.equal(await runtime.shutdown(0), undefined);
  await assert.rejects(runtime.start(), diagnostic('lifecycle_terminal'));
  if (hooks) retired(hooks, { forced: false });
});

test('SQLite public work and independent provider/client lifetimes survive worker shutdown', async () => {
  const { runtime, provider, hooks } = await fixture();
  const client = new Client(provider);
  runtime.registerActivity('LifecycleEcho', async (_, input) => input);
  runtime.registerOrchestration('LifecycleEchoFlow', function* (context, input) {
    return yield context.scheduleActivity('LifecycleEcho', input);
  });
  await runtime.start();
  try {
    await client.startOrchestration('lifecycle-echo', 'LifecycleEchoFlow', 'hello');
    const result = await client.waitForOrchestration('lifecycle-echo', 5000);
    assert.equal(result.status, 'Completed');
    assert.equal(result.output, 'hello');
  } finally {
    await runtime.shutdown(100);
  }
  if (hooks) retired(hooks, { executionWitness: true });
  assert.equal((await client.waitForOrchestration('lifecycle-echo', 5000)).output, 'hello');
  const replacement = new Runtime(provider);
  replacement.registerOrchestration('LifecycleIndependentProvider', function* (_, input) { return input; });
  await replacement.start();
  try {
    await client.startOrchestration('lifecycle-replacement', 'LifecycleIndependentProvider', 'still-open');
    const result = await client.waitForOrchestration('lifecycle-replacement', 5000);
    assert.equal(result.status, 'Completed');
    assert.equal(result.output, 'still-open');
  } finally { await replacement.shutdown(100); }
});

for (const typed of [false, true]) {
  test(`SQLite ${typed ? 'typed' : 'raw'} races preserve failures, values, and shutdown`, async () => {
    const { runtime, provider, hooks } = await fixture();
    const client = new Client(provider);
    runtime.registerActivity('LifecycleRaceFail', async () => { throw new Error('race-failure'); });
    runtime.registerActivity('LifecycleRaceValue', async () => ({ err: 'data', ok: true }));
    runtime.registerOrchestration('LifecycleRaceFlow', function* (context) {
      const schedule = (typed ? context.scheduleActivityTyped : context.scheduleActivity).bind(context);
      const race = (typed ? context.raceTyped : context.race).bind(context);
      let direct;
      try {
        yield schedule('LifecycleRaceFail', null);
      } catch (error) {
        direct = { type: error.constructor.name, message: error.message };
      }
      let raced;
      try {
        yield race(context.scheduleTimer(60_000), schedule('LifecycleRaceFail', null));
      } catch (error) {
        raced = { type: error.constructor.name, message: error.message };
      }
      const winner = yield race(schedule('LifecycleRaceValue', null), context.scheduleTimer(60_000));
      return { direct, raced, winner };
    });
    await runtime.start();
    try {
      await client.startOrchestration('lifecycle-race', 'LifecycleRaceFlow', null);
      const result = await client.waitForOrchestration('lifecycle-race', 5000);
      assert.equal(result.status, 'Completed');
      assert.equal(result.output.direct.type, 'Error');
      assert.match(result.output.direct.message, /race-failure/);
      assert.deepEqual(result.output.raced, result.output.direct);
      assert.deepEqual(result.output.winner, { index: 0, value: { err: 'data', ok: true } });
    } finally {
      await runtime.shutdown(100);
    }
    assert.equal(await runtime.shutdown(0), undefined);
    if (hooks) retired(hooks, { executionWitness: true });
  });
}

hookTest('partial-startup failure retains descendants until actual rollback', async () => {
  const { runtime, hooks } = await fixture();
  hooks.hold('partial-startup');
  hooks.hold('blocking-provider');
  hooks.fail('partial-startup', SECRET);
  const startup = runtime.start();
  const failed = assert.rejects(startup, diagnostic('lifecycle_start_failed'));
  try {
    await hooks.waitEntered('partial-startup');
    await hooks.waitEntered('blocking-provider');
    hooks.release('partial-startup');
    await failed;
    assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    await assert.rejects(runtime.start(), diagnostic('lifecycle_terminal'));
  } finally {
    hooks.release('partial-startup');
    hooks.release('blocking-provider');
  }
  await assert.rejects(runtime.shutdown(0), knownQuiescentCoreFailure);
  await assert.rejects(runtime.shutdown(30_000), knownQuiescentCoreFailure);
  retired(hooks, { rollback: true, executionWitness: true });
});

hookTest('contained operational failure is preserved by repeated real shutdown calls', async () => {
  const { runtime, hooks } = await fixture();
  hooks.hold('worker');
  hooks.fail('worker', SECRET);
  await runtime.start();
  await hooks.waitEntered('worker');
  hooks.release('worker');
  await assert.rejects(runtime.shutdown(100), knownQuiescentCoreFailure);
  await assert.rejects(runtime.shutdown(30_000), knownQuiescentCoreFailure);
  retired(hooks, { rollback: true, executionWitness: true });
});

hookTest('cancellation-safe provider fetch retires without waiting for its gate', async () => {
  const { runtime, hooks } = await fixture();
  hooks.hold('provider');
  await runtime.start();
  await hooks.waitEntered('provider');
  try {
    await runtime.shutdown(1000);
    retired(hooks, { forced: false, executionWitness: true });
  } finally {
    hooks.release('provider');
  }
});

for (const force of [false, true]) {
  hookTest(`ordered ${force ? 'force-before-retirement' : 'retirement-before-force'} 100 times`, async () => {
    for (let iteration = 0; iteration < 100; iteration++) {
      const { runtime, hooks } = await fixture();
      await orderedRaceAttempt(runtime, hooks, force, iteration);
    }
  });
}

test('retained completed Runtime does not prevent natural process exit', async () => {
  const probe = startProbe('exit');
  try {
    await probe.successfulExit(3000);
    assert.ok(probe.messages.some(message => message.phase === 'EXIT_READY'), probe.describe());
  } finally { await probe.dispose(); }
});

for (const scenario of ['late', 'retained']) {
  hookTest(`isolated non-yielding provider timeout: ${scenario}`, async () => {
    const probe = startProbe(scenario, { input: true });
    try {
      await probe.next('STOPPING', 15_000);
      const message = await probe.next('TIMED_OUT', shutdownTiming(scenario).delivery);
      assertShutdownTiming(scenario, message);
      probe.child.stdin.write(scenario === 'late' ? 'release\n' : 'retain\n');
      const completed = await probe.next(scenario === 'late' ? 'RECLAIMED' : 'RETAINED', 3000);
      record('LIFECYCLE_PROBE_RECORD', { scenario, ...message, finalPhase: completed.phase });
    } catch (error) {
      throw new Error(probe.describe(), { cause: error });
    } finally { await probe.dispose(); }
  });
}

hookTest('incomplete cleanup keeps the event loop live without stdin or referenced timers', async () => {
  const probe = startProbe('incomplete-liveness');
  try {
    await probe.next('STOPPING', 15_000);
    const message = await probe.next('TIMED_OUT', shutdownTiming('retained').delivery);
    assertShutdownTiming('retained', message);
    for (let pulse = 1; pulse <= 3; pulse++) {
      const alive = await probe.next('ALIVE', 2000);
      assert.equal(alive.pulse, pulse);
      assert.ok(alive.state.active > 0);
      assert.ok(alive.state.started > 0);
      assert.equal(alive.state.coordinators, 1);
    }
    record('LIFECYCLE_PROBE_RECORD', { scenario: 'incomplete-liveness', ...message, livePulses: 3 });
  } catch (error) {
    throw new Error(probe.describe(), { cause: error });
  } finally { await probe.dispose(); }
});

test('activity-only self-capturing callbacks collect after successful shutdown in a live process', async () => {
  const probe = startProbe('completed', { fixture: 'lifecycle-collection-probe.cjs' });
  try {
    const result = await probe.next('COLLECTION', 10_000);
    assert.ok(result.controlCollected);
    assert.ok(result.capturedCollected);
    record('LIFECYCLE_PROBE_RECORD', result);
    await probe.successfulExit(3000);
  } finally { await probe.dispose(); }
});

for (const scenario of ['quiescent-failure', 'late', 'late-unobserved']) {
  hookTest(`activity-only callbacks collect after ${scenario} cleanup`, async () => {
    const probe = startProbe(scenario, { fixture: 'lifecycle-collection-probe.cjs' });
    try {
      const result = await probe.next('COLLECTION', 15_000);
      assert.ok(result.controlCollected);
      assert.ok(result.capturedCollected);
      if (scenario.startsWith('late')) assert.ok(result.retainedWhileIncomplete);
      record('LIFECYCLE_PROBE_RECORD', result);
      await probe.successfulExit(3000);
    } finally { await probe.dispose(); }
  });
}
