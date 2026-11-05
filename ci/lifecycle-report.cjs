// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');

function lifecycleReport(stdout, mode) {
  assert.ok(['production', 'instrumented'].includes(mode), 'explicit lifecycle mode is required');
  const count = label => {
    const found = [...stdout.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm'))];
    assert.equal(found.length, 1, `missing or ambiguous TAP total: ${label}`);
    return Number(found[0][1]);
  };
  const result = {
    selected: count('tests'), passed: count('pass'), failed: count('fail'),
    skipped: count('skipped'), aborted: count('cancelled'), todo: count('todo'),
    requiredHookCases: [...stdout.matchAll(/^# Subtest: \[instrumented\] /gm)].length,
  };
  assert.ok(result.selected > 0 && result.passed > 0, 'lifecycle selection must execute tests');
  assert.ok(result.requiredHookCases > 0, 'required instrumented cases were not selected');
  assert.equal(result.failed, 0, 'lifecycle tests failed');
  assert.equal(result.aborted, 0, 'lifecycle tests aborted');
  assert.equal(result.todo, 0, 'lifecycle tests may not be TODO');
  const skips = stdout.split(/\r?\n/).filter(line => /^ok \d+ - .* # SKIP(?:\s|$)/.test(line));
  assert.equal(skips.length, result.skipped, 'skip accounting mismatch');
  if (mode === 'instrumented') {
    assert.equal(result.skipped, 0, 'required instrumented lifecycle cases must execute, not skip');
  } else {
    assert.equal(result.skipped, result.requiredHookCases, 'production may skip only hook-dependent cases');
    assert.ok(skips.every(line => /^ok \d+ - \[instrumented\] /.test(line)), 'non-hook lifecycle test was skipped');
  }
  assert.equal(result.selected, result.passed + result.skipped, 'incomplete lifecycle result totals');
  return result;
}

function encodedRecords(stdout, name) {
  assert.match(name, /^[A-Z_]+$/);
  return [...stdout.matchAll(new RegExp(`^# ${name} ([A-Za-z0-9+/=]+)\\r?$`, 'gm'))]
    .map(match => JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')));
}

module.exports = { lifecycleReport, encodedRecords };
