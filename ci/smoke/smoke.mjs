// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Cross-platform packaging smoke test for the `duroxide` npm package.
//
// IMPORTANT: This file MUST be run from a fresh directory OUTSIDE the repo,
// against an installed `duroxide` package (from a tarball or the registry).
// Running inside the SDK source tree lets napi-rs fall back to the local
// `.node` binary and hides packaging bugs (see GitHub issue microsoft/duroxide#13).
//
// Semantics (MUST stay in sync with the Python smoke script):
//   - Create SqliteProvider on a temp DB file (SQLite is linked statically).
//   - Register a `Hello` activity that returns `Hello, <input>!`.
//   - Register a `HelloWorld` orchestration that calls the activity once.
//   - Start the runtime, start an instance with input "World", wait, assert
//     output === "Hello, World!".

import { SqliteProvider, Client, Runtime } from 'duroxide';
import { mkdtempSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const require = createRequire(import.meta.url);
const nativePath = Object.keys(require.cache).find(file => file.endsWith('.node') && file.includes('duroxide'));
assert.ok(nativePath?.includes(`${sep}node_modules${sep}`), 'smoke must load the installed platform package');
const native = require(nativePath);
assert.equal('_lifecycleTestHooks' in native, false);
assert.equal('LifecycleTestHooks' in native, false);
console.log('[smoke] native=' + JSON.stringify({
  path: nativePath, sha256: createHash('sha256').update(readFileSync(nativePath)).digest('hex'),
}));

const dir = mkdtempSync(join(tmpdir(), 'duroxide-smoke-'));
const dbPath = join(dir, 'smoke.db');

console.log(`[smoke] node=${process.version} platform=${process.platform} arch=${process.arch}`);
console.log(`[smoke] db=${dbPath}`);

const provider = await SqliteProvider.open(dbPath);
const client = new Client(provider);
const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

runtime.registerActivity('Hello', async (_ctx, input) => `Hello, ${input}!`);
runtime.registerOrchestration('HelloWorld', function* (ctx, input) {
  return yield ctx.scheduleActivity('Hello', input);
});

await runtime.start();
try {
  const id = `smoke-${Date.now().toString(36)}`;
  await client.startOrchestration(id, 'HelloWorld', 'World');
  const result = await client.waitForOrchestration(id, 15_000);

  if (result.status !== 'Completed') {
    throw new Error(`[smoke] orchestration did not complete: ${JSON.stringify(result)}`);
  }
  if (result.output !== 'Hello, World!') {
    throw new Error(`[smoke] unexpected output: ${JSON.stringify(result.output)}`);
  }
  console.log(`[smoke] OK status=${result.status} output=${result.output}`);
} finally {
  await runtime.shutdown(200);
}

assert.equal(await runtime.shutdown(0), undefined);
assert.equal(runtime.metricsSnapshot(), null);
const unstarted = new Runtime(provider);
await unstarted.shutdown(0);
await assert.rejects(unstarted.start(), /lifecycle_terminal/);
