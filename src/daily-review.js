// Deterministic local recap. Never invents facts, changes affinity, resolves a
// promise or calls a model. Records actual pending items and removes expired noise.
const DAY = 86400000;
export function reviewConversation(st, { now = Date.now(), day = '', hour = 5, enabled = true } = {}) {
  if (!enabled || new Date(now).getHours() < hour || st.reviewStatus?.day === day) return null;
  const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts : [];
  const topics = Array.isArray(st.activeTopics) ? st.activeTopics : [];
  const pendingThoughts = thoughts.filter(t => t && (!t.expiresAt || Number(t.expiresAt) > now));
  const activeTopics = topics.filter(t => t && (!t.lastMentionAt || now - Number(t.lastMentionAt) < DAY || t.pendingQuestion));
  const open = (st.continuity?.commitments ?? []).filter(c => c && !['completed', 'cancelled'].includes(c.status));
  const unreadDirect = (st.unread ?? []).filter(m => m && !m.isSelf && m.directToAi && !m.addressedToOther).map(m => m.seq).filter(Number.isSafeInteger).slice(-20);
  const reviewStatus = { day, at: now, kind: 'local-evidence-recap', pendingCommitments: open.length,
    dueCommitments: open.filter(c => c.dueAt && Number(c.dueAt) <= now).length,
    unreadDirectSeqs: unreadDirect, pendingTopics: activeTopics.filter(t => t.pendingQuestion).length,
    expiredThoughtsRemoved: thoughts.length - pendingThoughts.length, staleTopicsRemoved: topics.length - activeTopics.length };
  return { pendingThoughts, activeTopics, reviewStatus };
}
export function reviewHint(st) {
  const r = st.reviewStatus;
  if (!r) return '';
  return `【本会话待办复盘】本地整理过记录：未结束约定 ${r.pendingCommitments} 条，待接续问题 ${r.pendingTopics} 条。具体内容仍以当前记忆和未读消息为准；复盘没有替你完成任务，也没有生成新经历。`;
}

export function assertPublicSelfText(text, { sensitive, people = [], nicknames = [] } = {}) {
  if (sensitive?.test(text)) throw new Error('公开内容含敏感信息特征');
  const references = new Set(nicknames.filter(x => typeof x === 'string' && x.length >= 2));
  for (const p of people) {
    if (p?.name && String(p.name).length >= 2) references.add(String(p.name));
    for (const fact of Array.isArray(p?.privateFacts) ? p.privateFacts : []) {
      const value = typeof fact === 'string' ? fact : fact?.text ?? fact?.content;
      if (typeof value === 'string' && value.length >= 8) references.add(value);
    }
  }
  if ([...references].some(value => text.includes(value))) throw new Error('公开内容涉及已记录的人名、外号或私聊资料，请改为自己的观点');
}
