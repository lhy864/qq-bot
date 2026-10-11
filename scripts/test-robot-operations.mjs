import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { acquireLaunchLock, checkRobot, createWindowsIO, loadOperations, localUrl, requestJson, startRobot } from './robot-operations.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { EventEmitter } from 'node:events';

const temporaryRoot = fileURLToPath(new URL('../review/tmp/', import.meta.url));
fs.mkdirSync(temporaryRoot, { recursive: true });
function temporary() {
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'robot-ops-'));
  const close = () => { assert.equal(path.dirname(root).toLowerCase(), path.resolve(temporaryRoot).toLowerCase()); fs.rmSync(root, { recursive: true, force: true }); };
  fs.mkdirSync(path.join(root, 'state')); fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/bridge.js'), '// fixture');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ consoleToken: 'fixture-console-token', snowluma: { accessToken: 'fixture-gateway-token', wsUrl: 'ws://127.0.0.1:3011' } }));
  return { root, close };
}
function fixtureIO(settings, { status = {}, gateway = {}, ports = true, allPresent = true, loggedIn = true } = {}) {
  let now = 0; const launched = []; const opened = []; const calls = []; const present = new Set(allPresent ? ['qq', 'dsh', 'snowluma', 'bridge'] : []);
  const bridgeStatus = { mode: 'reserved2', roleMode: 'active', dshReady: true, socialV2Paused: false,
    build: { root: settings.root, bridgeSha256: settings.sourceHash, pid: 123, startedAt: '2026-10-08T00:00:00.000Z' },
    snowluma: { connected: true, good: true, accountOnline: true },
    activity: ['fixture PRIVATE CHAT'], ownerQQ: 'fixture-private-id', ...status };
  const io = {
    request: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/status')) return present.has('bridge') ? { ok: true, body: bridgeStatus } : { ok: false, code: 'connection-refused' };
      assert.ok(url.endsWith('/get_status'), 'operations may only call status endpoints');
      return { ok: true, body: { status: 'ok', retcode: 0, data: { online: loggedIn, good: loggedIn, user_id: 'fixture-private-id', ...gateway } } };
    },
    port: async () => ports,
    present: async (kind) => present.has(kind),
    launch: async (kind) => { present.add(kind); launched.push(kind); return 111; },
    openConsole: async (token) => opened.push(token),
    now: () => now, sleep: async (ms) => { now += ms; },
  };
  return { io, launched, opened, calls };
}

test('port listeners, logged-out QQ and unhealthy receive status never pass business readiness', async () => {
  const t = temporary(); try {
    const settings = loadOperations(t.root);
    for (const [status, gateway] of [[{ dshReady: false }, {}], [{ snowluma: { connected: false, good: true } }, {}], [{}, { online: false }], [{}, { good: false }]]) {
      const f = fixtureIO(settings, { status, gateway }); assert.equal((await checkRobot(settings, f.io)).ready, false);
    }
    assert.equal((await checkRobot(settings, fixtureIO(settings, { ports: false }).io)).ready, false);
  } finally { t.close(); }
});

test('diagnostics recognize stale/foreign code and omit credentials, IDs, chats and tool error text', async () => {
  const t = temporary(); try {
    fs.writeFileSync(path.join(t.root, 'state/tool-calls.jsonl'), JSON.stringify({ ok: false, tool: 'qq_send', key: 'group:PRIVATE', error: 'fixture RAW SECRET' }) + '\n');
    const settings = loadOperations(t.root);
    const current = await checkRobot(settings, fixtureIO(settings).io); assert.equal(current.ready, true);
    const json = JSON.stringify(current);
    for (const privateText of ['fixture-console-token', 'fixture-gateway-token', 'PRIVATE CHAT', 'fixture-private-id', 'RAW SECRET', 'group:PRIVATE']) assert.equal(json.includes(privateText), false);
    assert.deepEqual(current.logSummary.recentFailedTools, ['qq_send']);
    const old = await checkRobot(settings, fixtureIO(settings, { status: { build: { root: settings.root, bridgeSha256: 'A'.repeat(64) } } }).io);
    assert.equal(old.bridge.identity, 'old-code'); assert.equal(old.ready, false);
    const foreign = await checkRobot(settings, fixtureIO(settings, { status: { build: { root: path.join(t.root, 'elsewhere'), bridgeSha256: settings.sourceHash } } }).io);
    assert.equal(foreign.bridge.identity, 'other-project'); assert.equal(foreign.ready, false);
    const legacy = await checkRobot(settings, fixtureIO(settings, { status: { build: undefined } }).io); assert.equal(legacy.ready, false);
  } finally { t.close(); }
});

test('fallback gateway uses its own HTTP token and malformed HTTP success is rejected', async () => {
  const t = temporary(); try {
    const settings = loadOperations(t.root); settings.httpCandidates.push({ baseUrl: 'http://127.0.0.1:3012', token: 'fixture-http-token' });
    const f = fixtureIO(settings); const request = f.io.request;
    f.io.request = async (url, init) => url.startsWith('http://127.0.0.1:3000/') ? { ok: false, code: 'authorization' } : url.endsWith('/get_status')
      ? (assert.equal(init.headers.authorization, 'Bearer fixture-http-token'), { ok: true, body: { status: 'ok', retcode: 0, data: { online: true, good: true } } }) : request(url, init);
    const snapshot = await checkRobot(settings, f.io); assert.equal(snapshot.ready, true); assert.equal(snapshot.gateway.port, 3012);
    assert.deepEqual(await requestJson('http://127.0.0.1/status', {}, async () => new Response('<html>not our service</html>')), { ok: false, code: 'unavailable-or-invalid-response' });
    const unauthorized = await requestJson('http://127.0.0.1/status', {}, async () => new Response('SECRET', { status: 401 })); assert.equal(unauthorized.code, 'authorization');
  } finally { t.close(); }
});

test('startup reuses ready components and preserves operator pause without launching or sending', async () => {
  const t = temporary(); try {
    const settings = loadOperations(t.root); const f = fixtureIO(settings, { status: { socialV2Paused: true } });
    const snapshot = await startRobot(() => settings, f.io);
    assert.equal(snapshot.ready, true); assert.equal(snapshot.bridge.paused, true); assert.deepEqual(f.launched, []); assert.equal(f.opened.length, 1);
    assert.ok(f.calls.every((c) => /\/(api\/status|get_status)$/.test(c.url)));
  } finally { t.close(); }
});

test('cold startup launches each dependency once and waits for online status before bridge', async () => {
  const t = temporary(); try {
    const settings = loadOperations(t.root); const f = fixtureIO(settings, { allPresent: false });
    assert.equal((await startRobot(() => settings, f.io)).ready, true);
    assert.deepEqual(f.launched, ['dsh', 'qq', 'snowluma', 'bridge']); assert.equal(f.opened.length, 1);
    const loggedOut = fixtureIO(settings, { allPresent: false, loggedIn: false });
    await assert.rejects(startRobot(() => ({ ...settings, startupTimeoutMs: 10000 }), loggedOut.io), /登录/);
    assert.equal(loggedOut.launched.includes('bridge'), false);
  } finally { t.close(); }
});

test('foreign or stale bridge is never killed or duplicated by startup', async () => {
  const t = temporary(); try {
    const settings = loadOperations(t.root);
    for (const build of [{ root: path.join(t.root, 'foreign'), bridgeSha256: settings.sourceHash }, { root: settings.root, bridgeSha256: 'B'.repeat(64) }]) {
      const f = fixtureIO(settings, { status: { build } });
      await assert.rejects(startRobot(() => settings, f.io), /另一个项目|旧版/);
      assert.deepEqual(f.launched, []);
    }
  } finally { t.close(); }
});

test('exclusive startup lock prevents concurrent launches and preserves a replaced lock', () => {
  const t = temporary(); try {
    const release = acquireLaunchLock(t.root); assert.throws(() => acquireLaunchLock(t.root), /正在运行/);
    const file = path.join(t.root, 'state/launcher.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id: 'replacement' })); release(); assert.equal(fs.existsSync(file), true);
  } finally { t.close(); }
});

test('local URL and corrupt configuration failures do not disclose embedded secrets', () => {
  const t = temporary(); try {
    for (const value of ['http://example.com', 'http://user:SECRET@127.0.0.1', 'http://127.0.0.1/?token=SECRET']) assert.throws(() => localUrl(value), (e) => !e.message.includes('SECRET'));
    fs.writeFileSync(path.join(t.root, 'config.json'), '{"token":"SECRET" INVALID');
    assert.throws(() => loadOperations(t.root), (e) => !e.message.includes('SECRET'));
  } finally { t.close(); }
});

test('bridge build identity is available only to console operators', async () => {
  let handler;
  const fakeHttp = { createServer(fn) { handler = fn; const server = new EventEmitter(); server.address = () => ({ port: 3100 }); server.listen = (_p, _h, fn) => { server.listening = true; fn(); return server; }; return server; } };
  const h = await bridgeHarness({ globals: { http: fakeHttp } });
  try {
    h.startConsoleServer();
    const request = async (headers) => {
      let result; const req = new EventEmitter(); req.method = 'GET'; req.url = '/api/status'; req.headers = { host: '127.0.0.1:3100', 'x-console-token': 'fixture-console-token', ...headers };
      await handler(req, { writeHead() {}, end(text) { result = JSON.parse(text); } }); return result;
    };
    const operator = await request({}); assert.ok(operator.build.root); assert.ok(operator.build.startedAt); assert.equal(operator.build.pid, process.pid);
    assert.equal(path.resolve(operator.build.root), path.resolve(h.temp));
    assert.match(operator.build.bridgeSha256, /^[A-F0-9]{64}$/);
    assert.equal(operator.build.bridgeSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(h.temp, 'src/bridge.js'))).digest('hex').toUpperCase());
    fs.mkdirSync(path.join(h.temp, 'src'), { recursive: true }); fs.writeFileSync(path.join(h.temp, 'src/bridge.js'), '// changed after process start');
    assert.equal((await request({})).build.bridgeSha256, operator.build.bridgeSha256, 'disk edits must not relabel the already running process');
    const agent = await request({ 'x-agent-call': '1' }); assert.equal(agent.build, undefined);
  } finally { await h.close(); }
});

test('Windows background launcher handles spaces and Chinese paths using a harmless fixture', { skip: process.platform !== 'win32' || !process.argv.includes('--windows-process') }, async () => {
  const t = temporary(); try {
    const folder = path.join(t.root, '中文 path'); fs.mkdirSync(folder);
    const script = path.join(folder, 'fixture start.cmd'); const marker = path.join(folder, 'started.txt');
    fs.writeFileSync(script, '@echo off\r\necho fixture>started.txt\r\n', 'utf8');
    const settings = loadOperations(t.root); settings.paths.bridge = script;
    const pid = await createWindowsIO(settings).launch('bridge'); assert.ok(Number.isSafeInteger(pid));
    for (let i = 0; i < 30 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'fixture');
  } finally { t.close(); }
});
