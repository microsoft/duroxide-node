// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { identifyNative } = require('../ci/smoke/native-provenance.cjs');
const { lifecycleReport, encodedRecords } = require('../ci/lifecycle-report.cjs');
const { startProbe, OUTPUT_LIMIT } = require('./helpers/lifecycle-probe.cjs');
const {
  diagnostic, knownQuiescentCoreFailure, incompleteTimeout, retiredState,
  shutdownTiming, assertShutdownTiming, orderedRaceAttempt,
} = require('./helpers/lifecycle-oracles.cjs');

test('failure category does not claim quiescence for owner loss or callback release errors', () => {
  for (const message of [
    'native shutdown owner failed; quiescence is unproven; application or supervisor must terminate the process',
    'callback event-loop reference release failed',
  ]) {
    const error = new Error(`lifecycle_shutdown_failed: ${message}`);
    assert.equal(diagnostic('lifecycle_shutdown_failed')(error), true);
    assert.throws(() => knownQuiescentCoreFailure(error));
  }
  assert.equal(knownQuiescentCoreFailure(new Error('lifecycle_shutdown_failed: cleanup completed and is quiescent')), true);
  assert.equal(incompleteTimeout(new Error('lifecycle_shutdown_timed_out: cleanup remains owned and incomplete; application or supervisor must terminate the process')), true);
  assert.throws(() => diagnostic('lifecycle_shutdown_failed')(new Error('lifecycle_shutdown_failed: private-sentinel')));
});

test('retirement oracle rejects zero execution starts despite a working coordinator', () => {
  const zeroExecution = { active: 0, cleanupActive: 0, started: 0, completed: 0, coordinators: 1, forceRequests: 0 };
  retiredState(zeroExecution, { forced: false });
  assert.throws(() => retiredState(zeroExecution, { executionWitness: true }), /recorded task start/);
});

test('delivery allowance cannot admit over-budget first or repeated shutdown measurements', () => {
  for (const scenario of ['late', 'retained']) {
    const budget = shutdownTiming(scenario);
    assert.ok(budget.delivery > budget.maximum + budget.repeatedMaximum);
    assertShutdownTiming(scenario, { elapsedMs: budget.maximum - 1, repeatedMs: 999 });
    assert.throws(() => assertShutdownTiming(scenario, { elapsedMs: budget.maximum, repeatedMs: 0 }));
    assert.throws(() => assertShutdownTiming(scenario, { elapsedMs: budget.minimum, repeatedMs: 1000 }));
    assert.throws(() => assertShutdownTiming(scenario, { elapsedMs: budget.minimum - 1, repeatedMs: 0 }));
  }
});

test('native identity follows Duroxide exports, not the first cached addon', () => {
  const loaderPath = path.resolve('index.js');
  const otherPath = path.resolve('unrelated.node');
  const nativePath = path.resolve('duroxide.test.node');
  const bindings = { JsRuntime: class {}, JsClient: class {}, JsSqliteProvider: class {} };
  const intended = { filename: nativePath, exports: bindings };
  const cache = {
    [otherPath]: { filename: otherPath, exports: null },
    [loaderPath]: { exports: bindings },
    [nativePath]: intended,
  };
  assert.equal(identifyNative(loaderPath, cache), intended);
  delete cache[nativePath];
  assert.throws(() => identifyNative(loaderPath, cache), /exactly one native module/);
});

test('ordered-race failures preserve cause, iteration and early armed-gate cleanup', async () => {
  const original = new Error('deliberate second gate failure');
  const released = [];
  let stopped = 0;
  const hooks = {
    hold(gate) { if (gate === 'force') throw original; },
    release(gate) { released.push(gate); },
    snapshot() { throw new Error('diagnostics must not call snapshots after failure'); },
  };
  const runtime = {
    async start() { throw new Error('must not reach startup'); },
    async shutdown() { stopped++; },
  };
  await assert.rejects(orderedRaceAttempt(runtime, hooks, true, 41), error => {
    assert.equal(error.cause, original);
    assert.match(error.message, /force-before-retirement iteration 42\/100 phase=arm:force lastSnapshot=null/);
    return true;
  });
  assert.deepEqual(released, ['blocking-provider']);
  assert.equal(stopped, 1);
});

test('probe failures retain bounded stdout, stderr, protocol phase and original cause', async () => {
  const probe = startProbe('deliberate-failure', {
    script: `console.log('x'.repeat(${OUTPUT_LIMIT * 2})); console.error('diagnostic-stderr');
      console.log('LIFECYCLE_PROBE ' + JSON.stringify({ phase: 'FAILED', error: 'deliberate child stack' }));`,
  });
  try {
    await assert.rejects(probe.next('STOPPING', 3000), error => {
      assert.match(error.message, /scenario=deliberate-failure expected=STOPPING last=FAILED exit=/);
      assert.match(error.message, /diagnostic-stderr/);
      assert.match(error.cause.message, /deliberate child stack/);
      assert.ok(error.message.length < OUTPUT_LIMIT * 2 + 1000);
      return true;
    });
  } finally { await probe.dispose(); }
});

test('malformed child protocol retains its parse failure and reliable cleanup', async () => {
  const probe = startProbe('malformed', { script: "console.log('LIFECYCLE_PROBE {broken');" });
  try {
    await assert.rejects(probe.next('STOPPING', 3000), error => {
      assert.ok(error.cause instanceof SyntaxError);
      assert.match(error.message, /expected=STOPPING last=spawn/);
      assert.match(error.message, /\{broken/);
      return true;
    });
  } finally { await probe.dispose(); }
});

test('instrumented CI rejects skips, absent required cases, empty selection and aborted totals', () => {
  const tap = `# Subtest: [instrumented] required
ok 1 - [instrumented] required
# Subtest: production
ok 2 - production
# tests 2
# pass 2
# fail 0
# skipped 0
# cancelled 0
# todo 0
`;
  assert.equal(lifecycleReport(tap, 'instrumented').requiredHookCases, 1);
  const skipped = tap.replace('ok 1 - [instrumented] required', 'ok 1 - [instrumented] required # SKIP')
    .replace('# pass 2', '# pass 1').replace('# skipped 0', '# skipped 1');
  assert.throws(() => lifecycleReport(skipped, 'instrumented'), /must execute, not skip/);
  assert.equal(lifecycleReport(skipped, 'production').skipped, 1);
  assert.throws(() => lifecycleReport(tap.replaceAll('[instrumented]', 'unmarked'), 'instrumented'), /not selected/);
  assert.throws(() => lifecycleReport(tap.replace('# tests 2', '# tests 0'), 'instrumented'), /selection/);
  assert.throws(() => lifecycleReport(tap.replace('# cancelled 0', '# cancelled 1'), 'instrumented'), /aborted/);
});

test('native provenance records survive TAP escaping of Windows paths', () => {
  const record = { path: 'C:\\native\\duroxide.win32-x64-msvc.node', sha256: 'a'.repeat(64), instrumented: false };
  const encoded = Buffer.from(JSON.stringify(record)).toString('base64');
  assert.deepEqual(encodedRecords(`# LIFECYCLE_NATIVE_RECORD ${encoded}\r\n`, 'LIFECYCLE_NATIVE_RECORD'), [record]);
  assert.deepEqual(encodedRecords('# unrelated\n', 'LIFECYCLE_NATIVE_RECORD'), []);
  assert.throws(() => encodedRecords('# LIFECYCLE_NATIVE_RECORD e2Jyb2tlbg==\n', 'LIFECYCLE_NATIVE_RECORD'));
});
