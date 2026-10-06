// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { SqliteProvider, Client, Runtime } = require('../lib/duroxide.js');

const root = path.resolve(__dirname, '..');
const nativePath = Object.keys(require.cache).find(file => file.endsWith('.node'));
assert.ok(nativePath?.startsWith(root + path.sep), 'tests require the freshly built local native module');
const native = require(nativePath);
const instrumented = process.env.DUROXIDE_LIFECYCLE_TEST_HOOKS === '1';
const SECRET = 'Password=lifecycle-secret-sentinel;Host=private-sentinel';
const MAX_GRACE_MS = Number(((2n ** 64n) - 1n) / 1_000_000n) - 5000;

function diagnostic(category, incomplete = false) {
  return error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(category));
    assert.ok(!error.message.includes(SECRET));
    assert.ok(!error.message.includes('sentinel'));
    if (incomplete) {
      assert.match(error.message, /cleanup.*incomplete/);
      assert.match(error.message, /terminate the process/);
    }
    if (category === 'lifecycle_shutdown_failed') {
      assert.match(error.message, /cleanup completed and is quiescent/);
      assert.doesNotMatch(error.message, /terminate the process/);
    }
    return true;
  };
}

async function fixture(options) {
  const provider = await SqliteProvider.inMemory();
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 5, ...options });
  return { provider, runtime, hooks: instrumented ? native._lifecycleTestHooks(runtime._native) : null };
}

function retired(hooks, forced) {
  const state = JSON.parse(hooks.snapshot());
  assert.equal(state.active, 0);
  assert.equal(state.cleanupActive, 0);
  assert.equal(state.started, state.completed);
  assert.equal(state.coordinators, 1);
  if (forced !== undefined) assert.equal(state.forceRequests, forced ? 1 : 0);
}

test('native provenance and production export boundary', () => {
  assert.equal(typeof native._lifecycleTestHooks === 'function', instrumented);
  assert.equal(typeof native.LifecycleTestHooks === 'function', instrumented);
  console.log('LIFECYCLE_NATIVE ' + JSON.stringify({
    path: nativePath,
    sha256: createHash('sha256').update(readFileSync(nativePath)).digest('hex'),
    instrumented,
  }));
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

test('fallible preparation rejects invalid options without an escaping panic', async () => {
  const { runtime } = await fixture({ sessionIdleTimeoutMs: 0 });
  await assert.rejects(runtime.start(), diagnostic('lifecycle_start_failed'));
  await assert.rejects(runtime.shutdown(0), diagnostic('lifecycle_start_failed'));
  await assert.rejects(runtime.start(), diagnostic('lifecycle_terminal'));
  assert.equal(runtime.metricsSnapshot(), null);
});

for (const scenario of ['registry-invalid', 'registry-descending']) {
  test(`pre-core startup failure is ordinary and retained: ${scenario}`, () => {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'lifecycle-probe.cjs'), scenario], {
      cwd: root, encoding: 'utf8', timeout: 5000, env: process.env,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /REGISTRY_FAILURE_RETAINED/);
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
  if (hooks) retired(hooks, false);
});

test('SQLite activity and orchestration run through the unchanged public API', async () => {
  const { runtime, provider } = await fixture();
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
});

test('partial-startup failure retains descendants until actual rollback', { skip: !instrumented }, async () => {
  const { runtime, hooks } = await fixture();
  hooks.hold('partial-startup');
  hooks.hold('provider');
  hooks.fail('partial-startup', SECRET);
  const startup = runtime.start();
  const failed = assert.rejects(startup, diagnostic('lifecycle_start_failed'));
  try {
    await hooks.waitEntered('partial-startup');
    await hooks.waitEntered('provider');
    hooks.release('partial-startup');
    await failed;
    assert.ok(JSON.parse(hooks.snapshot()).active > 0);
    await assert.rejects(runtime.start(), diagnostic('lifecycle_terminal'));
  } finally {
    hooks.release('partial-startup');
    hooks.release('provider');
  }
  await assert.rejects(runtime.shutdown(0), diagnostic('lifecycle_shutdown_failed'));
  await assert.rejects(runtime.shutdown(30_000), diagnostic('lifecycle_shutdown_failed'));
  retired(hooks);
});

test('contained operational failure is preserved by repeated real shutdown calls', { skip: !instrumented }, async () => {
  const { runtime, hooks } = await fixture();
  hooks.hold('worker');
  hooks.fail('worker', SECRET);
  await runtime.start();
  await hooks.waitEntered('worker');
  hooks.release('worker');
  await assert.rejects(runtime.shutdown(100), diagnostic('lifecycle_shutdown_failed'));
  await assert.rejects(runtime.shutdown(30_000), diagnostic('lifecycle_shutdown_failed'));
  retired(hooks);
});

for (const force of [false, true]) {
  test(`ordered ${force ? 'force-before-retirement' : 'retirement-before-force'} 100 times`, { skip: !instrumented }, async () => {
    for (let iteration = 0; iteration < 100; iteration++) {
      const { runtime, hooks } = await fixture();
      hooks.hold('provider');
      hooks.hold(force ? 'force' : 'coordinator');
      await runtime.start();
      await hooks.waitEntered('provider');
      const stop = runtime.shutdown(force ? 0 : 30_000);
      try {
        await hooks.waitEntered(force ? 'force' : 'coordinator');
        assert.ok(JSON.parse(hooks.snapshot()).active > 0);
      } finally {
        hooks.release('provider');
        hooks.release(force ? 'force' : 'coordinator');
      }
      assert.equal(await stop, undefined);
      assert.equal(await runtime.shutdown(), undefined);
      retired(hooks, force);
    }
  });
}

test('retained completed Runtime does not prevent natural process exit', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'lifecycle-probe.cjs'), 'exit'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let watchdog;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('completed runtime kept the process alive')), 3000);
      child.once('error', reject);
      child.once('exit', code => {
        try {
          assert.equal(code, 0, output);
          assert.match(output, /EXIT_READY/);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});

for (const scenario of ['late', 'retained']) {
  test(`isolated provider timeout: ${scenario}`, { skip: !instrumented }, async () => {
    const child = spawn(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures', 'lifecycle-probe.cjs'), scenario], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let watchdog;
    const lines = createInterface({ input: child.stdout });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('probe did not start')), 15_000);
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`probe exited ${code}: ${stderr}`)));
        lines.on('line', line => {
          if (!line.startsWith('LIFECYCLE_PROBE ')) return;
          try {
            const message = JSON.parse(line.slice('LIFECYCLE_PROBE '.length));
            if (message.phase === 'STOPPING') {
              clearTimeout(watchdog);
              watchdog = setTimeout(() => reject(new Error('default shutdown exceeded seven seconds')), 7000);
            } else if (message.phase === 'TIMED_OUT') {
              clearTimeout(watchdog);
              watchdog = setTimeout(() => reject(new Error('late cleanup/retention evidence missing')), 3000);
              assert.ok(message.elapsedMs >= (scenario === 'late' ? 6000 : 5000));
              assert.ok(message.elapsedMs < (scenario === 'late' ? 7000 : 6000));
              assert.ok(message.repeatedMs < 1000);
              child.stdin.write(scenario === 'late' ? 'release\n' : 'retain\n');
            } else if (message.phase === 'RECLAIMED' || message.phase === 'RETAINED') {
              assert.equal(message.phase, scenario === 'late' ? 'RECLAIMED' : 'RETAINED');
              resolve();
            } else if (message.phase === 'FAILED') {
              reject(new Error(message.error));
            }

          } catch (error) { reject(error); }
        });
      });
    } finally {
      clearTimeout(watchdog);
      lines.close();
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
}
