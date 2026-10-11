// QQ 分享卡片（json / xml 富文本段）→ 可读文本
// 目标：别再把视频/文章分享变成没用的 `[卡片消息]`，而是把**标题 / 来源 / 链接**提取出来，
// 这样 AI 至少知道"这是个 B站 视频，标题是 xxx，链接是 yyy"，需要时可以自己去抓。
//
// 兼容两种线上形状：
//   1) { type:'json', data:{ data:'{"app":...,"meta":{"news":{"title":..,"jumpUrl":..}}}' } }
//   2) { type:'xml',  data:{ data:'<?xml ...><msg url=".." brief=".."><item><title>..</title>...' } }

const MAX_TITLE = 120;
const MAX_DESC = 160;
const MAX_URL = 2048;

function entityCodePoint(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function clean(s, max) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => entityCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => entityCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 从任意嵌套对象里找出第一个非空的字符串字段 */
function pick(obj, keys, max) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return clean(v, max);
  }
  return '';
}

/** 深度遍历，找 meta.news / meta.detail_1 之类里的标题链接 */
function fromJson(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const out = { title: '', desc: '', url: '', source: '' };
  const meta = j.meta && typeof j.meta === 'object' ? j.meta : {};
  const candidates = [];
  const collectUrls = (obj, isMeta) => {
    for (const field of ['qqdocurl', 'sourceUrl', 'jumpUrl', 'url']) {
      const url = pick(obj, [field], MAX_URL);
      if (!url) continue;
      try {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol)) continue;
        const host = parsed.hostname.toLowerCase();
        const isBili = host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
        const isContainer = host === 'qq.com' || host.endsWith('.qq.com');
        const score = (isBili ? 1000 : isContainer ? 0 : 100) + (['qqdocurl', 'sourceUrl'].includes(field) ? 20 : 0) + (isMeta ? 5 : 0);
        candidates.push({ url, score });
      } catch { /* Internal mini-app schemes are not usable web links. */ }
    }
  };
  collectUrls(j, false);
  for (const v of Object.values(meta)) {
    if (!v || typeof v !== 'object') continue;
    out.title ||= pick(v, ['title', 'news_title'], MAX_TITLE);
    out.desc ||= pick(v, ['desc', 'summary', 'news_summary'], MAX_DESC);
    collectUrls(v, true);
    out.source ||= pick(v, ['tag', 'source', 'app_name'], 40);
  }
  out.title ||= pick(j, ['title', 'prompt'], MAX_TITLE);
  out.desc ||= pick(j, ['desc', 'summary'], MAX_DESC);
  out.url = candidates.sort((a, b) => b.score - a.score)[0]?.url || '';
  out.source ||= pick(j, ['app', 'source'], 40);
  return out;
}

/** QQ 的 XML 卡片：<msg url=".." brief=".."><item><title>..</title><summary>..</summary> */
function fromXml(raw) {
  const s = String(raw ?? '');
  if (!/<msg[\s>]/i.test(s) && !/<item[\s>]/i.test(s)) return null;
  const attr = (name) => clean((s.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1] ?? '', MAX_TITLE);
  const tag = (name, max) => clean((s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')) || [])[1] ?? '', max);
  const out = {
    title: tag('title', MAX_TITLE),
    desc: tag('summary', MAX_DESC),
    url: clean((s.match(/\burl\s*=\s*"([^"]*)"/i) || [])[1] ?? '', MAX_URL) || tag('url', MAX_URL),
    source: attr('brief')
  };
  if (!out.url) out.url = clean((s.match(/https?:\/\/[^\s"'<>]+/) || [])[0] ?? '', MAX_URL);
  return out;
}

/**
 * 把卡片段的 data 字段（字符串）转成给模型看的文本。
 * 解析不出来时返回 ''，由调用方回退成 `[卡片消息]`。
 */
export function shareCardText(dataString) {
  const raw = typeof dataString === 'string' ? dataString.trim() : '';
  if (!raw) return '';
  const info = raw.startsWith('{') ? fromJson(raw) : fromXml(raw);
  if (!info) return '';
  const bits = [];
  if (info.title) bits.push(info.title);
  if (info.desc && info.desc !== info.title) bits.push(info.desc);
  if (info.source) bits.push(`来源:${info.source}`);
  if (info.url) bits.push(info.url);
  if (!bits.length) return '';
  return `[卡片 ${bits.join(' | ')}]`;
}

/** 从卡片文本里再抽一次链接（给调用方做"要不要抓"的判断用） */
export function urlsFromCardText(text) {
  // 注意排除 ] 和 )：卡片文本里链接后面常跟着 ] 或 )，别把它们吃进 URL
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s|<>"'\])]+/g)].map((m) => m[0]);
}
