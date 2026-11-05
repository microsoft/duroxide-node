// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { getEventListeners } = require('node:events');
const { createHook } = require('node:async_hooks');
const { SqliteProvider, Client, Runtime, RuntimeStopObserver } = require('../lib/duroxide.js');
const { nativeProvenance } = require('../ci/smoke/native-provenance.cjs');
const { startProbe } = require('./helpers/lifecycle-probe.cjs');
const {
  diagnostic, knownQuiescentCoreFailure, retiredState,
  shutdownTiming, assertShutdownTiming, orderedRaceAttempt,
  bounded, until, pendingObserverExit, observerRaceAttempt,
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

test('stop observer arguments and already-aborted signals do not activate or stop the worker', async () => {
  const { runtime, hooks } = await fixture();
  const observer = runtime.stopObserver();
  try {
    assert.ok(observer instanceof RuntimeStopObserver);
    assert.throws(() => new RuntimeStopObserver(), TypeError);
    for (const status of [undefined, null, 0, 'requested', {}, new String('Requested')]) {
      await assert.rejects(observer.waitForChange(status), TypeError);
    }
    for (const options of [null, false, 1, 'options']) {
      await assert.rejects(observer.waitForChange('NotRequested', options), TypeError);
    }
    for (const signal of [null, {}, false, new AbortController()]) {
      await assert.rejects(observer.waitForChange('NotRequested', { signal }), TypeError);
    }
    for (const reason of [new Error('abort-reason'), null, false, 'abort-reason']) {
      const abort = new AbortController();
      abort.abort(reason);
      const observed = await observer.waitForChange('NotRequested', { signal: abort.signal })
        .then(() => assert.fail('an already-aborted wait must reject'), error => error);
      assert.equal(observed, reason);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    }
    const ordinaryAbort = new AbortController();
    ordinaryAbort.abort();
    await assert.rejects(observer.waitForChange('NotRequested', { signal: ordinaryAbort.signal }), { name: 'AbortError' });
    assert.equal(observer.state, 'NotRequested');
    assert.equal(runtime.metricsSnapshot(), null);
    if (hooks) {
      const state = JSON.parse(hooks.snapshot());
      assert.equal(state.started, 0);
      assert.equal(state.coordinators, 0);
      assert.equal(state.observerPending, 0);
    }
    await runtime.start();
    assert.equal(observer.state, 'NotRequested');
    observer.close();
    assert.notEqual(runtime.metricsSnapshot(), null);
  } finally {
    observer.close();
    await runtime.shutdown(0);
  }
});

test('stop observer waits isolate abort, overlap and terminal close and deliver unseen final state', async () => {
  const { runtime } = await fixture();
  const first = runtime.stopObserver();
  const second = runtime.stopObserver();
  const closed = runtime.stopObserver();
  try {
    const abort = new AbortController();
    const pending = first.waitForChange('NotRequested', { signal: abort.signal });
    pending.catch(() => {});
    const other = second.waitForChange('NotRequested');
    other.catch(() => {});
    const closingSignal = new AbortController().signal;
    const closeWait = closed.waitForChange('NotRequested', { signal: closingSignal });
    closeWait.catch(() => {});
    await assert.rejects(first.waitForChange('NotRequested'), /stop_observer_busy/);
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    assert.equal(first.state, 'NotRequested');
    closed.close();
    closed.close();
    await assert.rejects(closeWait, /stop_observer_closed/);
    assert.equal(getEventListeners(closingSignal, 'abort').length, 0);
    assert.throws(() => closed.state, /stop_observer_closed/);
    await assert.rejects(closed.waitForChange('NotRequested'), /stop_observer_closed/);
    const nextAbort = new AbortController();
    const retry = first.waitForChange('NotRequested', { signal: nextAbort.signal });
    retry.catch(() => {});
    await runtime.shutdown(0);
    assert.deepEqual(await bounded(Promise.all([retry, other])), ['Requested', 'Requested']);
    assert.equal(getEventListeners(nextAbort.signal, 'abort').length, 0);
    nextAbort.abort();
    assert.equal(await retry, 'Requested');
    assert.equal(await first.waitForChange('NotRequested'), 'Requested');
    assert.equal(await first.waitForChange('Requested'), null);
    assert.equal(first.state, 'Requested');
    const late = runtime.stopObserver();
    try {
      assert.equal(await late.waitForChange('NotRequested'), 'Requested');
      assert.equal(await late.waitForChange('Requested'), null);
      first.close();
      assert.equal(late.state, 'Requested');
    } finally { late.close(); }
  } finally {
    first.close();
    second.close();
    closed.close();
    await runtime.shutdown(0);
  }
});

for (const action of ['abort', 'close', 'overlap']) {
  test(`stop observer registration remains isolated under reentrant ${action}`, async () => {
    for (const point of ['options', 'promise', 'native']) {
      const { runtime, hooks } = await fixture();
      const observer = runtime.stopObserver();
      const abort = new AbortController();
      const otherAbort = new AbortController();
      const reason = new Error(`registration-${action}-${point}`);
      const resources = new Set();
      const destroyed = new Set();
      let entered = false;
      let promises = 0;
      let other;
      const reenter = () => {
        if (entered) return;
        entered = true;
        if (action === 'abort') abort.abort(reason);
        else if (action === 'close') observer.close();
        else {
          other = observer.waitForChange('NotRequested', { signal: otherAbort.signal });
          other.catch(() => {});
        }
      };
      // Async hooks can run while the Promise or native notification is being constructed.
      const hook = createHook({
        init(id, type) {
          if (type === 'napi_rs_threadsafe_function') resources.add(id);
          if (point === 'promise' && type === 'PROMISE' && ++promises === 2) reenter();
          if (point === 'native' && type === 'napi_rs_threadsafe_function') reenter();
        },
        destroy(id) { if (resources.has(id)) destroyed.add(id); },
      });
      try {
        hook.enable();
        const options = point === 'options'
          ? { get signal() { reenter(); return abort.signal; } }
          : { signal: abort.signal };
        const pending = observer.waitForChange('NotRequested', options);
        pending.catch(() => {});
        assert.ok(entered, `${action}: ${point}`);
        if (action === 'abort') {
          await bounded(assert.rejects(pending, error => error === reason));
        } else if (action === 'close') {
          await bounded(assert.rejects(pending, /stop_observer_closed/));
          assert.throws(() => observer.state, /stop_observer_closed/);
        } else {
          const winner = point === 'native' ? pending : other;
          const overlap = point === 'native' ? other : pending;
          await bounded(assert.rejects(overlap, /stop_observer_busy/));
          (point === 'native' ? abort : otherAbort).abort(reason);
          await bounded(assert.rejects(winner, error => error === reason));
        }
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
        assert.equal(getEventListeners(otherAbort.signal, 'abort').length, 0);
        await until(() => [...resources].every(id => destroyed.has(id)));
        assert.equal(runtime.metricsSnapshot(), null);
        if (action !== 'close') assert.equal(observer.state, 'NotRequested');
        if (hooks) {
          const state = JSON.parse(hooks.snapshot());
          assert.equal(state.observerPending, 0);
          assert.equal(state.started, 0);
          assert.equal(state.coordinators, 0);
        }
      } finally {
        hook.disable();
        observer.close();
        abort.abort(reason);
        otherAbort.abort(reason);
        await runtime.shutdown(0);
      }
    }
  });
}

test('stop observer does not manufacture Faulted from a pre-core startup error', async () => {
  const { runtime } = await fixture({ sessionIdleTimeoutMs: 0 });
  const observer = runtime.stopObserver();
  try {
    await assert.rejects(runtime.start(), diagnostic('lifecycle_start_failed'));
    assert.equal(observer.state, 'NotRequested');
    const pending = observer.waitForChange('NotRequested');
    pending.catch(() => {});
    await assert.rejects(runtime.shutdown(0), diagnostic('lifecycle_start_failed'));
    assert.equal(await bounded(pending), 'Requested');
    assert.equal(await observer.waitForChange('Requested'), null);
  } finally {
    observer.close();
    await assert.rejects(runtime.shutdown(0), diagnostic('lifecycle_start_failed'));
  }
});

hookTest('stop observer transport errors are explicit, sanitized and independent of stop state', async () => {
  const { runtime, hooks } = await fixture();
  const observer = runtime.stopObserver();
  const signal = new AbortController().signal;
  try {
    hooks.fail('observer-delivery', SECRET);
    const wait = observer.waitForChange('NotRequested', { signal });
    const rejected = assert.rejects(wait, diagnostic('stop_observation_failed'));
    await runtime.shutdown(0);
    await bounded(rejected);
    assert.equal(observer.state, 'Requested');
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.equal(await observer.waitForChange('NotRequested'), 'Requested');
    assert.equal(await observer.waitForChange('Requested'), null);
  } finally {
    observer.close();
    await runtime.shutdown(0);
  }
});

hookTest('stop observer sees a real retained fault before held cleanup without an SDK stop', async () => {
  const { runtime, hooks } = await fixture();
  const observer = runtime.stopObserver();
  hooks.hold('worker');
  hooks.hold('blocking-provider');
  hooks.fail('worker', SECRET);
  try {
    const fault = observer.waitForChange('NotRequested');
    fault.catch(() => {});
    await runtime.start();
    await hooks.waitEntered('worker');
    await hooks.waitEntered('blocking-provider');
    hooks.release('worker');
    assert.equal(await bounded(fault), 'Faulted');
    assert.equal(observer.state, 'Faulted');
    assert.notEqual(runtime.metricsSnapshot(), null, 'observation must not call SDK shutdown');
    assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    const late = runtime.stopObserver();
    try {
      assert.equal(late.state, 'Faulted');
      assert.equal(await late.waitForChange('NotRequested'), 'Faulted');
      const abort = new AbortController();
      const pending = late.waitForChange('Faulted', { signal: abort.signal });
      pending.catch(() => {});
      abort.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(late.state, 'Faulted');
      assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    } finally { late.close(); }
  } finally {
    observer.close();
    hooks.release('worker');
    hooks.release('blocking-provider');
    await assert.rejects(runtime.shutdown(0), knownQuiescentCoreFailure);
  }
});

hookTest('stop observer sees a real fault while a foreign callback remains pending without an SDK stop', async () => {
  const { runtime, provider, hooks } = await fixture();
  const client = new Client(provider);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const retirement = new Promise(resolve => { release = resolve; });
  let completed = false;
  runtime.registerActivity('ObserverFaultActivity', async (_, input) => {
    enter();
    await retirement;
    completed = true;
    return input;
  });
  runtime.registerOrchestration('ObserverFaultFlow', function* (context, input) {
    return yield context.scheduleActivity('ObserverFaultActivity', input);
  });
  const observer = runtime.stopObserver();
  try {
    const fault = observer.waitForChange('NotRequested');
    fault.catch(() => {});
    await runtime.start();
    await client.startOrchestration('observer-foreign-fault', 'ObserverFaultFlow', 'held');
    await bounded(entered);
    hooks.fail('provider', SECRET);
    await client.startOrchestration('observer-foreign-fault-trigger', 'ObserverFaultFlow', 'trigger');
    assert.equal(await bounded(fault), 'Faulted');
    assert.equal(observer.state, 'Faulted');
    assert.equal(completed, false, 'the real foreign callback must remain held at fault observation');
    assert.notEqual(runtime.metricsSnapshot(), null, 'observation must not call SDK shutdown');
    const pending = JSON.parse(hooks.snapshot());
    const late = runtime.stopObserver();
    try {
      assert.equal(late.state, 'Faulted');
      assert.equal(await late.waitForChange('NotRequested'), 'Faulted');
      const abort = new AbortController();
      const pending = late.waitForChange('Faulted', { signal: abort.signal });
      pending.catch(() => {});
      abort.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(late.state, 'Faulted');
      assert.equal(completed, false);
    } finally { late.close(); }
    // Native retirement does not imply completion of unregistered JS continuations.
    record('LIFECYCLE_PROBE_RECORD', {
      scenario: 'observer-foreign-fault', native: provenance,
      faultWithoutSdkStop: true, callbackHeldAtFault: !completed,
      state: observer.state, execution: pending,
    });
  } finally {
    observer.close();
    release();
    await assert.rejects(runtime.shutdown(0), knownQuiescentCoreFailure);
    assert.equal(completed, true);
  }
});

hookTest('stop observer publisher retirement freezes the final state without retiring execution', async () => {
  const { runtime, hooks } = await fixture();
  const observer = runtime.stopObserver();
  hooks.hold('worker');
  hooks.hold('blocking-provider');
  hooks.fail('worker', SECRET);
  try {
    await runtime.start();
    await hooks.waitEntered('worker');
    await hooks.waitEntered('blocking-provider');
    const ended = observer.waitForChange('NotRequested');
    ended.catch(() => {});
    hooks.retireObservationPublisher(runtime._native);
    assert.equal(await bounded(ended), null);
    assert.equal(observer.state, 'NotRequested');
    assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    assert.equal(JSON.parse(hooks.snapshot()).coordinators, 0);
    hooks.release('worker');
    await until(() => JSON.parse(hooks.snapshot()).coordinators === 1);
    assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    assert.equal(observer.state, 'NotRequested', 'the closed source must not follow later core changes');
    assert.equal(await observer.waitForChange('NotRequested'), null);
  } finally {
    observer.close();
    hooks.release('worker');
    hooks.release('blocking-provider');
    await assert.rejects(runtime.shutdown(0), knownQuiescentCoreFailure);
  }
});

for (const changeFirst of [false, true]) {
  hookTest(`stop observer ordered attachment/change/abort/close races 100 times: ${changeFirst ? 'change-first' : 'cancel-first'}`, async () => {
    for (let iteration = 0; iteration < 100; iteration++) {
      const { runtime, hooks } = await fixture();
      await observerRaceAttempt(runtime, hooks, changeFirst, iteration);
    }
  });
}

hookTest('stop observer Requested-to-Faulted escalation stays monotonic through 100 ordered shutdowns', async () => {
  for (let iteration = 0; iteration < 100; iteration++) {
    const { runtime, hooks } = await fixture();
    const observer = runtime.stopObserver();
    hooks.hold('worker');
    hooks.hold('blocking-provider');
    hooks.fail('worker', SECRET);
    let stop;
    try {
      await runtime.start();
      await hooks.waitEntered('worker');
      await hooks.waitEntered('blocking-provider');
      const requested = observer.waitForChange('NotRequested');
      requested.catch(() => {});
      stop = runtime.shutdown(30_000);
      stop.catch(() => {});
      assert.equal(await bounded(requested), 'Requested');
      const fault = observer.waitForChange('Requested');
      fault.catch(() => {});
      hooks.release('worker');
      assert.equal(await bounded(fault), 'Faulted', `iteration ${iteration + 1}/100`);
      assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    } finally {
      observer.close();
      hooks.release('worker');
      hooks.release('blocking-provider');
      await assert.rejects(stop ?? runtime.shutdown(0), knownQuiescentCoreFailure);
    }
    await assert.rejects(runtime.shutdown(0), knownQuiescentCoreFailure);
    const late = runtime.stopObserver();
    assert.equal(late.state, 'Faulted');
    late.close();
    retired(hooks, { rollback: true, executionWitness: true });
  }
});

test('stop observer stays pending through natural exit after real worker cleanup', async () => {
  const probe = startProbe('observer-exit');
  try {
    const pending = await probe.next('OBSERVER_EXIT_READY', 5000);
    pendingObserverExit(pending);
    await probe.successfulExit(3000);
    const exiting = probe.messages.find(message => message.phase === 'OBSERVER_BEFORE_EXIT');
    assert.ok(exiting, probe.describe());
    pendingObserverExit(exiting);
    record('LIFECYCLE_PROBE_RECORD', { scenario: 'observer-exit', ...exiting });
  } finally { await probe.dispose(); }
});

for (const scenario of ['observer-source-end', 'retained-observer']) {
  test(`stop observer metadata does not retain callback/owner roots: ${scenario}`, async () => {
    const probe = startProbe(scenario, { fixture: 'lifecycle-collection-probe.cjs' });
    try {
      const result = await probe.next('OBSERVER_COLLECTION', 10_000);
      assert.ok(result.collected, JSON.stringify(result));
      record('LIFECYCLE_PROBE_RECORD', result);
      await probe.successfulExit(3000);
    } finally { await probe.dispose(); }
  });
}
