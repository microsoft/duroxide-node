// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Replay isolation regression test for duroxide Node.js SDK.
 *
 * Two replays of the same instance can be alive in one process at the same time:
 * a replay that lost its orchestration lock keeps running until it tries to commit,
 * and a free dispatcher slot of the same runtime can fetch the instance again.
 * The provider rejects the commit of the replay that lost the lock. Until then the
 * two replays must not see each other: ctx.getValue / ctx.setValue / ctx.setCustomStatus /
 * ctx.trace* of one replay must reach that replay's native context and no other.
 *
 * The scenario runs in a child process, because it freezes the whole process:
 *   1. An orchestration bumps a KV counter and yields, STEPS times.
 *   2. In the middle of one replay, the process stops itself (SIGSTOP) for longer
 *      than the orchestration lock timeout, then continues (SIGCONT).
 *   3. The frozen replay has lost its lock but still has steps to run. A second
 *      dispatcher slot fetches the same instance and replays it at the same time.
 *   4. The orchestration is deterministic, so it must complete with the right count.
 *
 * A second test runs the same freeze with a longer `orchestratorLockTimeoutMs`.
 * The lock then outlives the freeze, so the instance is not fetched a second time.
 *
 * Uses SqliteProvider.inMemory(). Skipped on Windows (no SIGSTOP).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');

const STEPS = 6;
const FREEZE_PASS = 5; // the replay that gets frozen (replays are counted from 1)
const FREEZE_STEP = 1; // ...while it runs this step
const FREEZE_SECONDS = 7; // longer than the default 5s orchestration lock timeout
const STALE_STEP_MS = 400; // the frozen replay stays busy after it wakes up
const OTHER_STEP_MS = 100; // later replays are slow enough to still run when the frozen replay makes its calls

if (process.env.DUROXIDE_REPLAY_ISOLATION_CHILD === '1') {
  runScenario().then(
    (result) => {
      process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
      process.exit(0);
    },
    (err) => {
      process.stdout.write(`RESULT ${JSON.stringify({ error: String((err && err.stack) || err) })}\n`);
      process.exit(1);
    },
  );
} else {
  describe('replay isolation', () => {
    it(
      'a replay that lost its lock does not disturb another replay of the same instance',
      { skip: process.platform === 'win32' ? 'needs SIGSTOP/SIGCONT' : false, timeout: 120_000 },
      async () => {
        const { stdout, stderr, code } = await runChild();
        const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
        assert.ok(line, `scenario printed no result (exit code ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        const result = JSON.parse(line.slice('RESULT '.length));
        assert.strictEqual(result.error, undefined, result.error);

        assert.ok(result.frozeForMs >= 5000, `process was frozen for ${result.frozeForMs}ms only`);

        assert.strictEqual(result.status, 'Completed', `orchestration did not complete: ${JSON.stringify(result)}`);
        assert.strictEqual(result.output, `done counter=${STEPS}`);

        // The replay that lost its lock still replays cleanly against its own context.
        assert.ok(
          result.frozenReplayRanAllSteps,
          `the frozen replay did not run all its steps; steps: ${JSON.stringify(result.steps)}`,
        );
        // The run only proves something if two replays really ran at the same time.
        assert.ok(
          result.overlapped,
          `the frozen replay and a second replay did not overlap; steps: ${JSON.stringify(result.steps)}`,
        );
      },
    );

    it(
      'orchestratorLockTimeoutMs keeps the lock across a stall shorter than the timeout',
      { skip: process.platform === 'win32' ? 'needs SIGSTOP/SIGCONT' : false, timeout: 120_000 },
      async () => {
        // Same freeze (longer than the default 5s lock), but the lock now lasts 30s.
        const { stdout, stderr, code } = await runChild({ DUROXIDE_REPLAY_ISOLATION_LOCK_MS: '30000' });
        const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
        assert.ok(line, `scenario printed no result (exit code ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        const result = JSON.parse(line.slice('RESULT '.length));
        assert.strictEqual(result.error, undefined, result.error);

        assert.ok(result.frozeForMs >= 5000, `process was frozen for ${result.frozeForMs}ms only`);
        assert.strictEqual(result.status, 'Completed', `orchestration did not complete: ${JSON.stringify(result)}`);
        assert.strictEqual(result.output, `done counter=${STEPS}`);
        // One replay per turn: the frozen replay kept its lock, so nobody fetched the instance again.
        assert.strictEqual(
          result.replays,
          STEPS + 1,
          `expected ${STEPS + 1} replays, got ${result.replays}; steps: ${JSON.stringify(result.steps)}`,
        );
      },
    );
  });
}

function runChild(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, ...extraEnv, DUROXIDE_REPLAY_ISOLATION_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

/** Burn wall-clock time on the JS thread. */
function spin(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy */
  }
}

/**
 * Stop this whole process for `seconds`, then continue. Returns how long the
 * process was actually frozen, in ms. A helper shell sends the signals; this
 * function spins until it sees the clock jump.
 */
function freezeThisProcess(seconds) {
  // Read the clock before the helper starts. The helper can stop this process
  // before spawn() returns, and the loop below must still see the gap.
  const start = performance.now();
  let last = start;
  const helper = spawn('sh', ['-c', `kill -STOP ${process.pid}; sleep ${seconds}; kill -CONT ${process.pid}`], {
    detached: true,
    stdio: 'ignore',
  });
  helper.unref();
  for (;;) {
    const now = performance.now();
    if (now - last > 2000) return Math.round(now - last);
    if (now - start > 30_000) throw new Error('the process was never stopped');
    last = now;
  }
}

async function runScenario() {
  if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) throw new Error('sh is not available');
  const { SqliteProvider, Client, Runtime } = require('../lib/duroxide.js');
  const provider = await SqliteProvider.inMemory();
  const client = new Client(provider);
  // Two dispatcher slots: one keeps running the frozen replay, the other fetches the instance again.
  const options = { orchestrationConcurrency: 2, dispatcherPollIntervalMs: 10, logLevel: 'error' };
  const lockMs = Number(process.env.DUROXIDE_REPLAY_ISOLATION_LOCK_MS || 0);
  if (lockMs > 0) options.orchestratorLockTimeoutMs = lockMs;
  const runtime = new Runtime(provider, options);

  let replays = 0;
  let frozeForMs = 0;
  const steps = []; // "replay:step", in the order the JS thread ran them

  runtime.registerOrchestration('Counter', function* (ctx) {
    const replay = ++replays; // test bookkeeping only; never used for a decision
    for (let step = 1; step <= STEPS; step++) {
      steps.push(`${replay}:${step}`);
      if (replay === FREEZE_PASS && step === FREEZE_STEP && frozeForMs === 0) {
        frozeForMs = freezeThisProcess(FREEZE_SECONDS);
      }
      if (frozeForMs > 0) spin(replay === FREEZE_PASS ? STALE_STEP_MS : OTHER_STEP_MS);
      const next = Number(ctx.getValue('counter') ?? 0) + 1;
      ctx.setValue('counter', String(next));
      yield ctx.utcNow();
    }
    return `done counter=${ctx.getValue('counter')}`;
  });

  await runtime.start();
  try {
    await client.startOrchestration('replay-isolation', 'Counter', null);
    const result = await client.waitForOrchestration('replay-isolation', 60_000);
    // The frozen replay runs steps 1..FREEZE_PASS and then tries to commit. Give it time to get there.
    const lastFrozenStep = `${FREEZE_PASS}:${FREEZE_PASS}`;
    const deadline = Date.now() + 10_000;
    while (!steps.includes(lastFrozenStep) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Overlap: a later replay started before the frozen replay ran its last step.
    const lastOfFrozen = steps.map((s) => s.startsWith(`${FREEZE_PASS}:`)).lastIndexOf(true);
    const firstOfNext = steps.findIndex((s) => Number(s.split(':')[0]) > FREEZE_PASS);
    return {
      status: result.status,
      output: result.output,
      failure: result.error,
      frozeForMs,
      replays,
      frozenReplayRanAllSteps: steps.includes(lastFrozenStep),
      overlapped: firstOfNext !== -1 && firstOfNext < lastOfFrozen,
      steps,
    };
  } finally {
    await runtime.shutdown(100);
  }
}
