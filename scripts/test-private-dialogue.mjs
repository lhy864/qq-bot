import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run) {
  let handler;
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, sticker: { enabled: false } } },
    globals: { http: { ...http, createServer(fn) {
      handler = fn; const stub = new EventEmitter(); stub.address = () => ({ port: h.cfg.consolePort });
      stub.listen = (_p, _host, done) => { done(); return stub; }; return stub;
    } } } });
  h.setMode('reserved2'); h.setReady(true);
  await h.ensureSession('private:123', 'private', '123');
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  h.cfg.consolePort = server.address().port; h.startConsoleServer();
  const request = async (route, body, agentKey) => {
    const r = await fetch(`http://127.0.0.1:${h.cfg.consolePort}${route}`, { method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json',
        ...(agentKey ? { 'x-agent-call': '1', 'x-agent-token': h.getSocialV2State(agentKey).agentToken } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { code: r.status, data: await r.json() };
  };
  const dialogue = (action, extra = {}, key = 'private:123') => request('/api/debug/private-dialogue-test', { key, runId: 'acceptance-fixture', action, ...extra });
  try { await run(h, request, dialogue); }
  finally { await dialogue('finish'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('normal acceptance path accepts only existing owner private chat and cannot be started by agent', () => fixture(async (h, request, dialogue) => {
  assert.equal((await dialogue('start', {}, 'group:456')).code, 403);
  assert.equal((await dialogue('start', {}, 'private:999')).code, 403);
  assert.equal((await request('/api/debug/private-dialogue-test', { key: 'private:123', action: 'start', runId: 'acceptance-fixture' }, 'private:123')).code, 403);
  assert.equal((await dialogue('message', { requestId: 'first', text: '别开玩笑了' })).code, 409);
  assert.equal((await dialogue('start')).code, 200);
  assert.equal((await dialogue('message', { requestId: 'first', text: '/重置' })).code, 400);
  const before = h.getSocialV2State('private:123').lastUnreadSeq;
  const r = await dialogue('message', { requestId: 'first', text: '别开玩笑了' });
  assert.equal(r.code, 200); assert.equal(r.data.seq, before + 1); assert.equal(r.data.normalPrivatePath, true);
  const st = h.getSocialV2State('private:123');
  assert.equal(st.recentMessages.length, 1); assert.equal(st.unread.length, 1);
  assert.equal(st.recentMessages[0].isOwner, true);
  assert.deepEqual(Array.from(st.expressionQuietTargets), ['123']);
  const retry = await dialogue('message', { requestId: 'first', text: '别开玩笑了' });
  assert.equal(retry.data.seq, r.data.seq); assert.equal(st.unread.length, 1);
  await dialogue('finish'); assert.deepEqual(Array.from(st.expressionQuietTargets), []);
}));

test('test lease blocks unrelated actions and old memories without changing another chat', () => fixture(async (h, request, dialogue) => {
  const st = h.getSocialV2State('private:123');
  st.continuity = { version: 1, sharedEvents: [{ id: 'old-id', text: 'old event', createdAt: Date.now(), updatedAt: Date.now(), evidence: [] }], commitments: [] };
  assert.equal((await dialogue('start')).code, 200);
  assert.equal((await request('/api/send/group', { key: 'group:456', groupId: 456, message: 'unexpected' }, 'private:123')).code, 403);
  assert.equal((await request('/api/socialV2/memory-clear', { key: 'private:123', category: 'sharedEvent' }, 'private:123')).code, 403);
  assert.equal((await request('/api/socialV2/memory-append', { key: 'private:123', category: 'person', content: 'bad fact', extra: { target: 'fixture' } }, 'private:123')).code, 403);
  assert.equal((await request('/api/socialV2/memory-update', { key: 'private:123', category: 'sharedEvent', id: 'old-id', newContent: 'overwrite' }, 'private:123')).code, 403);
  assert.equal((await request('/api/socialV2/state?key=group:456', null, 'group:456')).code, 200);
  assert.equal((await request('/api/socialV2/state?key=private:123', null, 'private:123')).code, 200);
  await dialogue('finish'); assert.equal(st.continuity.sharedEvents[0].text, 'old event');
}));

test('real incoming private message interrupts further automatic test input', () => fixture(async (h, request, dialogue) => {
  assert.equal((await dialogue('start')).code, 200);
  await h.handleIncoming('private', '123', { user_id: '123', message_id: 'real-qq-id', sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: '别开玩笑了，这是真实来信' } }] }, h.cfg);
  assert.equal((await dialogue('message', { requestId: 'first', text: '测试输入' })).code, 409);
  assert.equal(h.getSocialV2State('private:123').recentMessages.length, 1);
  await dialogue('finish'); assert.deepEqual(Array.from(h.getSocialV2State('private:123').expressionQuietTargets), ['123']);
}));

test('legacy selftest injection no longer doubles unread sequence and returns canonical seq', () => fixture(async (h, request) => {
  const st = h.getSocialV2State('private:123');
  const r = await request('/api/debug/selftest', { key: 'private:123', injectMessage: 'legacy fixture', wake: false });
  assert.equal(r.code, 200); assert.equal(r.data.seq, 1); assert.equal(st.lastUnreadSeq, 1);
  assert.equal(st.unread.length, 1); assert.equal(st.recentMessages.length, 1);
}));

test('actual MCP text send works during private acceptance with fake QQ transport', () => fixture(async (h, request, dialogue) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temp = fs.mkdtempSync(path.join(root, '.tmp-private-mcp-'));
  fs.mkdirSync(path.join(temp, 'src')); fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ consolePort: h.cfg.consolePort, consoleToken: 'fixture-console-token', socialV2: { enabled: true } }));
  for (const rel of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js', 'bili.js']) fs.copyFileSync(path.join(root, 'src', rel), path.join(temp, 'src', rel));
  const client = new Client({ name: 'private-dialogue-fixture', version: '1' });
  try {
    await dialogue('start');
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(temp, 'src/mcp-snowluma-safe.js')], stderr: 'pipe' }));
    const reply = await client.callTool({ name: 'qq_send_message', arguments: {
      key: 'private:123', token: h.getSocialV2State('private:123').agentToken, messages: 'fixture acceptance reply' } });
    assert.notEqual(reply.isError, true, reply.content?.[0]?.text);
    const sends = h.calls.http.filter(x => /\/send_private_msg$/.test(x.url));
    assert.equal(sends.length, 1); assert.equal(String(sends[0].body.user_id), '123');
  } finally { await client.close(); assert.equal(path.dirname(temp), path.resolve(root)); fs.rmSync(temp, { recursive: true }); }
}));

test('fresh-context keeps saved memory and original DSH session while suppressing old chat replay', () => fixture(async (h, request, dialogue) => {
  const key = 'private:123', st = h.getSocialV2State(key), original = h.state.sessions[key], oldToken = st.agentToken;
  st.recentMessages = [{ seq: 1, time: Date.now() - 10000, text: 'fixture seed chat', messageId: 'seed-chat', isSelf: false },
    { time: Date.now() - 9000, text: 'fixture old reply without seq', isSelf: true }];
  st.lastUnreadSeq = 1;
  st.continuity = { version: 1, sharedEvents: [{ id: 'saved-event', text: 'fixture persisted detail', keywords: ['fixture', 'seed'], createdAt: Date.now(), updatedAt: Date.now(), evidence: [] }], commitments: [] };
  const journal = JSON.stringify(st.continuity);
  const groupSession = await h.ensureSession('group:456');
  assert.equal((await dialogue('fresh-context')).code, 409);
  await dialogue('start');
  const switched = await dialogue('fresh-context'); assert.equal(switched.code, 200);
  assert.notEqual(switched.data.newSessionId, original); assert.equal(switched.data.previousSessionId, original);
  assert.equal(h.state.sessions['group:456'], groupSession); assert.equal(JSON.stringify(st.continuity), journal);
  assert.ok(h.calls.cancelled.includes(original)); assert.ok(!h.calls.archived.includes(original)); assert.notEqual(st.agentToken, oldToken);
  const retry = await dialogue('fresh-context'); assert.equal(retry.data.newSessionId, switched.data.newSessionId);
  const tokenRejected = await fetch(`http://127.0.0.1:${h.cfg.consolePort}/api/socialV2/recent?key=${key}`, {
    headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': oldToken } });
  assert.equal(tokenRejected.status, 403);
  assert.equal((await request(`/api/socialV2/recent?key=${key}`, null, key)).data.messages.length, 0);
  assert.equal((await request(`/api/socialV2/my-recent?key=${key}`, null, key)).data.messages.length, 0);
  assert.equal((await request(`/api/socialV2/message-detail?key=${key}&messageId=seed-chat`, null, key)).code, 403);
  assert.equal((await request(`/api/socialV2/recent?key=${key}`)).data.messages.length, 2);
  const snapshot = h.buildWakeSnapshotV2(key); assert.equal(snapshot.recent.length, 0);
  assert.doesNotMatch(h.buildWakePromptV2(key, 'private'), /fixture seed chat|fixture old reply/);
  await dialogue('message', { requestId: 'recall', text: 'fixture seed recall cue' });
  assert.match(h.buildWakePromptV2(key, 'private'), /fixture persisted detail/);
  const next = h.buildWakeSnapshotV2(key); assert.equal(next.recent.length, 0); assert.equal(next.messages[0].text, 'fixture seed recall cue');
  await dialogue('finish');
  assert.equal(st.recentMessages.length, 3); assert.equal(JSON.stringify(st.continuity), journal);
}));

test('fresh-context refuses unread, busy and real incoming messages before touching model context', () => fixture(async (h, request, dialogue) => {
  const key = 'private:123', st = h.getSocialV2State(key), original = h.state.sessions[key];
  await dialogue('start'); st.unread = [{ seq: 1, text: 'fixture unread' }];
  assert.equal((await dialogue('fresh-context')).code, 409); st.unread = [];
  h.pendingWakeKeys.add(key); assert.equal((await dialogue('fresh-context')).code, 409); h.pendingWakeKeys.delete(key);
  st.recentMessages.push({ seq: 1, text: 'fixture real incoming', messageId: 'real-message', isSelf: false });
  assert.equal((await dialogue('fresh-context')).code, 409); assert.equal(h.state.sessions[key], original);
  assert.ok(!h.calls.cancelled.includes(original));
}));

test('failed fresh-context creation restores original mapping and leaves saved memory intact', () => fixture(async (h, request, dialogue) => {
  const key = 'private:123', st = h.getSocialV2State(key), original = h.state.sessions[key], token = st.agentToken;
  const journal = JSON.stringify(st.continuity), chats = JSON.stringify(st.recentMessages);
  await dialogue('start'); h.api.sessions.create = async () => { throw new Error('fixture create failure'); };
  const failed = await dialogue('fresh-context'); assert.equal(failed.code, 502);
  assert.equal(h.state.sessions[key], original); assert.equal(st.agentToken, token);
  assert.equal(JSON.stringify(st.continuity), journal); assert.equal(JSON.stringify(st.recentMessages), chats);
  assert.ok(!h.calls.archived.includes(original));
  assert.equal((await request(`/api/socialV2/recent?key=${key}`, null, key)).code, 200);
}));
