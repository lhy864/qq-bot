import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { shareCardText, urlsFromCardText } from '../src/share-card.js';
import { buildExpressionHint, expressionContext, observeExpressionPreference } from '../src/persona-expression.js';
import { appendContinuity, updateContinuity, selectContinuity, normalizeContinuity, removeContinuity } from '../src/social-continuity.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const now = Date.parse('2026-10-08T12:00:00Z'), DAY = 86400000;
const messages = [{ seq: 1, sender: 'fixture-friend', userId: '123', text: '昨天一起讨论蔚蓝的酒，明天查到资料后继续聊', time: now - 1000 },
  { seq: 2, sender: 'fixture-friend', userId: '123', text: '资料已经收到了，谢谢，这件事结束了', time: now }];
const opts = { messages, now };
const extra = { sourceSeqs: [1], participants: ['123'], keywords: ['蔚蓝的酒'], dueAt: new Date(now + DAY).toISOString() };
const add = (category = 'commitment', text = '查蔚蓝的酒资料') => appendContinuity(undefined, category, text, extra, opts);

test('Bili mini-app card selects actual qqdocurl over QQ jumpUrl and generic prompt', () => {
  const text = shareCardText(JSON.stringify({ prompt: '[QQ小程序]', jumpUrl: 'https://miniapp.qq.com/container',
    meta: { detail_1: { title: 'fixture-video', jumpUrl: 'https://miniapp.qq.com/jump', qqdocurl: 'https://b23.tv/Fixture?share_source=qq' } } }));
  assert.match(text, /fixture-video/);
  assert.deepEqual(urlsFromCardText(text), ['https://b23.tv/Fixture?share_source=qq']);
  assert.doesNotMatch(text, /miniapp.qq.com/);
});
test('ordinary article cards still expose their title and web link', () => {
  assert.match(shareCardText(JSON.stringify({ meta: { news: { title: 'fixture-news', jumpUrl: 'https://example.invalid/article' } } })), /fixture-news.*https:\/\/example.invalid\/article/);
});
test('card handles malformed JSON, internal schemes and invalid XML entities without crashing', () => {
  assert.equal(shareCardText('{bad'), '');
  assert.doesNotMatch(shareCardText(JSON.stringify({ prompt: 'card', jumpUrl: 'mqqapi://app' })), /mqqapi/);
  assert.doesNotThrow(() => shareCardText('<msg brief="&#999999999;"><item><title>&#xFFFFFF;</title></item></msg>'));
});
test('XML video URL is not truncated to title length', () => {
  const url = 'https://www.bilibili.com/video/BVFixture/?tracking=' + 'a'.repeat(160);
  assert.deepEqual(urlsFromCardText(shareCardText(`<msg url="${url}"><item><title>fixture</title></item></msg>`)), [url]);
});
test('serious help and distress select appropriate expression without injected vocabulary', () => {
  const serious = { recentMessages: [{ userId: '123', text: '机器人报错了，帮我修复' }] };
  assert.equal(expressionContext(serious), 'serious');
  assert.doesNotMatch(buildExpressionHint(serious, { library: { swear: [{ w: 'fixture-swear' }] } }), /fixture-swear/);
  assert.equal(expressionContext({ recentMessages: [{ text: '今天很难过，心情不好' }] }), 'supportive');
});
test('stop preference persists for sender and explicit consent restores it', () => {
  const st = { recentMessages: [] };
  observeExpressionPreference(st, { userId: '123', text: '别开玩笑了' });
  st.recentMessages = [{ userId: '123', text: '今天聊什么' }];
  assert.equal(expressionContext(st), 'restrained');
  st.recentMessages = [{ userId: '999', text: '哈哈哈' }];
  assert.equal(expressionContext(st), 'casual');
  observeExpressionPreference(st, { userId: '123', text: '可以开玩笑了' });
  st.recentMessages = [{ userId: '123', text: '哈哈哈' }];
  assert.equal(expressionContext(st), 'casual');
});
test('joint events require local evidence and recall related topics rather than same person alone', () => {
  assert.throws(() => appendContinuity(undefined, 'sharedEvent', 'event', {}, opts));
  assert.throws(() => appendContinuity(undefined, 'sharedEvent', 'event', { sourceSeqs: [900] }, opts));
  const { journal } = add('sharedEvent', '共同聊了蔚蓝的酒');
  assert.equal(selectContinuity(journal, { messages, now }).events.length, 1);
  assert.equal(selectContinuity(journal, { messages: [{ userId: '123', text: '午饭吃什么' }], now }).events.length, 0);
});
test('commitment becomes due next day; completion stops future reminders and duplicate does not reopen', () => {
  const { journal, entry } = add();
  assert.equal(selectContinuity(journal, { messages: [], now }).commitments.length, 0);
  assert.equal(selectContinuity(journal, { messages: [], now: now + DAY }).commitments.length, 1);
  const done = updateContinuity(journal, 'commitment', entry.id, { status: 'completed', sourceSeqs: [2] }, { messages, now: now + DAY });
  assert.equal(selectContinuity(done.journal, { messages, now: now + 2 * DAY }).commitments.length, 0);
  const duplicate = appendContinuity(done.journal, 'commitment', entry.text, extra, opts);
  assert.equal(duplicate.entry.status, 'completed');
  assert.throws(() => updateContinuity(done.journal, 'commitment', entry.id, { status: 'open', sourceSeqs: [2] }, opts));
});
test('correction keeps id and evidence, invalid changes do not mutate original memory', () => {
  const { journal, entry } = add('sharedEvent');
  const changed = updateContinuity(journal, 'sharedEvent', entry.id, { text: '更正：只是读了简介', sourceSeqs: [2] }, opts);
  assert.equal(changed.entry.id, entry.id);
  assert.equal(changed.entry.evidence[0].seq, 2);
  assert.notEqual(changed.entry.text, journal.sharedEvents[0].text);
  assert.throws(() => updateContinuity(journal, 'sharedEvent', entry.id, { text: 'invented' }, opts));
  assert.throws(() => appendContinuity(undefined, 'commitment', 'x', { ...extra, dueAt: 'invalid' }, opts));
  assert.throws(() => appendContinuity(undefined, 'commitment', 'x', { ...extra, dueAt: 1e30 }, opts));
});
test('follow-up count and daily interval are enforced and cancellation closes reminder', () => {
  let { journal, entry } = add();
  ({ journal } = updateContinuity(journal, 'commitment', entry.id, { followUpSent: true }, opts));
  assert.throws(() => updateContinuity(journal, 'commitment', entry.id, { followUpSent: true }, opts));
  ({ journal } = updateContinuity(journal, 'commitment', entry.id, { followUpSent: true }, { ...opts, now: now + DAY }));
  assert.throws(() => updateContinuity(journal, 'commitment', entry.id, { followUpSent: true }, { ...opts, now: now + 2 * DAY }));
  assert.equal(selectContinuity(journal, { messages, reason: 'proactiveCheck', now: now + 3 * DAY }).commitments.length, 0);
  ({ journal } = updateContinuity(journal, 'commitment', entry.id, { status: 'cancelled', sourceSeqs: [2] }, opts));
  assert.equal(selectContinuity(journal, { messages, now: now + 3 * DAY }).commitments.length, 0);
});
test('memory cap never silently drops an open promise; explicit removal works', () => {
  let journal;
  for (let i = 0; i < 80; i++) ({ journal } = appendContinuity(journal, 'commitment', 'promise-' + i, extra, opts));
  assert.throws(() => appendContinuity(journal, 'commitment', 'overflow', extra, opts));
  assert.equal(journal.commitments.length, 80);
  assert.equal(removeContinuity(journal, 'commitment', { id: journal.commitments[0].id }).commitments.length, 79);
  assert.deepEqual(normalizeContinuity(undefined), { version: 1, sharedEvents: [], commitments: [] });
});

async function fixture(run, config = {}) {
  let handler;
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, sticker: { enabled: false } }, ...config }, globals: { http: { ...http, createServer(fn) {
    handler = fn; const stub = new EventEmitter(); stub.address = () => ({ port: h.cfg.consolePort });
    stub.listen = (_port, _host, fn) => { fn(); return stub; }; return stub;
  } } } });
  h.setMode('reserved2');
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  h.cfg.consolePort = port; h.startConsoleServer();
  const request = async (route, body, key = 'private:123', token) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token ?? h.getSocialV2State(key).agentToken, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify({ key, ...body }) } : {}) });
    return { code: response.status, data: await response.json() };
  };
  try { await run(h, request, port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('bridge memory API guards local read evidence, token scope, tool toggle and legacy person branch', async () => fixture(async (h, request) => {
  const st = h.getSocialV2State('private:123');
  h.appendSocialV2Message('private:123', 'fixture-friend', messages[0].text, messages[0].text, false, false, '1', [], '123');
  const body = { category: 'commitment', content: '查蔚蓝的酒资料', extra };
  assert.equal((await request('/api/socialV2/memory-append', body)).code, 400);
  st.modelSeenSeqs.add(1);
  assert.equal((await request('/api/socialV2/memory-append', body, 'private:123', 'invalid')).code, 403);
  const saved = await request('/api/socialV2/memory-append', body);
  assert.equal(saved.code, 200); assert.ok(saved.data.entry.id);
  assert.equal((await request('/api/socialV2/memory?key=group:456&category=commitment', null, 'private:123')).code, 403);
  h.cfg.socialV2.tools = { ...h.cfg.socialV2.tools, memory: false };
  assert.equal((await request('/api/socialV2/memory-append', { category: 'person', content: 'fixture fact', extra: { target: 'fixture' } })).code, 403);
}));

test('bridge update/query/delete/clear roundtrip keeps scopes and refuses fictitious follow-up', async () => fixture(async (h, request) => {
  const st = h.getSocialV2State('private:123');
  h.appendSocialV2Message('private:123', 'fixture-friend', messages[0].text, messages[0].text, false, false, '1', [], '123');
  st.modelSeenSeqs.add(1);
  const saved = (await request('/api/socialV2/memory-append', { category: 'commitment', content: '查蔚蓝的酒资料', extra })).data.entry;
  assert.equal((await request('/api/socialV2/memory-update', { category: 'commitment', id: saved.id, newExtra: { followUpSent: true } })).code, 400);
  const waiting = await request('/api/socialV2/memory-update', { category: 'commitment', id: saved.id, newExtra: { status: 'waiting', sourceSeqs: [1] } });
  assert.equal(waiting.data.entry.status, 'waiting');
  const read = await request('/api/socialV2/memory?key=private:123&category=commitment&q=' + encodeURIComponent('蔚蓝'));
  assert.equal(read.data.raw.continuity.commitments.length, 1);
  const unrelated = await request('/api/socialV2/memory?key=group:456&category=commitment', null, 'group:456');
  assert.equal(unrelated.data.raw.continuity.commitments.length, 0);
  assert.equal((await request('/api/socialV2/memory-remove', { category: 'commitment', id: saved.id })).code, 200);
  await request('/api/socialV2/memory-append', { category: 'sharedEvent', content: '共同聊蔚蓝的酒', extra });
  assert.equal((await request('/api/socialV2/memory-clear', { category: 'sharedEvent' })).code, 200);
  assert.equal(st.continuity.sharedEvents.length, 0);
}));

test('restart preserves events, commitments, stop preference and old memories without cross-chat recall', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, sticker: { enabled: false } } } }); h.setMode('reserved2');
  let saved;
  try {
    const st = h.getSocialV2State('private:123');
    st.recentMessages = messages;
    st.continuity = add('sharedEvent', '共同讨论蔚蓝的酒').journal;
    st.continuity = appendContinuity(st.continuity, 'commitment', '查蔚蓝的酒资料', extra, opts).journal;
    st.expressionQuietTargets = ['123'];
    h.appendMemoryV2(st, 'activeTopic', 'legacy-topic'); h.saveSocialV2State();
    saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
  } finally { await h.close(); }
  const next = await bridgeHarness({ savedSocialState: saved, config: { socialV2: { enabled: true, sticker: { enabled: false } } } }); next.setMode('reserved2');
  try {
    const st = next.getSocialV2State('private:123');
    assert.equal(st.continuity.sharedEvents.length, 1);
    assert.equal(st.continuity.commitments.length, 1);
    assert.equal(st.continuity.commitments[0].status, 'open');
    assert.equal(st.activeTopics[0].text, 'legacy-topic');
    assert.equal(st.expressionQuietTargets[0], '123');
    assert.match(next.buildWakePromptV2('private:123', 'private'), /共同讨论蔚蓝的酒/);
    assert.doesNotMatch(next.buildWakePromptV2('group:456', 'proactiveCheck'), /共同讨论蔚蓝的酒/);
  } finally { await next.close(); }
});

test('real MCP schema and calls expose shared event/commitment lifecycle through guarded bridge API', async () => fixture(async (h, request, port) => {
  const st = h.getSocialV2State('private:123');
  h.appendSocialV2Message('private:123', 'fixture-friend', messages[0].text, messages[0].text, false, false, '1', [], '123');
  st.modelSeenSeqs.add(1);
  const temp = fs.mkdtempSync(path.join(root, '.tmp-persona-mcp-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ consolePort: port, consoleToken: 'fixture-console-token', allow: { private: ['123'], groups: ['456'] }, socialV2: { enabled: true } }));
  for (const rel of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js', 'bili.js']) fs.copyFileSync(path.join(root, 'src', rel), path.join(temp, 'src', rel));
  const client = new Client({ name: 'persona-fixture', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(temp, 'src/mcp-snowluma-safe.js')], stderr: 'pipe' }));
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(t => t.name === 'qq_memory_update'));
    const common = { key: 'private:123', token: st.agentToken };
    const added = await client.callTool({ name: 'qq_memory_append', arguments: { ...common, category: 'commitment', content: '查蔚蓝的酒资料', extra } });
    assert.notEqual(added.isError, true, added.content[0]?.text);
    const entry = JSON.parse(added.content[0].text).entry;
    assert.equal(entry.evidence[0].seq, 1);
    const updated = await client.callTool({ name: 'qq_memory_update', arguments: { ...common, category: 'commitment', id: entry.id, newExtra: { status: 'completed', sourceSeqs: [1] } } });
    assert.equal(JSON.parse(updated.content[0].text).entry.status, 'completed');
    const invalid = await client.callTool({ name: 'qq_memory_update', arguments: { ...common, category: 'commitment', id: entry.id, newExtra: { status: 'unknown' } } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); assert.equal(path.dirname(temp), path.resolve(root)); fs.rmSync(temp, { recursive: true }); }
}));

test('continuity toggle blocks new records and the live prompt carries contextual policy', async () => fixture(async (h, request) => {
  const st = h.getSocialV2State('private:123');
  h.appendSocialV2Message('private:123', 'fixture-friend', '认真帮我修复报错', '认真帮我修复报错', false, false, '1', [], '123');
  st.modelSeenSeqs.add(1);
  h.cfg.socialV2.continuity = { enabled: false };
  assert.equal((await request('/api/socialV2/memory-append', { category: 'sharedEvent', content: 'fixture event', extra })).code, 403);
  const prompt = await request('/api/socialV2/prompt?key=private:123');
  assert.equal(prompt.code, 200, JSON.stringify(prompt.data));
  assert.match(prompt.data.role.hint, /本轮认真回应/);
  assert.doesNotMatch(h.buildWakePromptV2('private:123', 'private'), /【这一轮·必须1】|不管在聊什么找个地方自然带上/);
}));
