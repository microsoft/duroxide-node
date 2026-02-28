/**
 * Tests for async block patterns — ported from Rust core async_block_tests.
 * In Rust, multi-step async blocks can be joined/raced directly.
 * In Node.js SDK, multi-step blocks are wrapped as sub-orchestrations,
 * then the parent uses all()/race() on sub-orchestration descriptors.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PostgresProvider, Client, Runtime } = require('../lib/duroxide.js');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCHEMA = 'duroxide_node_async_blocks';
const RUN_ID = `ab${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

let provider;

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL not set. Create a .env file or export DATABASE_URL.');
  }
  provider = await PostgresProvider.connectWithSchema(dbUrl, SCHEMA);
});

async function runOrchestration(name, input, registerFn, timeoutMs = 10_000) {
  const client = new Client(provider);
  const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
  registerFn(runtime);
  await runtime.start();
  try {
    const instanceId = uid(name);
    await client.startOrchestration(instanceId, name, input);
    return await client.waitForOrchestration(instanceId, timeoutMs);
  } finally {
    await runtime.shutdown(100);
  }
}

// ─── Async block patterns ────────────────────────────────────────

describe('async block patterns', () => {

  // Test 1: async block join with control flow
  it('async block join with control flow', async () => {
    const result = await runOrchestration('AB_JoinBlocks', null, (rt) => {
      rt.registerActivity('Step', async (ctx, input) => `step:${input}`);
      rt.registerActivity('Check', async (ctx, input) => `check:${input}`);

      rt.registerOrchestration('AB_JoinBlockA', function* (ctx) {
        const first = yield ctx.scheduleActivity('Step', 'A1');
        let second;
        if (first.includes('step')) {
          second = yield ctx.scheduleActivity('Step', 'A2');
        }
        return `A:[${first},${second}]`;
      });

      rt.registerOrchestration('AB_JoinBlockB', function* (ctx) {
        const check = yield ctx.scheduleActivity('Check', 'B1');
        const results = [check];
        for (let i = 2; i <= 3; i++) {
          results.push(yield ctx.scheduleActivity('Step', `B${i}`));
        }
        return `B:[${results.join(',')}]`;
      });

      rt.registerOrchestration('AB_JoinBlockC', function* (ctx) {
        yield ctx.scheduleTimer(5);
        const result = yield ctx.scheduleActivity('Step', 'C1');
        return `C:[timer,${result}]`;
      });

      rt.registerOrchestration('AB_JoinBlocks', function* (ctx) {
        const results = yield ctx.all([
          ctx.scheduleSubOrchestration('AB_JoinBlockA', null),
          ctx.scheduleSubOrchestration('AB_JoinBlockB', null),
          ctx.scheduleSubOrchestration('AB_JoinBlockC', null),
        ]);
        return results.map((r) => r.ok).join(',');
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.includes('A:[step:A1,step:A2]'), `expected A block, got: ${result.output}`);
    assert.ok(result.output.includes('B:[check:B1,step:B2,step:B3]'), `expected B block, got: ${result.output}`);
    assert.ok(result.output.includes('C:[timer,step:C1]'), `expected C block, got: ${result.output}`);
  });

  // Test 2: async block join many
  it('async block join many', async () => {
    const result = await runOrchestration('AB_JoinMany', null, (rt) => {
      rt.registerActivity('Work', async (ctx, input) => `done:${input}`);

      rt.registerOrchestration('AB_JoinManyBlock', function* (ctx, input) {
        const [index, delay] = input.split(':');
        const result = yield ctx.scheduleActivity('Work', delay);
        return `block${index}:${result}`;
      });

      rt.registerOrchestration('AB_JoinMany', function* (ctx) {
        const descs = [];
        for (let i = 0; i < 5; i++) {
          descs.push(ctx.scheduleSubOrchestration('AB_JoinManyBlock', `${i}:${(5 - i) * 5}`));
        }
        const results = yield ctx.all(descs);
        return results.map((r) => r.ok).join(',');
      });
    });
    assert.strictEqual(result.status, 'Completed');
    for (let i = 0; i < 5; i++) {
      assert.ok(
        result.output.includes(`block${i}:done:${(5 - i) * 5}`),
        `expected block${i}, got: ${result.output}`,
      );
    }
  });

  // Test 3: async block sequential (NO sub-orchs — sequential yields)
  it('async block sequential', async () => {
    const result = await runOrchestration('AB_SequentialBlocks', 'start', (rt) => {
      rt.registerActivity('Process', async (ctx, input) => `processed:${input}`);

      rt.registerOrchestration('AB_SequentialBlocks', function* (ctx, input) {
        const a = yield ctx.scheduleActivity('Process', input);
        const b = yield ctx.scheduleActivity('Process', 'extra');
        const phase1 = `${a}+${b}`;
        const phase2 = yield ctx.scheduleActivity('Process', phase1);
        yield ctx.scheduleTimer(5);
        const final_ = yield ctx.scheduleActivity('Process', phase2);
        return `final:${final_}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('final:'), `expected starts with final:, got: ${result.output}`);
    assert.ok(result.output.includes('processed:'), `expected contains processed:, got: ${result.output}`);
  });

  // Test 4: async block select racing
  it('async block select racing', async () => {
    const result = await runOrchestration('AB_RaceBlocks', null, (rt) => {
      rt.registerActivity('Fast', async (ctx, input) => `fast:${input}`);
      rt.registerActivity('Slow', async (ctx, input) => `slow:${input}`);

      rt.registerOrchestration('AB_RaceFastBlock', function* (ctx) {
        const a = yield ctx.scheduleActivity('Fast', '1');
        const b = yield ctx.scheduleActivity('Fast', '2');
        return `fast_block:[${a},${b}]`;
      });

      rt.registerOrchestration('AB_RaceSlowBlock', function* (ctx) {
        yield ctx.scheduleTimer(60000);
        const a = yield ctx.scheduleActivity('Slow', '1');
        const b = yield ctx.scheduleActivity('Slow', '2');
        return `slow_block:[${a},${b}]`;
      });

      rt.registerOrchestration('AB_RaceBlocks', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_RaceFastBlock', null),
          ctx.scheduleSubOrchestration('AB_RaceSlowBlock', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:0,'), `expected winner:0, got: ${result.output}`);
    assert.ok(result.output.includes('fast_block:[fast:1,fast:2]'), `expected fast_block, got: ${result.output}`);
  });

  // Test 5: async block vs durable future
  it('async block vs durable future', async () => {
    const result = await runOrchestration('AB_BlockVsFuture', null, (rt) => {
      rt.registerActivity('Quick', async (ctx, input) => `quick:${input}`);
      rt.registerActivity('Multi', async (ctx, input) => `multi:${input}`);

      rt.registerOrchestration('AB_MultiStepBlock', function* (ctx) {
        yield ctx.scheduleTimer(60000);
        const a = yield ctx.scheduleActivity('Multi', '1');
        const b = yield ctx.scheduleActivity('Multi', '2');
        return `block:[${a},${b}]`;
      });

      rt.registerOrchestration('AB_BlockVsFuture', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleActivity('Quick', 'single'),
          ctx.scheduleSubOrchestration('AB_MultiStepBlock', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:0,'), `expected winner:0, got: ${result.output}`);
    assert.ok(result.output.includes('quick:single'), `expected quick:single, got: ${result.output}`);
  });

  // Test 6: async block select3 with timers
  // Node.js race() supports exactly 2 tasks — group B+C into a wrapper sub-orch
  it('async block select3 with timers', async () => {
    const result = await runOrchestration('AB_Select3Timers', null, (rt) => {
      rt.registerActivity('Work', async (ctx, input) => `work:${input}`);

      rt.registerOrchestration('AB_TimerBlockA', function* (ctx) {
        yield ctx.scheduleTimer(1);
        const result = yield ctx.scheduleActivity('Work', 'A');
        return `A:${result}`;
      });

      rt.registerOrchestration('AB_TimerBlockB', function* (ctx) {
        yield ctx.scheduleTimer(60000);
        const result = yield ctx.scheduleActivity('Work', 'B');
        return `B:${result}`;
      });

      rt.registerOrchestration('AB_TimerBlockC', function* (ctx) {
        yield ctx.scheduleTimer(30000);
        const result = yield ctx.scheduleActivity('Work', 'C');
        return `C:${result}`;
      });

      // Group B and C behind a single sub-orch for the 2-arg race
      rt.registerOrchestration('AB_SlowTimerGroup', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_TimerBlockB', null),
          ctx.scheduleSubOrchestration('AB_TimerBlockC', null),
        );
        return winner.value;
      });

      rt.registerOrchestration('AB_Select3Timers', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_TimerBlockA', null),
          ctx.scheduleSubOrchestration('AB_SlowTimerGroup', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:0,'), `expected winner:0, got: ${result.output}`);
    assert.ok(result.output.includes('A:work:A'), `expected A:work:A, got: ${result.output}`);
  });

  // Test 7: async block nested join in select
  it('async block nested join in select', async () => {
    const result = await runOrchestration('AB_NestedJoinSelect', null, (rt) => {
      rt.registerActivity('Step', async (ctx, input) => `step:${input}`);

      rt.registerOrchestration('AB_WorkBlock', function* (ctx) {
        const results = yield ctx.all([
          ctx.scheduleActivity('Step', '1'),
          ctx.scheduleActivity('Step', '2'),
          ctx.scheduleActivity('Step', '3'),
        ]);
        return `work:[${results.map((r) => r.ok).join(',')}]`;
      });

      rt.registerOrchestration('AB_TimeoutBlock', function* (ctx) {
        yield ctx.scheduleTimer(60000);
        return 'timeout';
      });

      rt.registerOrchestration('AB_NestedJoinSelect', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_WorkBlock', null),
          ctx.scheduleSubOrchestration('AB_TimeoutBlock', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:0,'), `expected winner:0, got: ${result.output}`);
    assert.ok(result.output.includes('step:1'), `expected step:1, got: ${result.output}`);
    assert.ok(result.output.includes('step:2'), `expected step:2, got: ${result.output}`);
    assert.ok(result.output.includes('step:3'), `expected step:3, got: ${result.output}`);
  });

  // Test 8: async block sub-orchestration wins race
  it('async block sub-orchestration wins race', async () => {
    const result = await runOrchestration('AB_RaceParent', null, (rt) => {
      rt.registerActivity('FastWork', async (ctx, input) => `fast:${input}`);
      rt.registerActivity('SlowWork', async (ctx, input) => `slow:${input}`);

      rt.registerOrchestration('AB_FastChild', function* (ctx, input) {
        const result = yield ctx.scheduleActivity('FastWork', input);
        return `child:${result}`;
      });

      rt.registerOrchestration('AB_SubOrchBlock', function* (ctx) {
        const sub = yield ctx.scheduleSubOrchestration('AB_FastChild', 'sub-input');
        const act = yield ctx.scheduleActivity('FastWork', 'after-sub');
        return `blockA:[${sub},${act}]`;
      });

      rt.registerOrchestration('AB_SlowBlock8', function* (ctx) {
        yield ctx.scheduleTimer(60000);
        const a = yield ctx.scheduleActivity('SlowWork', '1');
        const b = yield ctx.scheduleActivity('SlowWork', '2');
        return `blockB:[${a},${b}]`;
      });

      rt.registerOrchestration('AB_RaceParent', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_SubOrchBlock', null),
          ctx.scheduleSubOrchestration('AB_SlowBlock8', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:0,'), `expected winner:0, got: ${result.output}`);
    assert.ok(result.output.includes('child:fast:sub-input'), `expected child:fast:sub-input, got: ${result.output}`);
    assert.ok(result.output.includes('fast:after-sub'), `expected fast:after-sub, got: ${result.output}`);
  });

  // Test 9: async block sub-orchestration loses race
  it('async block sub-orchestration loses race', async () => {
    const result = await runOrchestration('AB_RaceParentLoses', null, (rt) => {
      rt.registerActivity('Fast', async (ctx, input) => `fast:${input}`);
      rt.registerActivity('VerySlow', async (ctx, input) => `veryslow:${input}`);

      rt.registerOrchestration('AB_SlowChild', function* (ctx, input) {
        yield ctx.scheduleTimer(60000);
        const a = yield ctx.scheduleActivity('VerySlow', input + '-1');
        const b = yield ctx.scheduleActivity('VerySlow', input + '-2');
        return `child:[${a},${b}]`;
      });

      rt.registerOrchestration('AB_SlowSubOrchBlock', function* (ctx) {
        const sub = yield ctx.scheduleSubOrchestration('AB_SlowChild', 'sub-input');
        return `blockA:${sub}`;
      });

      rt.registerOrchestration('AB_FastBlock9', function* (ctx) {
        const a = yield ctx.scheduleActivity('Fast', '1');
        const b = yield ctx.scheduleActivity('Fast', '2');
        return `blockB:[${a},${b}]`;
      });

      rt.registerOrchestration('AB_RaceParentLoses', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_SlowSubOrchBlock', null),
          ctx.scheduleSubOrchestration('AB_FastBlock9', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:1,'), `expected winner:1, got: ${result.output}`);
    assert.ok(result.output.includes('blockB:[fast:1,fast:2]'), `expected blockB, got: ${result.output}`);
  });

  // Test 10: async block multiple sub-orchestrations joined
  it('async block multiple sub-orchestrations joined', async () => {
    const result = await runOrchestration('AB_JoinSubOrchParent', 'data', (rt) => {
      rt.registerActivity('Transform', async (ctx, input) => `transformed:${input}`);

      rt.registerOrchestration('AB_ChildA', function* (ctx, input) {
        const result = yield ctx.scheduleActivity('Transform', 'A-' + input);
        return `childA:${result}`;
      });

      rt.registerOrchestration('AB_ChildB', function* (ctx, input) {
        const r1 = yield ctx.scheduleActivity('Transform', 'B1-' + input);
        const r2 = yield ctx.scheduleActivity('Transform', 'B2-' + input);
        return `childB:[${r1},${r2}]`;
      });

      rt.registerOrchestration('AB_ChildC', function* (ctx, input) {
        yield ctx.scheduleTimer(5);
        const result = yield ctx.scheduleActivity('Transform', 'C-' + input);
        return `childC:timer+${result}`;
      });

      rt.registerOrchestration('AB_JoinBlock1', function* (ctx, input) {
        const sub = yield ctx.scheduleSubOrchestration('AB_ChildA', input);
        const act = yield ctx.scheduleActivity('Transform', 'block1-extra');
        return `block1:[${sub},${act}]`;
      });

      rt.registerOrchestration('AB_JoinBlock2', function* (ctx, input) {
        const sub = yield ctx.scheduleSubOrchestration('AB_ChildB', input);
        return `block2:${sub}`;
      });

      rt.registerOrchestration('AB_JoinBlock3', function* (ctx, input) {
        const act = yield ctx.scheduleActivity('Transform', 'block3-first');
        const sub = yield ctx.scheduleSubOrchestration('AB_ChildC', input);
        return `block3:[${act},${sub}]`;
      });

      rt.registerOrchestration('AB_JoinSubOrchParent', function* (ctx, input) {
        const results = yield ctx.all([
          ctx.scheduleSubOrchestration('AB_JoinBlock1', input),
          ctx.scheduleSubOrchestration('AB_JoinBlock2', input),
          ctx.scheduleSubOrchestration('AB_JoinBlock3', input),
        ]);
        return results.map((r) => r.ok).join(',');
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.includes('block1:'), `expected block1:, got: ${result.output}`);
    assert.ok(result.output.includes('childA:'), `expected childA:, got: ${result.output}`);
    assert.ok(result.output.includes('block2:'), `expected block2:, got: ${result.output}`);
    assert.ok(result.output.includes('childB:'), `expected childB:, got: ${result.output}`);
    assert.ok(result.output.includes('block3:'), `expected block3:, got: ${result.output}`);
    assert.ok(result.output.includes('childC:'), `expected childC:, got: ${result.output}`);
  });

  // Test 11: async block sub-orchestration racing timeout
  // Node.js race() supports exactly 2 tasks — group slow+timeout into a wrapper
  it('async block sub-orchestration racing timeout', async () => {
    const result = await runOrchestration('AB_TimeoutRaceParent', null, (rt) => {
      rt.registerActivity('Work', async (ctx, input) => `work:${input}`);
      rt.registerActivity('SlowWork', async (ctx, input) => `slowwork:${input}`);

      rt.registerOrchestration('AB_FastChild2', function* (ctx, input) {
        const result = yield ctx.scheduleActivity('Work', input);
        return `fast-child:${result}`;
      });

      rt.registerOrchestration('AB_SlowChild2', function* (ctx, input) {
        yield ctx.scheduleTimer(60000);
        const result = yield ctx.scheduleActivity('SlowWork', input);
        return `slow-child:${result}`;
      });

      rt.registerOrchestration('AB_FastSubBlock', function* (ctx) {
        const sub = yield ctx.scheduleSubOrchestration('AB_FastChild2', 'fast-input');
        return `blockA:${sub}`;
      });

      rt.registerOrchestration('AB_SlowSubBlock', function* (ctx) {
        const sub = yield ctx.scheduleSubOrchestration('AB_SlowChild2', 'slow-input');
        return `blockB:${sub}`;
      });

      rt.registerOrchestration('AB_TimeoutOnlyBlock', function* (ctx) {
        yield ctx.scheduleTimer(120000);
        return 'blockC:timeout';
      });

      // Group slow + timeout behind a single sub-orch for the 2-arg race
      rt.registerOrchestration('AB_SlowTimeoutGroup', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_SlowSubBlock', null),
          ctx.scheduleSubOrchestration('AB_TimeoutOnlyBlock', null),
        );
        return winner.value;
      });

      rt.registerOrchestration('AB_TimeoutRaceParent', function* (ctx) {
        const winner = yield ctx.race(
          ctx.scheduleSubOrchestration('AB_FastSubBlock', null),
          ctx.scheduleSubOrchestration('AB_SlowTimeoutGroup', null),
        );
        return `winner:${winner.index},result:${winner.value}`;
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.startsWith('winner:0,'), `expected winner:0, got: ${result.output}`);
    assert.ok(result.output.includes('fast-child:work:fast-input'), `expected fast-child:work:fast-input, got: ${result.output}`);
  });

  // Test 12: async block nested sub-orchestration chain
  it('async block nested sub-orchestration chain', async () => {
    const result = await runOrchestration('AB_NestedParent', 'root', (rt) => {
      rt.registerActivity('Leaf', async (ctx, input) => `leaf:${input}`);

      rt.registerOrchestration('AB_Grandchild', function* (ctx, input) {
        const result = yield ctx.scheduleActivity('Leaf', input);
        return `grandchild:${result}`;
      });

      rt.registerOrchestration('AB_Child', function* (ctx, input) {
        const results = yield ctx.all([
          ctx.scheduleSubOrchestration('AB_Grandchild', 'gc-' + input),
          ctx.scheduleActivity('Leaf', 'child-' + input),
        ]);
        const gc = results[0].ok;
        const own = results[1].ok;
        return `child:[${gc},${own}]`;
      });

      rt.registerOrchestration('AB_ChainBlock1', function* (ctx, input) {
        const sub = yield ctx.scheduleSubOrchestration('AB_Child', 'c1-' + input);
        return `block1:${sub}`;
      });

      rt.registerOrchestration('AB_ChainBlock2', function* (ctx, input) {
        yield ctx.scheduleTimer(5);
        const sub = yield ctx.scheduleSubOrchestration('AB_Child', 'c2-' + input);
        return `block2:timer+${sub}`;
      });

      rt.registerOrchestration('AB_NestedParent', function* (ctx, input) {
        const results = yield ctx.all([
          ctx.scheduleSubOrchestration('AB_ChainBlock1', input),
          ctx.scheduleSubOrchestration('AB_ChainBlock2', input),
        ]);
        return results.map((r) => r.ok).join(',');
      });
    });
    assert.strictEqual(result.status, 'Completed');
    assert.ok(result.output.includes('block1:'), `expected block1:, got: ${result.output}`);
    assert.ok(result.output.includes('block2:timer+'), `expected block2:timer+, got: ${result.output}`);
    assert.ok(result.output.includes('grandchild:'), `expected grandchild:, got: ${result.output}`);
    assert.ok(result.output.includes('child:'), `expected child:, got: ${result.output}`);
  });
});
