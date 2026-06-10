// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Copilot Chat scenario — exercises event queues, custom status, continue-as-new,
 * and wait_for_status_change in a multi-turn conversational pattern.
 *
 * Ported from duroxide/tests/scenarios/copilot_chat.rs
 *
 * Pattern: UI → enqueueEvent("inbox", msg) → Orchestration
 *          Orchestration → scheduleActivity("Generate") → Activity (simulated LLM)
 *          Orchestration → setCustomStatus(reply) → UI polls waitForStatusChange
 *          Orchestration → continueAsNew (keeps history bounded)
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PostgresProvider, Client, Runtime } = require('../lib/duroxide.js');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCHEMA = 'duroxide_node_chat';
const RUN_ID = `chat${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

let provider;

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set.');
  provider = await PostgresProvider.connectWithSchema(dbUrl, SCHEMA);
});

/**
 * Poll waitForStatusChange until custom_status contains a ChatStatus
 * with the given state and msg_seq.
 */
async function waitForChatState(client, instanceId, versionRef, expectedState, expectedSeq) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const remaining = Math.max(100, deadline - Date.now());
    const status = await client.waitForStatusChange(instanceId, versionRef.v, 50, remaining);
    if (status && status.customStatus) {
      versionRef.v = status.customStatusVersion;
      const cs = JSON.parse(status.customStatus);
      if (cs.state === expectedState && cs.msg_seq === expectedSeq) {
        return cs;
      }
    }
  }
  throw new Error(`Timeout waiting for state=${expectedState} seq=${expectedSeq}`);
}

describe('copilot chat scenario', () => {
  it('multi-turn chat with event queues + custom status + continue-as-new', async () => {
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });

    // Activity: simulated LLM response
    runtime.registerActivity('GenerateResponse', async (ctx, userMsg) => {
      return `Echo: ${userMsg}`;
    });

    // Orchestration: each execution handles one message, then continue-as-new
    runtime.registerOrchestration('ChatBot', function* (ctx) {
      // Dequeue next message (blocks until available)
      const msgJson = yield ctx.dequeueEvent('inbox');
      const msg = JSON.parse(msgJson);

      // Call the "LLM" activity
      const response = yield ctx.scheduleActivity('GenerateResponse', msg.text);

      // Publish reply via custom status
      ctx.setCustomStatus(JSON.stringify({
        state: 'replied',
        last_response: response,
        msg_seq: msg.seq,
      }));

      if (msg.text.toLowerCase().includes('bye')) {
        return `Chat ended after ${msg.seq} messages`;
      }

      // Continue as new — custom status and queued events carry forward
      return yield ctx.continueAsNew('');
    });

    await runtime.start();

    try {
      const instanceId = uid('chat');
      await client.startOrchestration(instanceId, 'ChatBot', '');
      const version = { v: 0 };

      // --- Turn 1: "Hello!" ---
      await new Promise((r) => setTimeout(r, 300)); // let orchestration register subscription
      await client.enqueueEvent(instanceId, 'inbox', JSON.stringify({ seq: 1, text: 'Hello!' }));
      const cs1 = await waitForChatState(client, instanceId, version, 'replied', 1);
      assert.strictEqual(cs1.last_response, 'Echo: Hello!');

      // --- Turn 2: "How are you?" ---
      await client.enqueueEvent(instanceId, 'inbox', JSON.stringify({ seq: 2, text: 'How are you?' }));
      const cs2 = await waitForChatState(client, instanceId, version, 'replied', 2);
      assert.strictEqual(cs2.last_response, 'Echo: How are you?');

      // --- Turn 3: "Bye!" — orchestration completes ---
      await client.enqueueEvent(instanceId, 'inbox', JSON.stringify({ seq: 3, text: 'Bye!' }));
      const result = await client.waitForOrchestration(instanceId, 10_000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output, 'Chat ended after 3 messages');
      const finalCs = JSON.parse(result.customStatus);
      assert.strictEqual(finalCs.state, 'replied');
      assert.strictEqual(finalCs.last_response, 'Echo: Bye!');
      assert.strictEqual(finalCs.msg_seq, 3);
    } finally {
      await runtime.shutdown(100);
    }
  });
});
