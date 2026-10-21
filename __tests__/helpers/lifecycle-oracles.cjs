// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');

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

module.exports = {
  diagnostic, knownQuiescentCoreFailure, incompleteTimeout, retiredState,
  shutdownTiming, assertShutdownTiming, orderedRaceAttempt,
};
