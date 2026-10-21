// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

function identifyNative(loaderPath, cache = require.cache) {
  const loader = cache[loaderPath];
  assert.ok(loader, `Duroxide loader was not loaded: ${loaderPath}`);
  assert.equal(typeof loader.exports.JsRuntime, 'function', 'Duroxide loader must expose its native Runtime');
  const candidates = Object.values(cache).filter(module =>
    module.filename?.endsWith('.node') &&
    module.exports?.JsRuntime === loader.exports.JsRuntime &&
    module.exports?.JsClient === loader.exports.JsClient &&
    module.exports?.JsSqliteProvider === loader.exports.JsSqliteProvider);
  assert.equal(candidates.length, 1, 'expected exactly one native module supplying the Duroxide bindings');
  const module = candidates[0];
  assert.match(path.basename(module.filename), /^duroxide\..+\.node$/);
  return module;
}

function nativeProvenance(root, { installed = false, instrumented = false, manifestPath } = {}) {
  root = realpathSync(root);
  const module = identifyNative(require.resolve(path.join(root, 'index.js')));
  const nativePath = realpathSync(module.filename);
  const native = module.exports;
  assert.equal('_lifecycleTestHooks' in native, instrumented, 'native hook export boundary mismatch');
  assert.equal('LifecycleTestHooks' in native, instrumented, 'native hook class export boundary mismatch');
  assert.equal(typeof native._lifecycleTestHooks === 'function', instrumented, 'native hook mode mismatch');
  assert.equal(typeof native.LifecycleTestHooks === 'function', instrumented, 'native hook class mode mismatch');
  if (installed) {
    const sdkPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const platformPackage = JSON.parse(readFileSync(path.join(path.dirname(nativePath), 'package.json'), 'utf8'));
    assert.equal(sdkPackage.name, 'duroxide');
    assert.ok(nativePath.includes(`${path.sep}node_modules${path.sep}`), 'smoke requires an installed platform package');
    assert.ok(Object.hasOwn(sdkPackage.optionalDependencies, platformPackage.name), 'native module is not a declared Duroxide platform package');
    assert.equal(platformPackage.version, sdkPackage.version, 'SDK/platform package version mismatch');
    assert.notEqual(path.dirname(nativePath), root, 'smoke must not use a repository-local addon');
  } else {
    assert.equal(path.dirname(nativePath), root, 'lifecycle tests require the intended local addon, not an optional platform package');
  }
  const provenance = {
    path: nativePath,
    sha256: createHash('sha256').update(readFileSync(nativePath)).digest('hex'),
    instrumented,
  };
  if (manifestPath) {
    const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(realpathSync(expected.path), nativePath, 'native artifact path differs from staged build');
    assert.equal(expected.sha256, provenance.sha256, 'native artifact hash differs from staged build');
    assert.equal(expected.instrumented, instrumented, 'staged build mode mismatch');
    assert.deepEqual(expected.features, instrumented ? ['test-hooks'] : [], 'staged feature declaration mismatch');
  }
  return { native, provenance };
}

module.exports = { identifyNative, nativeProvenance };
