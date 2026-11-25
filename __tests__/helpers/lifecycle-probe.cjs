// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const OUTPUT_LIMIT = 8192;

function startProbe(scenario, { input = false, fixture = 'lifecycle-probe.cjs', script, env = process.env } = {}) {
  const args = script === undefined
    ? ['--expose-gc', path.join(__dirname, '..', 'fixtures', fixture), scenario]
    : ['-e', script];
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, '..', '..'), stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env,
  });
  let stdout = '';
  let stderr = '';
  let lastPhase = 'spawn';
  let expectedPhase = 'none';
  let failure;
  let waiter;
  const messages = [];
  const queue = [];
  const describe = () =>
    `scenario=${scenario} expected=${expectedPhase} last=${lastPhase} exit=${child.exitCode} signal=${child.signalCode}` +
    `\nstdout (tail):\n${stdout}\nstderr (tail):\n${stderr}`;
  const reject = error => {
    failure ??= error;
    if (waiter) {
      const pending = waiter;
      waiter = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error(describe(), { cause: failure }));
    }
  };
  const deliver = () => {
    if (!waiter || queue.length === 0) return;
    const pending = waiter;
    waiter = undefined;
    clearTimeout(pending.timer);
    const message = queue.shift();
    try {
      assert.equal(message.phase, expectedPhase, describe());
      pending.resolve(message);
    } catch (error) {
      failure ??= error;
      pending.reject(new Error(describe(), { cause: error }));
    }
  };
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-OUTPUT_LIMIT); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!line.startsWith('LIFECYCLE_PROBE ')) return;
    try {
      const message = JSON.parse(line.slice('LIFECYCLE_PROBE '.length));
      assert.equal(typeof message.phase, 'string');
      lastPhase = message.phase;
      messages.push(message);
      if (message.phase === 'FAILED' || message.phase === 'PREMATURE_BEFORE_EXIT') {
        reject(new Error(message.error ?? `native cleanup pending at ${message.phase}`));
        return;
      }
      queue.push(message);
      deliver();
    } catch (error) { reject(error); }
  });
  child.on('error', reject);
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    if (waiter) reject(new Error(`child closed before ${expectedPhase}: ${code ?? signal}`));
    resolve({ code, signal });
  }));

  return {
    child, messages, describe,
    async next(phase, milliseconds) {
      expectedPhase = phase;
      if (failure) throw new Error(describe(), { cause: failure });
      if (child.exitCode !== null || child.signalCode !== null) {
        if (queue.length === 0) throw new Error(describe(), { cause: new Error('child already exited') });
      }
      assert.equal(waiter, undefined, 'only one protocol observation may be pending');
      return new Promise((resolve, rejectPromise) => {
        const timer = setTimeout(() => reject(new Error(`message-delivery watchdog expired after ${milliseconds}ms`)), milliseconds);
        waiter = { resolve, reject: rejectPromise, timer };
        deliver();
      });
    },
    async successfulExit(milliseconds) {
      expectedPhase = 'exit(0)';
      let timer;
      try {
        const status = await Promise.race([
          exited,
          new Promise((_, rejectPromise) => {
            timer = setTimeout(() => rejectPromise(new Error(describe(), {
              cause: new Error(`natural-exit watchdog expired after ${milliseconds}ms`),
            })), milliseconds);
          }),
        ]);
        if (failure) throw new Error(describe(), { cause: failure });
        assert.equal(status.code, 0, describe());
        assert.equal(status.signal, null, describe());
      } finally { clearTimeout(timer); }
    },
    async dispose() {
      if (waiter) reject(new Error('probe disposed'));
      lines.close();
      child.stdin?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

module.exports = { startProbe, OUTPUT_LIMIT };
