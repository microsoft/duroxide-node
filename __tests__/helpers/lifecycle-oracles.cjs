// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

function diagnostic(category) {
  return error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`^${category}:`));
    assert.doesNotMatch(error.message, /sentinel|Host=private/);
    return true;
  };
}

function knownQuiescentCoreFailure(error) {
  diagnostic('lifecycle_shutdown_failed')(error);
  assert.match(error.message, /cleanup completed and is quiescent/);
  assert.doesNotMatch(error.message, /terminate the process/);
  return true;
}

function incompleteTimeout(error) {
  diagnostic('lifecycle_shutdown_timed_out')(error);
  assert.match(error.message, /cleanup.*incomplete/);
  assert.match(error.message, /terminate the process/);
  return true;
}

function retiredState(state, { forced, rollback = false, executionWitness = false } = {}) {
  if (executionWitness) assert.ok(state.started > 0, 'witnessed execution must have a recorded task start');
  assert.equal(state.active, 0);
  assert.equal(state.cleanupActive, 0);
  assert.equal(state.started, state.completed);
  if (rollback) assert.ok(state.coordinators >= 1 && state.coordinators <= 2);
  else assert.equal(state.coordinators, 1);
  if (forced !== undefined) assert.equal(state.forceRequests, forced ? 1 : 0);
}

function shutdownTiming(scenario) {
  const minimum = scenario === 'late' ? 6000 : 5000;
  return { minimum, maximum: minimum + 1000, repeatedMaximum: 1000, delivery: minimum + 3000 };
}

function assertShutdownTiming(scenario, message) {
  const budget = shutdownTiming(scenario);
  assert.ok(message.elapsedMs >= budget.minimum, `first stop ${message.elapsedMs}ms < ${budget.minimum}ms`);
  assert.ok(message.elapsedMs < budget.maximum, `first stop ${message.elapsedMs}ms >= ${budget.maximum}ms`);
  assert.ok(message.repeatedMs >= 0 && message.repeatedMs < budget.repeatedMaximum,
    `repeated stop ${message.repeatedMs}ms must be < ${budget.repeatedMaximum}ms`);
}

async function orderedRaceAttempt(runtime, hooks, force, iteration) {
  const order = force ? 'force-before-retirement' : 'retirement-before-force';
  const stopGate = force ? 'force' : 'coordinator';
  const armed = [];
  let phase = 'arming';
  let snapshot;
  let stop;
  let failure;
  const context = () => `${order} iteration ${iteration + 1}/100 phase=${phase} lastSnapshot=${JSON.stringify(snapshot ?? null)}`;
  try {
    for (const gate of ['blocking-provider', stopGate]) {
      phase = `arm:${gate}`;
      hooks.hold(gate);
      armed.push(gate);
    }
    phase = 'start';
    await runtime.start();
    phase = 'entered:blocking-provider';
    await hooks.waitEntered('blocking-provider');
    snapshot = JSON.parse(hooks.snapshot());
    assert.ok(snapshot.started > 0, 'entered provider execution was not counted');
    phase = `entered:${stopGate}`;
    stop = runtime.shutdown(force ? 0 : 30_000);
    stop.catch(() => {});
    await hooks.waitEntered(stopGate);
    snapshot = JSON.parse(hooks.snapshot());
    assert.ok(snapshot.active > 0);
  } catch (error) {
    failure = new Error(context(), { cause: error });
  } finally {
    for (const gate of armed) {
      try { hooks.release(gate); }
      catch (error) { failure ??= new Error(`${context()} releasing ${gate}`, { cause: error }); }
    }
    try {
      if (!stop) stop = runtime.shutdown(0);
      assert.equal(await stop, undefined);
    } catch (error) {
      failure ??= new Error(`${context()} cleanup`, { cause: error });
    }
  }
  if (failure) throw failure;
  try {
    phase = 'repeated-stop';
    assert.equal(await runtime.shutdown(), undefined);
    phase = 'retired';
    snapshot = JSON.parse(hooks.snapshot());
    retiredState(snapshot, { forced: force, executionWitness: true });
  } catch (error) {
    throw new Error(context(), { cause: error });
  }
}

async function bounded(promise, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('stop observation did not settle within its test bound')), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function until(predicate, milliseconds = 3000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'stop observation condition did not become true');
    await delay(1);
  }
}

function pendingObserverExit(value) {
  assert.equal(value.source.closed, false, 'an ended source cannot prove pending observation liveness');
  assert.equal(value.settled, false, 'a settled promise cannot prove pending observation liveness');
  assert.equal(value.source.state, 'Requested');
  if (value.execution) {
    retiredState(value.execution, { executionWitness: true });
    assert.ok(value.execution.observerPending > 0, 'notification context must still be owned');
  }
}

async function observerRaceAttempt(runtime, hooks, changeFirst, iteration) {
  const armed = [];
  let delivered = 0;
  const nativeWait = runtime._stopSource.waitForChange;
  Object.defineProperty(runtime._stopSource, 'waitForChange', {
    value(lastSeen, callback) {
      return nativeWait.call(this, lastSeen, (...args) => {
        delivered++;
        callback(...args);
      });
    },
  });
  const first = runtime.stopObserver();
  const closed = runtime.stopObserver();
  const initialAbort = new AbortController();
  const retryAbort = new AbortController();
  const reason = new Error('first-observation-aborted');
  const retryReason = new Error('retried-observation-aborted');
  let startup;
  let failure;
  let phase = 'arming';
  let late;
  try {
    for (const gate of ['startup', 'observer-delivery']) {
      phase = `arm:${gate}`;
      hooks.hold(gate);
      armed.push(gate);
    }
    const firstWait = first.waitForChange('NotRequested', { signal: initialAbort.signal });
    const closeWait = closed.waitForChange('NotRequested');
    firstWait.catch(() => {});
    closeWait.catch(() => {});
    const staleAbort = assertSingleListener(initialAbort.signal);
    startup = runtime.start();
    phase = 'held-startup';
    await hooks.waitEntered('startup');
    late = runtime.stopObserver();
    assert.equal(first.state, 'NotRequested');
    assert.equal(late.state, 'NotRequested');
    if (changeFirst) {
      hooks.release('startup');
      await startup;
      await runtime.shutdown(0);
      await hooks.waitEntered('observer-delivery');
    }
    phase = 'cancel-and-close';
    initialAbort.abort(reason);
    closed.close();
    await bounded(Promise.all([
      assert.rejects(firstWait, error => error === reason),
      assert.rejects(closeWait, /stop_observer_closed/),
    ]));
    assert.equal(getEventListeners(initialAbort.signal, 'abort').length, 0);
    assert.equal(first.state, changeFirst ? 'Requested' : 'NotRequested');
    let retriedSettled = false;
    const retry = first.waitForChange(changeFirst ? 'Requested' : 'NotRequested', { signal: retryAbort.signal });
    retry.then(() => { retriedSettled = true; }, () => { retriedSettled = true; });
    staleAbort();
    assertSingleListener(retryAbort.signal);
    phase = 'retire-worker';
    if (!changeFirst) {
      hooks.release('startup');
      await startup;
      await runtime.shutdown(0);
      await hooks.waitEntered('observer-delivery');
    }
    const state = JSON.parse(hooks.snapshot());
    retiredState(state, { executionWitness: true });
    assert.ok(state.observerPending >= 2, 'old notification contexts must survive local settlement');
    assert.equal(late.state, 'Requested');
    assert.equal(runtime._stopSource.snapshot().closed, false);
    phase = 'late-delivery';
    hooks.release('observer-delivery');
    if (changeFirst) {
      await until(() => delivered >= 2);
      assert.equal(retriedSettled, false, 'old callbacks must not settle the new pending wait');
      retryAbort.abort(retryReason);
      await bounded(assert.rejects(retry, error => error === retryReason));
    } else {
      assert.equal(await bounded(retry), 'Requested');
      retryAbort.abort(retryReason);
      assert.equal(await retry, 'Requested', 'settled results are not rewritten by abort or close');
    }
    assert.equal(getEventListeners(retryAbort.signal, 'abort').length, 0);
    first.close();
    await until(() => JSON.parse(hooks.snapshot()).observerPending === 0);
  } catch (error) {
    failure = new Error(`stop observer ${changeFirst ? 'change-first' : 'cancel-first'} iteration ${iteration + 1}/100 phase=${phase}`, { cause: error });
  } finally {
    first.close();
    closed.close();
    late?.close();
    for (const gate of armed) {
      try { hooks.release(gate); }
      catch (error) { failure ??= new Error(`stop observer cleanup gate ${gate}`, { cause: error }); }
    }
    try {
      if (startup) await startup;
      await runtime.shutdown(0);
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

function assertSingleListener(signal) {
  const listeners = getEventListeners(signal, 'abort');
  assert.equal(listeners.length, 1);
  return listeners[0];
}

module.exports = {
  diagnostic, knownQuiescentCoreFailure, incompleteTimeout, retiredState,
  shutdownTiming, assertShutdownTiming, orderedRaceAttempt,
  bounded, until, pendingObserverExit, observerRaceAttempt,
};
