// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const [nativeDirectory, stageDirectory, mode] = process.argv.slice(2);
assert.ok(nativeDirectory && stageDirectory && ['production', 'instrumented'].includes(mode),
  'usage: node ci/stage-lifecycle.cjs <native-directory> <stage-directory> <production|instrumented>');
const root = path.resolve(__dirname, '..');
const nativeRoot = realpathSync(nativeDirectory);
const stage = path.resolve(stageDirectory);
const target = path.join(root, 'target') + path.sep;
assert.ok(stage.startsWith(target), 'stage must be isolated under this repository target directory');
assert.notEqual(stage, nativeRoot, 'native output and staged sources must use separate directories');
const binaries = readdirSync(nativeRoot).filter(name => /^duroxide\..+\.node$/.test(name));
assert.equal(binaries.length, 1, 'native output must contain exactly one intended platform addon');
// Root-level `node --test` must not rediscover staged copies of the suite.
const sourceRoot = path.join(stage, 'node_modules', 'duroxide');
mkdirSync(sourceRoot, { recursive: true });
const existing = readdirSync(sourceRoot).filter(name => name.endsWith('.node'));
assert.ok(existing.every(name => name === binaries[0]), 'staging directory contains a different native addon');
for (const name of ['index.js', 'index.d.ts', 'package.json', 'lib', '__tests__', 'ci']) {
  cpSync(path.join(root, name), path.join(sourceRoot, name), { recursive: true });
}
const nativePath = path.join(sourceRoot, binaries[0]);
cpSync(path.join(nativeRoot, binaries[0]), nativePath);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sources = {};
function record(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) record(name);
    else sources[name] = hash(path.join(root, name));
  }
}
for (const name of ['src', 'lib', '__tests__', 'ci']) record(name);
for (const name of ['Cargo.toml', 'Cargo.lock', 'package.json', 'index.js']) sources[name] = hash(path.join(root, name));
const manifest = {
  sourceRoot,
  path: realpathSync(nativePath),
  sha256: hash(nativePath),
  instrumented: mode === 'instrumented',
  features: mode === 'instrumented' ? ['test-hooks'] : [],
  sources,
};
writeFileSync(path.join(stage, 'lifecycle-native.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('LIFECYCLE_STAGE ' + JSON.stringify({ stage, path: manifest.path, sha256: manifest.sha256, mode }));
