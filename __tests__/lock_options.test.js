// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * The lock options reach the Rust runtime.
 *
 * When the runtime starts a lock renewal task it logs, at debug level, the lock
 * timeout and the renewal interval it uses. A child process starts a runtime with
 * every lock option set, runs one orchestration with one session activity, and
 * prints the runtime's JSON log lines. The test reads the intervals from them.
 *
 * Renewal rule of the runtime: with a lock timeout of 15 s or more, the lock is
 * renewed `buffer` before it runs out (interval = timeout - buffer). With a shorter
 * timeout it is renewed at half the timeout and the buffer is ignored.
 *
 * Each option gets its own value, so a value that reaches the wrong setting fails
 * the test. No database is needed: the child uses an in-memory SQLite provider.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib', 'duroxide.js');

function runChild(options) {
  const script = `
    const { SqliteProvider, Client, Runtime } = require(${JSON.stringify(LIB)});
    (async () => {
      const provider = await SqliteProvider.inMemory();
      const runtime = new Runtime(provider, Object.assign(
        { dispatcherPollIntervalMs: 20, logFormat: 'json' },
        ${JSON.stringify(options)},
      ));
      runtime.registerActivity('Echo', async (ctx, input) => input);
      runtime.registerOrchestration('LockOptions', function* (ctx) {
        return yield ctx.scheduleActivityOnSession('Echo', 'hi', 'session-1');
      });
      await runtime.start();
      const client = new Client(provider);
      await client.startOrchestration('lock-options-1', 'LockOptions', null);
      const result = await client.waitForOrchestration('lock-options-1', 10000);
      await runtime.shutdown(100);
      console.log(JSON.stringify({ childResult: result.status }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const env = { ...process.env, RUST_LOG: 'warn,duroxide::runtime=debug' };
  const child = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(child.status, 0, `child failed: ${child.stderr}`);
  const lines = child.stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const status = lines.find((l) => l.childResult);
  assert.strictEqual(status && status.childResult, 'Completed');
  return lines;
}

function logFields(lines, message) {
  const line = lines.find((l) => l.fields && l.fields.message === message);
  assert.ok(line, `no "${message}" line in the runtime log`);
  return line.fields;
}

describe('lock options', () => {
  it('every lock timeout and renewal buffer reaches the runtime', () => {
    const lines = runChild({
      orchestratorLockTimeoutMs: 20000,
      orchestratorLockRenewalBufferMs: 17000, // renew every 3 s
      workerLockTimeoutMs: 21000,
      workerLockRenewalBufferMs: 17000, // renew every 4 s
      sessionLockTimeoutMs: 22000,
      sessionLockRenewalBufferMs: 17000, // renew every 5 s
    });

    const orch = logFields(lines, 'Spawning orchestration lock renewal task');
    assert.strictEqual(Number(orch.lock_timeout_secs), 20);
    assert.strictEqual(Number(orch.buffer_secs), 17);
    assert.strictEqual(Number(orch.renewal_interval_secs), 3);

    const activity = logFields(lines, 'Spawning activity manager');
    assert.strictEqual(Number(activity.lock_timeout_secs), 21);
    assert.strictEqual(Number(activity.renewal_interval_secs), 4);

    const session = logFields(lines, 'Session manager started');
    assert.strictEqual(Number(session.renewal_interval_secs), 5);
  });

  it('without the options the runtime uses its defaults', () => {
    const lines = runChild({});

    // Orchestration lock: 5 s, below 15 s, so renewed at half the timeout.
    const orch = logFields(lines, 'Spawning orchestration lock renewal task');
    assert.strictEqual(Number(orch.lock_timeout_secs), 5);
    assert.strictEqual(Number(orch.renewal_interval_secs), 3);

    // Worker lock: 30 s with a 5 s buffer.
    const activity = logFields(lines, 'Spawning activity manager');
    assert.strictEqual(Number(activity.lock_timeout_secs), 30);
    assert.strictEqual(Number(activity.renewal_interval_secs), 25);

    // Session lock: 30 s with a 5 s buffer.
    const session = logFields(lines, 'Session manager started');
    assert.strictEqual(Number(session.renewal_interval_secs), 25);
  });
});
