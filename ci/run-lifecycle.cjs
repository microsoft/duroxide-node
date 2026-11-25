// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { lifecycleReport, encodedRecords } = require('./lifecycle-report.cjs');

const [mode, directory] = process.argv.slice(2);
assert.ok(['production', 'instrumented'].includes(mode) && directory,
  'usage: node ci/run-lifecycle.cjs <production|instrumented> <stage-directory>');
const stage = path.resolve(directory);
const manifestPath = path.join(stage, 'lifecycle-native.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.instrumented, mode === 'instrumented', 'stage mode differs from requested validation');
assert.equal(manifest.sourceRoot, path.join(stage, 'node_modules', 'duroxide'), 'unexpected staged source root');
const args = ['--test', '--test-reporter=tap',
  path.join(manifest.sourceRoot, '__tests__', 'lifecycle-oracles.test.js'),
  path.join(manifest.sourceRoot, '__tests__', 'lifecycle.test.js')];
const child = spawnSync(process.execPath, args, {
  cwd: manifest.sourceRoot, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  env: {
    ...process.env,
    DUROXIDE_LIFECYCLE_TEST_HOOKS: mode === 'instrumented' ? '1' : '0',
    DUROXIDE_NATIVE_MANIFEST: manifestPath,
  },
});
const stdout = child.stdout ?? '';
const stderr = child.stderr ?? '';
writeFileSync(path.join(stage, 'lifecycle.tap'), stdout);
writeFileSync(path.join(stage, 'lifecycle.stderr.log'), stderr);
process.stdout.write(stdout);
process.stderr.write(stderr);
const evidence = {
  mode, native: manifest, command: [process.execPath, ...args], cwd: manifest.sourceRoot,
  exit: child.status, signal: child.signal, error: child.error?.message,
};
try {
  assert.ifError(child.error);
  assert.equal(child.status, 0, 'lifecycle child must exit successfully');
  assert.equal(child.signal, null, 'lifecycle child must not be terminated');
  evidence.counts = lifecycleReport(stdout, mode);
  const records = encodedRecords(stdout, 'LIFECYCLE_NATIVE_RECORD');
  assert.equal(records.length, 1, 'lifecycle suite must report its native artifact');
  const actual = records[0];
  assert.equal(actual.path, manifest.path);
  assert.equal(actual.sha256, manifest.sha256);
  assert.equal(actual.instrumented, manifest.instrumented);
  evidence.actualNative = actual;
  evidence.probes = encodedRecords(stdout, 'LIFECYCLE_PROBE_RECORD');
} catch (error) {
  evidence.validationFailure = error.stack;
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(stage, 'lifecycle-results.json'), JSON.stringify(evidence, null, 2) + '\n');
}
