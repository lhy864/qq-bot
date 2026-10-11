import { createHash } from 'node:crypto';
// B 站抓取（本机改动 2026-10-07）—— 只读、免登录优先；字幕需要 SESSDATA（可选）
// 为什么不用"抓网页"：B 站视频页是 JS 渲染的 SPA，直接抓 HTML 抓不到内容（这是之前"她打不开"的根因）。
// 这里全部走官方接口：实测 info/danmaku/comments/search/resolve 均免登录可用。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36';
const BASE_HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' };
const MAX_TEXT = 4000;
export const SUBTITLE_WAIT_MS = 3000;
const subtitleCache = new Map();
let subtitleCredential = '', loginHealth;
// B 站对匿名搜索有风控（返回 412 HTML）—— 所以：① 两次请求之间至少隔 1.2 秒；
// ② 主接口失败就换老接口（实测 search/all/v2 更稳）。
let __biliLastCall = 0;
async function biliThrottle(minGapMs = 1200) {
  const now = Date.now();
  const wait = Math.max(0, minGapMs - (now - __biliLastCall));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  __biliLastCall = Date.now();
}

function clip(s, n = MAX_TEXT) { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; }

export function isBiliUrl(u) { return /bilibili\.com|b23\.tv/i.test(String(u ?? '')); }

// 从任意文本里抠 B 站视频标识（本机改动 2026-10-07）——
// 手机分享过来的往往是**卡片**：JSON ([CQ:json,data={...}]) 或 XML，链接被包在
// "url"/"qqdocurl"/"jumpUrl"/<url> 里，而且 JSON 里的斜杠会被转义成 \/。
// 这里把能想到的形态全试一遍：直接 BV / av / 完整链接 / b23 短链 / 卡片里的链接。
export function extractBili(text) {
  const raw = String(text ?? '');
  const s = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  // ① 直接给 BV 号
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0], via: 'BV 号' };
  const av = s.match(/\bav(\d{1,12})\b/i);
  if (av) return { aid: Number(av[1]), via: 'av 号' };
  // ② 从卡片字段里抠链接（qqdocurl / jumpUrl / url / <url> / content）
  const urls = [];
  for (const m of s.matchAll(/"(?:qqdocurl|jumpUrl|url|content|shareUrl)"\s*:\s*"([^"]+)"/g)) urls.push(m[1]);
  for (const m of s.matchAll(/<(?:url|qqdocurl|jumpUrl)>([^<]+)<\/(?:url|qqdocurl|jumpUrl)>/gi)) urls.push(m[1]);
  // ③ 文本里裸着的链接
  for (const m of s.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) urls.push(m[0]);
  for (const m of s.matchAll(/b23\.tv\/[0-9A-Za-z]+/g)) urls.push('https://' + m[0]);
  for (const u of urls) {
    const clean = u.replace(/&amp;/g, '&');
    const b2 = clean.match(/BV[0-9A-Za-z]{10}/);
    if (b2) return { bvid: b2[0], via: '卡片/链接里解析' };
    const a2 = clean.match(/\/av(\d{1,12})/i);
    if (a2) return { aid: Number(a2[1]), via: '卡片/链接里解析' };
    if (/b23\.tv\//.test(clean)) return { shortUrl: clean, via: '短链（待跳转）' };
  }
  return null;
}

export async function resolveShort(u, { timeoutMs = 3000 } = {}) {
  const t = String(u ?? '').trim();
  // 先走通用抠取（纯链接、BV 号、卡片都能处理）
  const got = extractBili(t);
  if (got && (got.bvid || got.aid)) return got;
  if (got && got.shortUrl) {
    try {
      const r = await fetch(got.shortUrl.startsWith('http') ? got.shortUrl : 'https://' + got.shortUrl, { headers: BASE_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const loc = r.headers.get('location') ?? '';
      const m2 = loc.match(/BV[0-9A-Za-z]{10}/);
      if (m2) return { bvid: m2[0], via: 'b23 跳转' };
      const m3 = loc.match(/\/av(\d{1,12})/i);
      if (m3) return { aid: Number(m3[1]), via: 'b23 跳转' };
      return { error: '短链跳转里没有 BV 号（可能是失效链接）' };
    } catch (e) { return { error: '解析短链失败: ' + (e?.message ?? e) }; }
  }
  // 都没有 → 试着直接请求（万一是个奇怪形态的链接）
  if (/^https?:\/\//.test(t)) {
    try {
      const r = await fetch(t, { headers: BASE_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const loc = r.headers.get('location') ?? '';
      const m2 = loc.match(/BV[0-9A-Za-z]{10}/);
      if (m2) return { bvid: m2[0], via: '跳转解析' };
    } catch {}
  }
  return { error: '没解析出 BV 号（请给 B 站链接、BV 号，或直接把分享卡片转过来）' };
}

export async function videoInfo({ bvid, aid }, { timeoutMs = 3000 } = {}) {
  const q = bvid ? 'bvid=' + bvid : 'aid=' + aid;
  const r = await fetch('https://api.bilibili.com/x/web-interface/view?' + q, { headers: BASE_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) return { error: 'B站返回 ' + j.code + ' ' + (j.message ?? '') };
  const d = j.data ?? {};
  return {
    bvid: d.bvid, aid: d.aid, cid: d.cid,
    title: d.title, up: d.owner?.name, duration: d.duration, desc: clip(String(d.desc ?? '').replace(/\s+/g, ' ').slice(0, 300), 300),
    views: d.stat?.view, danmaku: d.stat?.danmaku, replies: d.stat?.reply, likes: d.stat?.like,
    pubdate: d.pubdate ? new Date(Number(d.pubdate) * 1000).toISOString().slice(0, 10) : null,
    tname: d.tname, pages: (d.pages ?? []).length
  };
}

// 弹幕：老 XML 接口，**免登录**（实测能拿 1000+ 条）
export async function danmaku({ cid, limit = 60, timeoutMs = SUBTITLE_WAIT_MS }) {
  try {
    const r = await fetch('https://comment.bilibili.com/' + cid + '.xml', { headers: BASE_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)].map((m) => m[1]);
    // 高频词（2~4 字中文）—— 让她一眼看出观众在聊什么
    const freq = new Map();
    for (const t of items) for (const w of (t.match(/[\u4e00-\u9fff]{2,4}/g) ?? [])) freq.set(w, (freq.get(w) ?? 0) + 1);
    const hot = [...freq.entries()].filter(([, n]) => n >= Math.max(3, Math.floor(items.length / 120))).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([w, n]) => w + '(' + n + ')');
    return { total: items.length, sample: items.slice(0, limit), hotWords: hot };
  } catch (e) { return { error: '拉弹幕失败: ' + (e?.message ?? e) }; }
}

export async function comments({ aid, limit = 8, timeoutMs = SUBTITLE_WAIT_MS }) {
  try {
    const r = await fetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&sort=2&ps=' + limit, { headers: BASE_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 0) return { error: 'B站返回 ' + j.code + ' ' + (j.message ?? '') };
    const list = (j.data?.replies ?? []).map((x) => ({ user: x.member?.uname, like: x.like, text: clip(String(x.content?.message ?? '').replace(/\s+/g, ' '), 200) }));
    return { count: list.length, list };
  } catch (e) { return { error: '拉评论失败: ' + (e?.message ?? e) }; }
}

export async function search({ keyword, limit = 8, sessdata, timeoutMs = 6000 }) {
  const signal=AbortSignal.timeout(Math.max(100,Math.min(15000,Number(timeoutMs)||6000)));
  const H2 = sessdata ? { ...BASE_HEADERS, cookie: "SESSDATA=" + sessdata } : BASE_HEADERS;
  const kw = encodeURIComponent(keyword);
  await biliThrottle();
  if(signal.aborted)return {error:'搜索等待超时'};
  // 主接口
  try {
    const r = await fetch("https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=" + kw + "&page=1", { headers: H2, signal });
    const t = await r.text();
    if (r.status === 200 && t.trim().startsWith("{")) {
      const j = JSON.parse(t);
      if (j.code === 0) {
        const list = (j.data?.result ?? []).slice(0, limit).map((x) => ({ title: String(x.title ?? "").replace(/<[^>]+>/g, ""), up: x.author, bvid: x.bvid, play: x.play, duration: x.duration, pubdate: x.pubdate ? new Date(Number(x.pubdate) * 1000).toISOString().slice(0, 10) : null }));
        if (list.length) return { count: list.length, list, via: "search/type" };
      }
    }
  } catch (e) { /* 落到老接口 */ }
  // 兜底：老接口（实测更不容易被风控）
  if(signal.aborted)return {error:'搜索等待超时'};
  await biliThrottle(1500);
  if(signal.aborted)return {error:'搜索等待超时'};
  try {
    const r2 = await fetch("https://api.bilibili.com/x/web-interface/search/all/v2?keyword=" + kw, { headers: H2, signal });
    const t2 = await r2.text();
    if (r2.status !== 200 || !t2.trim().startsWith("{")) return { error: "B 站搜索被风控了（HTTP " + r2.status + "），等一会儿再试" };
    const j2 = JSON.parse(t2);
    if (j2.code !== 0) return { error: "B站返回 " + j2.code + " " + (j2.message ?? "") };
    const blocks = j2.data?.result ?? [];
    const vids = blocks.find((x) => x.result_type === "video")?.data ?? [];
    const list = vids.slice(0, limit).map((x) => ({ title: String(x.title ?? "").replace(/<[^>]+>/g, ""), up: x.author, bvid: x.bvid, play: x.play, duration: x.duration, pubdate: x.pubdate ? new Date(Number(x.pubdate) * 1000).toISOString().slice(0, 10) : null }));
    if (!list.length) return { error: "没搜到结果（换个关键词）" };
    return { count: list.length, list, via: "search/all/v2（老接口兜底）" };
  } catch (e) { return { error: "搜索失败: " + (e?.message ?? e) }; }
}

// 反向推送（本机改动 2026-10-07 用户要求）：按话题/兴趣挑一个视频推出去
// 注意：**必须返回真实存在的 bvid**（从搜索结果里挑），绝不凭空造链接。
export async function recommend({ keyword, exclude = [], pickIndex = -1, sessdata }) {
  const kw = String(keyword ?? "").trim();
  if (!kw) return { error: "推荐需要给个方向（话题/兴趣/番名）" };
  const r = await search({ keyword: kw, limit: 12, sessdata });
  if (r.error) return r;
  const pool = (r.list ?? []).filter((x) => x && x.bvid && !exclude.includes(x.bvid));
  if (!pool.length) return { error: "没搜到可推的（这个方向换个词试试，或者都推过了）" };
  // 从靠前的几个里随机挑一个（靠前的更相关；随机避免每次同一个）
  const top = pool.slice(0, Math.min(5, pool.length));
  const pick = pickIndex >= 0 && pool[pickIndex] ? pool[pickIndex] : top[Math.floor(Math.random() * top.length)];
  return { pick, url: "https://www.bilibili.com/video/" + pick.bvid, poolSize: pool.length };
}

// Login is optional configuration; do not mistake an API failure for absent subtitles.
// Total player/login/body wait is bounded. Cache is in memory and invalidated by a new credential.
export async function subtitle({ bvid, cid, sessdata, timeoutMs = SUBTITLE_WAIT_MS }) {
  if (!sessdata) return { status: 'login-required', needLogin: true, note: '未配置 B 站字幕登录凭据，本次未取得字幕。' };
  if (typeof sessdata !== 'string' || /[\r\n;]/.test(sessdata)) return { status: 'login-required', needLogin: true, note: 'B 站字幕登录配置格式不正确。' };
  const credential = createHash('sha256').update(sessdata).digest('hex');
  if (credential !== subtitleCredential) { subtitleCache.clear(); loginHealth = undefined; subtitleCredential = credential; }
  const key = String(bvid) + ':' + String(cid), cached = subtitleCache.get(key);
  if (cached?.expires > Date.now()) return { ...structuredClone(cached.result), cacheHit: true };
  subtitleCache.delete(key);
  const budget = Math.max(1, Math.min(10000, Number(timeoutMs) || SUBTITLE_WAIT_MS));
  const controller = new AbortController(); let timer;
  const failure = (status, note, extra = {}) => ({ status, note, ...extra });
  const rememberLogin = state => { if (credential === subtitleCredential) loginHealth = state; };
  const json = async (url, authenticated = false) => {
    const r = await fetch(url, { headers: { ...BASE_HEADERS, ...(authenticated ? { cookie: 'SESSDATA=' + sessdata } : {}) },
      signal: controller.signal, redirect: 'error' });
    if (!r.ok) throw { biliFailure: failure('http-error', '字幕接口请求失败（HTTP ' + r.status + '），不能据此判断视频没有字幕。') };
    try { return await r.json(); } catch { throw { biliFailure: failure('invalid-response', '字幕接口返回了无法解析的数据，本次未取得字幕。') }; }
  };
  const work = async () => {
    if (loginHealth?.expires > Date.now() && !loginHealth.valid) return structuredClone(loginHealth.result);
    const j = await json('https://api.bilibili.com/x/player/v2?' + new URLSearchParams({ bvid, cid: String(cid) }), true);
    if (j.code === -101) {
      const result = failure('login-expired', 'B 站未认可当前登录凭据，需要管理员更新 Cookie；本次未取得字幕。', { needLogin: true });
      rememberLogin({ valid: false, result, expires: Date.now() + 30000 }); return result;
    }
    if (j.code !== 0) return failure('api-error', '字幕接口返回错误（code=' + String(j.code ?? 'unknown') + '），不能当作没有字幕。');
    if (!Array.isArray(j.data?.subtitle?.subtitles)) return failure('invalid-response', '字幕接口未返回有效的字幕列表，本次未取得字幕。');
    const subs = j.data.subtitle.subtitles;
    if (!subs.length) {
      if (!(loginHealth?.valid && loginHealth.expires > Date.now())) {
        const nav = await json('https://api.bilibili.com/x/web-interface/nav', true);
        if (nav.code === -101 || (nav.code === 0 && nav.data?.isLogin === false)) {
          const result = failure('login-expired', 'B 站未认可当前登录凭据，需要管理员更新 Cookie；本次未取得字幕。', { needLogin: true });
          rememberLogin({ valid: false, result, expires: Date.now() + 30000 }); return result;
        }
        if (nav.code !== 0 || nav.data?.isLogin !== true) return failure('login-check-failed', '字幕列表为空，但登录状态未能确认，不能断定视频没有字幕。');
        rememberLogin({ valid: true, expires: Date.now() + 60000 });
      }
      return failure('no-subtitle', '当前登录下未返回可读取的字幕轨道；这不包括压在视频画面里的文字。', { count: 0 });
    }
    const usable = subs.filter(s => s && typeof s.subtitle_url === 'string' && s.subtitle_url);
    const first = usable.find(s => s.lan === 'zh-CN') || usable.find(s => /^(?:ai-)?zh/.test(s.lan || '')) || usable[0];
    if (!first) return failure('body-unavailable', '有字幕列表，但没有可读取的正文地址。', { count: subs.length });
    let url; try { url = new URL(first.subtitle_url.startsWith('//') ? 'https:' + first.subtitle_url : first.subtitle_url); } catch {}
    if (!url || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !['hdslb.com', 'bilibili.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)))
      return failure('body-unavailable', '字幕正文地址不是支持的 B 站 HTTPS 地址，本次未读取。');
    const body = await json(url.href); // Never send the account cookie to a subtitle CDN.
    if (!Array.isArray(body.body)) return failure('invalid-response', '字幕正文格式异常，本次未取得字幕文本。');
    const text = body.body.map(s => String(s?.content ?? '')).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return failure('empty-body', '字幕轨道存在，但正文为空。', { count: subs.length });
    return { status: 'ok', count: subs.length, list: [String(first.lan_doc || first.lan || '未知语言')],
      text: clip(text, 3000), truncated: text.length > 3000, characters: text.length };
  };
  let result;
  try {
    result = await Promise.race([work(), new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(failure('timeout', '字幕读取达到等待上限，本次先按已取得的资料回应，不把超时当作没有字幕。')); }, budget);
    })]);
  } catch (e) { result = e?.biliFailure || failure('network-error', '字幕读取发生网络错误，本次未取得字幕。'); }
  finally { clearTimeout(timer); }
  const ttl = result.status === 'ok' ? 30 * 60000 : result.status === 'no-subtitle' ? 5 * 60000 : 15000;
  if (credential === subtitleCredential) subtitleCache.set(key, { expires: Date.now() + ttl, result });
  while (subtitleCache.size > 32) subtitleCache.delete(subtitleCache.keys().next().value);
  return { ...structuredClone(result), cacheHit: false };
}

export function formatBiliResult(kind, data) {
  if (!data || data.error) return 'B站抓取失败：' + (data?.error ?? '未知错误');
  const L = [];
  if (kind === 'info') {
    L.push('【本段来源】视频标题、简介、作者与统计资料；此段不包含视频画面、原始音频或字幕。');
    L.push('《' + data.title + '》');
    L.push('UP：' + data.up + ' ｜ 时长 ' + Math.round((data.duration ?? 0) / 60) + ' 分钟 ｜ 分区 ' + (data.tname ?? '?') + ' ｜ 发布 ' + (data.pubdate ?? '?'));
    L.push('播放 ' + (data.views ?? 0) + ' ｜ 弹幕 ' + (data.danmaku ?? 0) + ' ｜ 评论 ' + (data.replies ?? 0) + ' ｜ 点赞 ' + (data.likes ?? 0));
    if (data.desc) L.push('简介：' + data.desc);
    L.push('（cid=' + data.cid + ' aid=' + data.aid + '，需要弹幕/评论时用）');
  } else if (kind === 'danmaku') {
    L.push('【本次来源】观众弹幕；弹幕不是视频画面或逐字字幕，可能含玩笑、推测或错误。');
    L.push('共 ' + data.total + ' 条弹幕；观众高频词：' + (data.hotWords ?? []).slice(0, 18).join('、'));
    L.push('取样弹幕：' + (data.sample ?? []).slice(0, 40).join(' / '));
  } else if (kind === 'comments') {
    L.push('【本次来源】观众评论；评论不是视频事实证据，可能含玩笑、推测或错误。');
    for (const c of (data.list ?? [])) L.push('[' + (c.like ?? 0) + '赞] ' + c.user + '：' + c.text);
  } else if (kind === 'search') {
    L.push('【本次来源】视频搜索结果；尚未读取这些视频的画面、原始音频或字幕。');
    for (const x of (data.list ?? [])) L.push('《' + x.title + '》 UP:' + x.up + ' 播放' + (x.play ?? 0) + ' ' + x.bvid);
  } else if (kind === 'subtitle') {
    L.push(data.text && !data.needLogin
      ? '【本次来源】字幕文本；没有读取视频画面或原始音频，字幕本身也可能识别有误。'
      : '【本次来源】未取得字幕文本；没有读取视频画面或原始音频。');
    if (data.needLogin) L.push(data.note);
    else if (data.text) { L.push('字幕（' + (data.list ?? []).join('/') + '）：' + data.text); if (data.truncated) L.push('仅提供字幕前 3000 字，未覆盖完整视频。'); }
    else L.push(data.note ?? '没有字幕');
  }
  return L.join('\n');
}
