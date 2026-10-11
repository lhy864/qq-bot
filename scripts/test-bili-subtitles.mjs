// Isolated HTTP fixtures: no real Bili requests or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import { subtitle, formatBiliResult } from '../src/bili.js';
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const player = tracks => response({ code: 0, data: { subtitle: { subtitles: tracks } } });
const track = (lan = 'zh-CN', url = '//aisubtitle.hdslb.com/fixture.json') => ({ lan, lan_doc: lan, subtitle_url: url });
let number = 0;
async function fixture(fn, action) {
  const original = globalThis.fetch; globalThis.fetch = fn;
  try { return await action({ bvid: 'BV1234567890', cid: 123, sessdata: 'fixture-session-' + (++number) }); }
  finally { globalThis.fetch = original; }
}
test('missing login is explicit and does not request a network resource', async () => {
  await fixture(() => { throw new Error('unexpected request'); }, async args => {
    const r = await subtitle({ ...args, sessdata: '' });
    assert.equal(r.status, 'login-required'); assert.equal(r.needLogin, true);
  });
});
test('expired login and authenticated absence of tracks have different results', async () => {
  for (const valid of [false, true]) await fixture(async url => url.includes('/nav')
    ? response({ code: valid ? 0 : -101, data: { isLogin: valid } }) : player([]), async args => {
      const r = await subtitle(args); assert.equal(r.status, valid ? 'no-subtitle' : 'login-expired');
      assert.equal(r.needLogin === true, !valid); assert.doesNotMatch(JSON.stringify(r), /fixture-session-/);
      assert.match(formatBiliResult('subtitle', r), /未取得字幕文本/);
    });
});
test('HTTP, business-code and malformed responses never become no-subtitle', async () => {
  for (const [reply, status] of [[response({}, 412), 'http-error'], [response({ code: -352 }), 'api-error'],
    [response({ code: 0, data: {} }), 'invalid-response'], [{ ok: true, json: async () => { throw new Error('bad json'); } }, 'invalid-response']])
    await fixture(async () => reply, async args => assert.equal((await subtitle(args)).status, status));
});
test('preferred Chinese transcript is bounded and CDN never receives account credentials', async () => {
  const calls = [];
  await fixture(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/x/player/') ? player([track('en'), track('zh-CN', '//aisubtitle.hdslb.com/chinese.json')])
      : response({ body: [{ content: '字'.repeat(3100) }] });
  }, async args => {
    const r = await subtitle(args); assert.equal(r.status, 'ok'); assert.equal(r.truncated, true);
    assert.equal(r.text.length, 3001); assert.deepEqual(r.list, ['zh-CN']); assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.cookie, 'SESSDATA=' + args.sessdata);
    assert.equal(calls[1].options.headers.cookie, undefined); assert.match(calls[1].url, /chinese/);
    assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[1].options.redirect, 'error');
    assert.match(formatBiliResult('subtitle', r), /未覆盖完整视频/);
  });
});
test('repeated transcript uses cache and a changed credential invalidates it immediately', async () => {
  let calls = 0;
  await fixture(async url => { calls++; return url.includes('/x/player/') ? player([track()]) : response({ body: [{ content: 'fixture transcript' }] }); }, async args => {
    const a = await subtitle(args), b = await subtitle(args); assert.equal(a.cacheHit, false); assert.equal(b.cacheHit, true);
    assert.equal(calls, 2); assert.equal(b.text, a.text);
    await subtitle({ ...args, sessdata: args.sessdata + '-changed' }); assert.equal(calls, 4);
  });
});
test('total deadline includes transcript body read and aborts stalled requests', async () => {
  let signal;
  await fixture(async (url, options) => {
    signal = options.signal;
    return url.includes('/x/player/') ? player([track()]) : { ok: true, json: () => new Promise(() => {}) };
  }, async args => {
    const start = performance.now(), r = await subtitle({ ...args, timeoutMs: 30 });
    assert.equal(r.status, 'timeout'); assert.equal(signal.aborted, true);
    assert.ok(performance.now() - start < 800, 'timeout should not block chat');
  });
});
test('unexpected hosts, insecure URLs and URL credentials are not fetched', async () => {
  for (const url of ['http://aisubtitle.hdslb.com/x', 'https://127.0.0.1/x', 'https://hdslb.com.attacker.invalid/x', 'https://user:pass@aisubtitle.hdslb.com/x']) {
    let calls = 0;
    await fixture(async () => { calls++; return player([track('zh-CN', url)]); }, async args => {
      assert.equal((await subtitle(args)).status, 'body-unavailable'); assert.equal(calls, 1);
    });
  }
});
test('late work from an old credential cannot contaminate the new credential cache', async () => {
  let finishOld, oldRequests = 0;
  await fixture(async (url, options) => {
    if (options.headers.cookie?.endsWith('-old')) {
      oldRequests++;
      return new Promise(resolve => { finishOld = () => resolve(response({ code: -101 })); });
    }
    return url.includes('/x/player/') ? player([track()]) : response({ body: [{ content: 'new login transcript' }] });
  }, async args => {
    const old = subtitle({ ...args, sessdata: args.sessdata + '-old' });
    const fresh = await subtitle(args); finishOld(); await old;
    const again = await subtitle(args); assert.equal(fresh.status, 'ok'); assert.equal(again.status, 'ok');
    assert.equal(again.cacheHit, true); assert.equal(oldRequests, 1);
  });
});
