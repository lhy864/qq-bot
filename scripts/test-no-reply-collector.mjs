// Exercise the real pumpMux with a parked in-memory DSH stream. No live peers.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sourceIndex = process.argv.indexOf('--bridge-source');
const sourceFile = sourceIndex >= 0 ? path.resolve(process.argv[sourceIndex + 1]) : undefined;

async function feed(h, sid, events) {
  let resolveDrained;
  const drained = new Promise(resolve => { resolveDrained = resolve; });
  h.api.events.mux = async function* () {
    for (const event of events) yield { payload: { type: 'session/event', sessionId: sid, event } };
    resolveDrained();
    // No handles or real I/O; keep the pump from reconnecting a finite fake stream.
    await new Promise(() => {});
  };
  void h.pumpMux();
  await drained;
}

test('idle model/inbox events and unknown turn endings do not make a conversation busy', async () => {
  const h = await bridgeHarness({ sourceFile }); h.setMode('reserved2');
  try {
    const key = 'private:123', sid = await h.ensureSession(key);
    await feed(h, sid, [
      { type: 'model/selection', data: { model: 'fixture-model' } },
      { type: 'inbox/change', data: {} },
      { type: 'user/message', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 999, reason: { kind: 'completed' } } },
    ]);
    assert.equal(h.collectors.has(sid), false);
    assert.equal(h.isConversationBusyV2(key, h.getSocialV2State(key)), false);
  } finally { await h.close(); }
});

test('metadata after a completed turn cannot leave an empty collector blocking new private messages', async () => {
  const h = await bridgeHarness({ sourceFile }); h.setMode('reserved2');
  try {
    const key = 'private:123', sid = await h.ensureSession(key);
    await feed(h, sid, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'fixture reply' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'model/selection', data: { model: 'fixture-model' } },
    ]);
    assert.equal(h.v2TurnStartAt.has(sid), false);
    assert.equal(h.collectors.has(sid), false);
    await h.sendWakePromptV2(key, 'private');
    assert.equal(h.calls.prompts.length, 1, 'new private message should be delivered immediately');
    assert.equal((h.getSocialV2State(key).pendingWakeReasons ?? []).length, 0);
  } finally { await h.close(); }
});

test('a real running turn stays busy and collects complete text across other events', async () => {
  const h = await bridgeHarness({ sourceFile }); h.setMode('reserved2');
  try {
    const key = 'private:123', sid = await h.ensureSession(key);
    await feed(h, sid, [
      { type: 'turn/start', data: { turn: 7 } },
      { type: 'model/selection', data: { model: 'fixture-model' } },
      { type: 'assistant/chunk', data: { turn: 7, text: 'ignored chunk' } },
      { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: 'complete reply' }] } } },
    ]);
    assert.equal(h.collectors.get(sid).has(7), true);
    assert.equal(h.isConversationBusyV2(key, h.getSocialV2State(key)), true);
    const result = h.collectors.get(sid).push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } });
    assert.equal(result.text, 'complete reply');
  } finally { await h.close(); }
});

test('reconnection restores an open turn without replaying a completed historical turn', async () => {
  const h = await bridgeHarness({ sourceFile }); h.setMode('reserved2');
  try {
    const key = 'private:123', sid = await h.ensureSession(key);
    h.rebuildInFlightCollector(sid, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'old history' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'in flight' }] } } },
    ]);
    assert.equal(h.collectors.get(sid).has(1), false);
    assert.equal(h.collectors.get(sid).has(2), true);
    assert.equal(h.isConversationBusyV2(key, h.getSocialV2State(key)), true);
    await feed(h, sid, [
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'inbox/change', data: {} },
    ]);
    assert.equal(h.collectors.has(sid), false);
    assert.equal(h.calls.sent.length, 0, 'reserved2 does not replay plain historical output to QQ');
  } finally { await h.close(); }
});
