// History is context, not a new turn. Preserve original time and bound recovery.
import { shareCardText } from './share-card.js';
export const RECOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_OVERLAP_MS = 5 * 60 * 1000;
export const RECOVERY_INTERVAL_MS = 3 * 60 * 1000;
export const recoveryReplyWindow = key => String(key).startsWith('private:') ? 5 * 60 * 1000 : 2 * 60 * 1000;
export function eventTimeMs(value, now = Date.now()) {
  const n = Number(value), at = n > 1e12 ? n : n * 1000;
  return Number.isFinite(at) && at > 1e12 && at <= now + 30000 ? at : null;
}
export function normalizeRecovery(raw = {}) {
  return {
    version: 1, selfId: /^\d+$/.test(String(raw?.selfId || '')) ? String(raw.selfId) : '',
    floorAt: Number(raw?.floorAt) || 0, lastCheckedAt: Number(raw?.lastCheckedAt) || 0,
    imported: Math.max(0, Number(raw?.imported) || 0), historyOnly: Math.max(0, Number(raw?.historyOnly) || 0),
    lastImportedAt: Number(raw?.lastImportedAt) || 0, limited: raw?.limited === true,
    error: ['history-unavailable','identity-mismatch','persist-failed'].includes(raw?.error) ? raw.error : null,
    replyUntilAt: Number(raw?.replyUntilAt) || 0, wakeAt: Number(raw?.wakeAt) || 0,
    seenIds: [...new Set((Array.isArray(raw?.seenIds) ? raw.seenIds : []).filter(x => typeof x === 'string' && x.length <= 100))].slice(-256)
  };
}
export function historyFloor(st, now = Date.now()) {
  const old = normalizeRecovery(st.historyRecovery).floorAt;
  const times = (st.recentMessages || []).map(m => Number(m.time)).filter(n => n > 1e12 && n <= now);
  return Math.max(now - RECOVERY_LOOKBACK_MS, old || (times.length ? Math.min(...times) : now));
}
export function historyText(event) {
  if (Array.isArray(event.message)) return event.message.map(s => {
    if (s.type === 'text') return String(s.data?.text || '');
    if (s.type === 'at') return '[提及成员]';
    if (s.type === 'image') return '[历史图片：未读取内容]';
    if (s.type === 'video') return '[历史视频：未读取内容]';
    if (s.type === 'record') return '[历史语音：未读取内容]';
    if (s.type === 'forward') return '[历史转发：未展开]';
    if (s.type === 'json' || s.type === 'xml') return shareCardText(s.data?.data) || '[历史分享卡片：未展开]';
    return '';
  }).join('');
  return typeof event.message === 'string' ? event.message.replace(/\[CQ:[^\]]+\]/g, '[历史媒体：未读取]') : '';
}
export function historyClosed(text) {
  return /(?:不用(?:回|回复)|别回了|不聊了|先这样|就这样|晚安|拜拜|下了|问题(?:已经)?解决了|没事了)/i.test(text)
    || /^(?:好[的吧]?|嗯+|哦+|收到|ok|谢谢(?:你)?|谢啦)[\s。，！!,.~～]*$/i.test(text.trim());
}
export function knownMessage(st, id) {
  if (id == null || String(id) === '') return false;
  const s = String(id);
  return normalizeRecovery(st.historyRecovery).seenIds.includes(s)
    || [...st.recentMessages || [], ...st.unread || []].some(m => String(m.messageId || '') === s);
}
export function rememberMessage(st, id) {
  if (id == null || String(id) === '') return;
  const r = normalizeRecovery(st.historyRecovery); r.seenIds = [...new Set([...r.seenIds, String(id)])].slice(-256); st.historyRecovery = r;
}
export function planHistory(st, events, { key, selfId, now = Date.now() }) {
  const kind = String(key).split(':')[0], target = String(key).split(':')[1];
  const r = normalizeRecovery(st.historyRecovery);
  if (!/^\d+$/.test(String(selfId)) || (r.selfId && r.selfId !== String(selfId))) throw Error('identity-mismatch');
  if (events.some(m => m.self_id != null && String(m.self_id) !== String(selfId))) throw Error('identity-mismatch');
  const floor = historyFloor(st, now), seen = new Set(r.seenIds);
  for (const m of [...st.recentMessages || [], ...st.unread || []]) if (m.messageId != null) seen.add(String(m.messageId));
  const scoped = events.filter(m => m.message_type === kind && (kind === 'group' ? String(m.group_id) === target : [target, String(selfId)].includes(String(m.user_id))))
    .map(m => ({ event: m, at: eventTimeMs(m.time, now), id: m.message_id == null ? '' : String(m.message_id) }))
    .filter(m => m.at != null && m.at >= floor && m.id).sort((a,b) => a.at-b.at);
  const replyAt = Math.max(Number(st.lastAiReplyAt) || 0, ...scoped.filter(m => String(m.event.user_id) === String(selfId)).map(m => m.at));
  const latestKnownIncoming = Math.max(0, ...(st.recentMessages || []).filter(m => !m.isSelf).map(m => Number(m.time) || 0));
  const messages = [];
  for (const m of scoped) {
    if (String(m.event.user_id) === String(selfId) || seen.has(m.id)) continue;
    seen.add(m.id);
    const text = historyText(m.event); if (!text) continue;
    const direct = kind === 'private' || (Array.isArray(m.event.message) && m.event.message.some(s => s.type === 'at' && String(s.data?.qq) === String(selfId)));
    messages.push({ ...m, text, direct, pending: false });
  }
  const latest = messages.at(-1);
  // Only the current unresolved end of a recent exchange may wake the model.
  if (latest && latest.direct && now-latest.at <= recoveryReplyWindow(key) && latest.at > replyAt && latest.at >= latestKnownIncoming && !historyClosed(latest.text)) {
    for (const m of messages) if (m.direct && m.at > replyAt && now-m.at <= recoveryReplyWindow(key)) m.pending = true;
  }
  return { messages, floor, selfId: String(selfId), replyUntilAt: latest?.pending ? latest.at+recoveryReplyWindow(key) : 0 };
}
export function recoveryHint(st) {
  if (!(st.recentMessages || []).some(m => m.recovered)) return '';
  return '【断线补收】带 recovered/historyOnly 的消息保留原发送时间，是后来补到的历史；不可当作刚收到。historyOnly 只供理解经历：不逐条补回、不补过时问候、不重开已结束的话题。后来已有回复或新话题时，以现在的消息为先。若仍近期、直接找你且尚未回应，可结合间隔自然接回一次，不编造离线期间活动，不展示工程说明。\n\n';
}
export function recoverySendExpired(st, now = Date.now()) {
  const r = normalizeRecovery(st.historyRecovery);
  return st.lastWakeReason === 'historyRecovery' && r.replyUntilAt > 0 && now > r.replyUntilAt
    && !(st.recentMessages || []).some(m => !m.isSelf && !m.recovered && m.time > r.wakeAt);
}
