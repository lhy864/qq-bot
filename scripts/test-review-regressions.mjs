// Offline regressions: temporary state, fake DSH/OneBot, in-memory HTTP dispatch.
// This file never starts bridge.js or opens a network connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { z } from 'zod';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const baseline = process.argv.includes('--baseline');
const sourceIndex = process.argv.indexOf('--bridge-source');
const bridgeSource = baseline ? new URL('../review/baseline/src/bridge.js', import.meta.url)
  : sourceIndex >= 0 ? path.resolve(process.argv[sourceIndex + 1]) : undefined;
const mcpSource = new URL(baseline ? '../review/baseline/src/mcp-snowluma-safe.js' : '../src/mcp-snowluma-safe.js', import.meta.url);

async function fixture(options = {}) {
  let handler;
  const fakeHttp = {
    createServer(fn) {
      handler = fn;
      const server = new EventEmitter();
      server.address = () => ({ port: 31999 });
      server.listen = (_port, _host, callback) => { server.listening = true; callback(); return server; };
      return server;
    },
  };
  const h = await bridgeHarness({ ...options, sourceFile: bridgeSource, globals: { ...options.globals, http: fakeHttp } });
  h.setMode('reserved2');
  h.startConsoleServer();
  h.request = (url, body, token, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'POST'; req.url = url;
    req.headers = { host: '127.0.0.1:31999', 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...extraHeaders };
    if (token !== undefined) { req.headers['x-agent-call'] = '1'; req.headers['x-agent-token'] = token; }
    req.pause = () => {};
    let status;
    const res = { writeHead(code) { status = code; }, end(text) { resolve({ status, body: JSON.parse(text) }); } };
    Promise.resolve(handler(req, res)).catch(reject);
    queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
  return h;
}

function incoming(id = 456) {
  return { group_id: id, user_id: 789, message_id: 1001, sender: { nickname: 'fixture-peer' }, message: [{ type: 'text', data: { text: 'fixture chat' } }] };
}

test('priority wake exceeding rate limit is retained without ReferenceError', async () => {
  const h = await fixture({ config: { socialV2: { wake: { maxWakePerMinute: 1 } } } });
  try {
    const st = h.getSocialV2State('group:456'); st.lastUnreadSeq = 7; st.wakeTimes = [Date.now()];
    await h.sendWakePromptV2('group:456', 'atMention');
    assert.equal(st.pendingWakeReasons[0].seq, 7);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('watchdog visits Map conversations and stops stale work before recovery', async () => {
  const h = await fixture();
  try {
    const key = 'group:456'; const sid = await h.ensureSession(key); const st = h.getSocialV2State(key);
    st.lastIncomingAt = Date.now() - 600000; st.pendingWakeReasons = [{ reason: 'question', seq: 1 }];
    h.pendingWakeKeys.add(key); h.collectors.set(sid, {}); h.v2TurnStartAt.set(sid, Date.now() - 600000);
    await h.busyWatchdogTick();
    assert.ok(h.calls.cancelled.includes(sid));
    assert.equal(h.collectors.has(sid), false);
    assert.equal(h.pendingWakeKeys.has(key), false);
    assert.ok(st.pendingWakeTimer);
  } finally { await h.close(); }
});

test('failed watchdog cancellation keeps busy flags and pending wake intact', async () => {
  const h = await fixture();
  try {
    const key = 'group:456'; const sid = await h.ensureSession(key); const st = h.getSocialV2State(key);
    st.lastIncomingAt = Date.now() - 600000; st.pendingWakeReasons = [{ reason: 'question', seq: 1 }];
    h.pendingWakeKeys.add(key); h.collectors.set(sid, {}); h.v2TurnStartAt.set(sid, Date.now() - 600000);
    h.api.stopSessionWork = async () => { throw new Error('fixture DSH unavailable'); };
    await h.busyWatchdogTick();
    assert.equal(h.pendingWakeKeys.has(key), true); assert.equal(h.collectors.has(sid), true);
    assert.equal(st.pendingWakeReasons.length, 1); assert.equal(st.pendingWakeTimer, null);
  } finally { await h.close(); }
});

test('follow-up budget and message count survive an actual save/load round trip', async () => {
  let h = await fixture(); let saved;
  try {
    const st = h.getSocialV2State('group:456');
    st.followUpDay = { key: '2026-10-08', count: 2 }; st.msgSinceReset = 37;
    h.saveSocialV2State(); saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.equal(saved.conversations['group:456'].followUpDay.count, 2);
  } finally { await h.close(); }
  h = await fixture({ savedSocialState: saved });
  try { const st = h.getSocialV2State('group:456'); assert.equal(st.followUpDay.count, 2); assert.equal(st.msgSinceReset, 37); }
  finally { await h.close(); }
});

test('conversation affinity survives save/load including its score, log and pending level-up', async () => {
  const affinity = { points: 46, dayKey: '2026-10-08', gainedToday: 4, updatedAt: 1791446400000,
    log: [{ at: 1791446400000, delta: 2, points: 46, reason: 'fixture remembered interaction' }],
    pendingLevelUp: { from: 2, to: 3, name: 'fixture level', at: 1791446400000 } };
  let h = await fixture(); let saved;
  try {
    h.getSocialV2State('group:456').affinity = structuredClone(affinity);
    h.saveSocialV2State(); saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.deepEqual(saved.conversations['group:456'].affinity, affinity);
  } finally { await h.close(); }
  h = await fixture({ savedSocialState: saved });
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(h.getSocialV2State('group:456').affinity)), affinity);
    h.saveSocialV2State();
    const reloaded = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.deepEqual(reloaded.conversations['group:456'].affinity, affinity);
  } finally { await h.close(); }
});

test('only authorized v2 conversational messages increase durable reset count', async () => {
  const h = await fixture();
  try {
    await h.handleIncoming('group', 456, incoming(), h.cfg);
    assert.equal(h.getSocialV2State('group:456').msgSinceReset, 1);
    await h.handleIncoming('group', 999, incoming(999), h.cfg);
    assert.equal(h.socialV2.conversations.has('group:999'), false);
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.equal(saved.conversations['group:456'].msgSinceReset, 1);
  } finally { await h.close(); }
});

test('automatic reset preserves memory and daily budgets while rotating old session token', async () => {
  const h = await fixture({ config: { socialV2: { sessionReset: { maxMessages: 2 } } } });
  try {
    const key = 'group:456'; const sid = await h.ensureSession(key); const st = h.getSocialV2State(key); const oldToken = st.agentToken;
    st.msgSinceReset = 2; st.proactiveDay = { key: '2026-10-08', count: 1 }; st.followUpDay = { key: '2026-10-08', count: 2 };
    st.recentMessages = [{ text: 'fixture topic one' }, { text: 'fixture topic two' }, { text: 'fixture topic three', isSelf: true }];
    h.appendMemoryV2(st, 'activeTopic', 'fixture remembered topic');
    await h.sessionResetTick();
    assert.equal(h.state.sessions[key], undefined); assert.ok(h.calls.cancelled.includes(sid)); assert.ok(h.calls.archived.includes(sid));
    const retained = h.getSocialV2State(key);
    assert.ok(retained.activeTopics.some((t) => t.text.includes('fixture remembered topic')));
    assert.ok(retained.activeTopics.some((t) => t.text.includes('上次聊到')));
    assert.equal(retained.proactiveDay.count, 1); assert.equal(retained.followUpDay.count, 2);
    assert.equal(retained.msgSinceReset, 0); assert.notEqual(retained.agentToken, oldToken);
    assert.equal(h.calls.http.length, 0, 'automatic reset must not loop back through HTTP');
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
    assert.ok(saved.conversations[key].activeTopics.length >= 2);
  } finally { await h.close(); }
});

test('automatic reset defers busy/unread sessions and preserves count on DSH stop failure', async () => {
  const h = await fixture({ config: { socialV2: { sessionReset: { maxMessages: 2 } } } });
  try {
    const key = 'group:456'; const sid = await h.ensureSession(key); const st = h.getSocialV2State(key);
    st.msgSinceReset = 2; st.unread = [{ seq: 1, text: 'fixture unread' }];
    await h.sessionResetTick(); assert.equal(h.state.sessions[key], sid); assert.equal(st.msgSinceReset, 2);
    st.unread = []; h.pendingWakeKeys.add(key);
    await h.sessionResetTick(); assert.equal(h.state.sessions[key], sid);
    h.pendingWakeKeys.delete(key); h.api.stopSessionWork = async () => { throw new Error('fixture stop failed'); };
    await h.sessionResetTick(); assert.equal(h.state.sessions[key], sid); assert.equal(st.msgSinceReset, 2);
  } finally { await h.close(); }
});

test('manual console reset still clears conversation memory and rejects agent callers', async () => {
  const h = await fixture();
  try {
    const key = 'group:456'; const sid = await h.ensureSession(key); const st = h.getSocialV2State(key);
    h.appendMemoryV2(st, 'activeTopic', 'fixture topic');
    assert.equal((await h.request('/api/session/reset', { key }, st.agentToken)).status, 403);
    const result = await h.request('/api/session/reset', { key, preserveMemory: true });
    assert.equal(result.status, 200); assert.equal(h.socialV2.conversations.has(key), false);
    assert.ok(h.calls.cancelled.includes(sid));
  } finally { await h.close(); }
});

test('AI voice endpoint binds target, audits text, obeys pause/limits and records success', async () => {
  const h = await fixture({ config: { socialV2: { send: { maxMessageChars: 30, maxSendPerMinute: 1 } } } });
  try {
    const st = h.getSocialV2State('group:456'); const payload = { groupId: '456', character: 'fixture-voice', text: 'fixture' };
    for (const [body, token, expected] of [[payload, undefined, 403], [{ ...payload, groupId: '999' }, st.agentToken, 403], [{ ...payload, text: 'token=fixture-secret' }, st.agentToken, 403], [{ ...payload, text: 'x'.repeat(31) }, st.agentToken, 400]]) {
      const denied = await h.request('/api/socialV2/ai-voice', body, token);
      assert.equal(denied.status, expected, JSON.stringify(denied.body));
    }
    h.socialV2.paused = true; assert.equal((await h.request('/api/socialV2/ai-voice', payload, st.agentToken)).status, 403);
    h.socialV2.paused = false;
    const result = await h.request('/api/socialV2/ai-voice', payload, st.agentToken);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
    assert.equal(h.calls.http.length, 1); assert.equal(h.calls.http[0].body.group_id, 456);
    assert.ok(st.lastAiReplyAt); assert.equal(st.recentMessages.at(-1).isSelf, true);
    assert.equal((await h.request('/api/socialV2/ai-voice', payload, st.agentToken)).status, 429);
    assert.equal(h.calls.http.length, 1);
  } finally { await h.close(); }
});

test('reaction endpoint accepts only locally known message id/seq from its own conversation', async () => {
  const h = await fixture();
  try {
    const st = h.getSocialV2State('group:456'); st.recentMessages = [{ seq: 7, messageId: '-1001', text: 'fixture' }];
    const payload = { key: 'group:456', messageId: '7', emoji: '76' };
    assert.equal((await h.request('/api/socialV2/react', payload, undefined)).status, 403);
    assert.equal((await h.request('/api/socialV2/react', { ...payload, key: 'group:999' }, st.agentToken)).status, 403);
    assert.equal((await h.request('/api/socialV2/react', { ...payload, messageId: '-9999' }, st.agentToken)).status, 400);
    assert.equal((await h.request('/api/socialV2/react', { ...payload, emoji: 'NaN' }, st.agentToken)).status, 400);
    const result = await h.request('/api/socialV2/react', payload, st.agentToken);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
    assert.equal(h.calls.http.length, 1); assert.equal(h.calls.http[0].body.message_id, -1001);
  } finally { await h.close(); }
});

test('concurrent AI voice calls share the sending budget and recheck permission at dispatch', async () => {
  let release; const outbound = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await fixture({ globals: { fetch: async (url, init) => {
    outbound.push({ url, init }); if (outbound.length === 1) await gate;
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  } } });
  try {
    const st = h.getSocialV2State('group:456'); const payload = { groupId: '456', character: 'fixture-voice', text: 'fixture' };
    const first = h.request('/api/socialV2/ai-voice', payload, st.agentToken);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outbound.length, 1, 'the first request must reach the fake gateway before releasing it');
    const second = h.request('/api/socialV2/ai-voice', payload, st.agentToken);
    await new Promise((resolve) => setImmediate(resolve));
    h.cfg.allow.groups = []; release();
    assert.equal((await first).status, 200); assert.equal((await second).status, 403);
    assert.equal(outbound.length, 1);
  } finally { release(); await h.close(); }
});

test('AI voice gateway failure reports failure and releases reserved sending budget', async () => {
  const h = await fixture({ globals: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1, wording: 'fixture failure' }) }) } });
  try {
    const st = h.getSocialV2State('group:456');
    const result = await h.request('/api/socialV2/ai-voice', { groupId: '456', character: 'fixture-voice', text: 'fixture' }, st.agentToken);
    assert.equal(result.status, 500); assert.equal(result.body.ok, false);
    assert.equal(st.sendTimes.length, 0); assert.equal(st.lastAiReplyAt, 0);
    assert.equal(st.recentMessages.filter((m) => m.isSelf).length, 0);
  } finally { await h.close(); }
});

function mcpTools() {
  const tools = new Map(); const calls = [];
  const source = fs.readFileSync(mcpSource, 'utf8').replace(/^import [^\r\n]*;[\r\n]+/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('file:///fixture/src/mcp-snowluma-safe.js'))
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer { tool(name, description, schema, callback) { tools.set(name, { schema, callback }); } connect() {} }
  vm.runInNewContext(source, {
    McpServer, StdioServerTransport: class {}, z, URL, URLSearchParams, AbortSignal, path, Buffer, process, setTimeout, clearTimeout,
    fileURLToPath: () => '/fixture/src/mcp-snowluma-safe.js', console: { error() {} },
    fs: { readFileSync: (file) => path.basename(String(file)) === 'config.json' ? JSON.stringify({ consoleToken: 'fixture-console-token' }) : 'fixture-console-token' },
    fetch: async (url, init) => { calls.push({ url: String(url), ...init }); return Response.json({ ok: true, messageId: '-1001', emoji: '76' }); },
    SENSITIVE_RE: { test: () => false }, serializeModelData: JSON.stringify,
  });
  return { tools, calls };
}

test('MCP AI voice and reaction require session token and route through the bridge', async () => {
  const { tools, calls } = mcpTools();
  for (const [name, arguments_, endpoint] of [
    ['qq_ai_voice', { groupId: '456', token: 'fixture-agent-token', character: 'fixture-voice', text: 'fixture' }, '/api/socialV2/ai-voice'],
    ['qq_react', { key: 'group:456', token: 'fixture-agent-token', messageId: '-1001', emoji: '76' }, '/api/socialV2/react'],
  ]) {
    const tool = tools.get(name); const schema = z.object(tool.schema);
    assert.equal(schema.safeParse({ ...arguments_, token: undefined }).success, false);
    const result = await tool.callback(schema.parse(arguments_));
    assert.notEqual(result.isError, true); assert.ok(calls.at(-1).url.endsWith(endpoint));
    assert.equal(calls.at(-1).headers['x-agent-token'], 'fixture-agent-token');
    assert.equal(calls.at(-1).headers['x-agent-call'], '1');
  }
});
