// Evidence-backed reflections. Numbers describe communication load; they do not
// manufacture knowledge, emotions, intimacy or consent. All functions are pure.
import { createHash } from 'node:crypto';

const clip = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const list = v => Array.isArray(v) ? v : [];
const unique = v => [...new Set(list(v))];
const idFor = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 20);
const KINDS = ['interest', 'relationship', 'feeling'];
const FEELINGS = ['curious', 'pleased', 'disappointed', 'annoyed', 'calm'];
const isRecall = text => /上(?:次|回)|之前|原来|最初|当时|后来|改(?:口|判)|补充了什么|记得|那件事|那句话/.test(String(text));
function acquiredPublic(s){
  if(s?.type==='bili')return true;
  if(!['study','reading'].includes(s?.type)||!/^leisure-[a-f0-9]{20}$/.test(s.id||'')||!s.boundary||!list(s.parts).some(p=>p.kind==='text'&&p.text&&p.coverage))return false;
  try{const u=new URL(s.url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&(['study'].includes(s.type)?['csdiy.wiki','cs50.harvard.edu','docs.python.org','developer.mozilla.org']:['ncode.syosetu.com','kakuyomu.jp']).includes(u.hostname);}catch{return false;}
}
export const EXPERIENCE_POLICY = '【经历与交流余力】性格主轴保持稳定，偏好通过具体选择和理由体现。实际取得的简介、字幕、观众意见和他人转述各有边界；模拟追番进度不是内容知识。没有资料就承认未知，不编观看经历。引用故事时保留谁做了什么、谁承担后果，不因反驳要求而改写已经确认的事实；拒绝无条件站队不等于推翻有依据的判断。兴趣能让你愿意多接一句，不能把交流余力充满；低余力减少额外开话题，但直接求助、已经答应的事仍认真完成。情绪针对具体事件/人，不迁怒其他人；正常忙碌、未回复、合理不同意见不当作冒犯。关系数字只是一份粗略指标，亲近方式看共同经历、偏好和边界，不能由高分推导恋爱、无条件赞同或取消拒绝。遇到值得保留的具体观点、感受、偏好或关系事件，用 qq_experience(action="reflect") 记录依据和理由。相处偏好用 kind="relationship" 并指定来源消息的 userId 原值作为 target（不是昵称），key/token 保持本会话不变；暂时感受用 kind="feeling" 写清触发原因和对象；已明确表达且值得后续接续的不痛快要保存为 feeling，不只记成长期相处规则。能确认的道歉/补充信息要更新旧记录，避免让已经解开的误会永久留在印象中。不必每轮写，不为凑数制造事件。观点可修正，误会可修复，修正时用原 id 保留沿革。';
export const OPINION_RETENTION_HINT = '【值得保留时怎样记】对实际取得的作品片段或对方提供的具体故事形成明确判断，或补充信息改变你的判断时，保存/更新 kind="interest"：写自己的态度、理由及已读来源。若同时需要记对方喜好，先把自己的具体判断存为 interest，再另存 relationship；一条“对方偏好”不能替代你自己的作品评价。发生改判要用原 interest 的 id 保留旧判断和新增依据，不能只口头改口或换个主题新建。自己没形成具体判断就不建条目。';
export const SELF_HISTORY_HINT='【理解与亲身经历】知道知识可以直接解释、举例、吐槽；但知识例子和网页上的练习不是你做过的事。没有保存的执行记录，就说“可以试/我想试”，不说“我当初试出来/我写过/我每次都会”。来源里的身份和事实优先于笔记里的推测，不能从局部动作、工作痕迹或观点反推人物职业。临时情绪可以有，但不能编昨天、长期习惯或已经做完的活动来支撑它。';

export function normalizeExperience(raw = {}) {
  return { version: 1,
    sources: list(raw.sources).filter(s => s?.id && acquiredPublic(s)).slice(-24),
    records: list(raw.records).filter(r => r?.id && KINDS.includes(r.kind) && r.topic && r.position && r.reason).slice(-60)
  };
}

export function addAcquiredSource(raw, source, now = Date.now()) {
  const journal = normalizeExperience(raw);
  if (source?.type !== 'bili' || !/^BV[0-9A-Za-z]{10}$/.test(source.bvid || '') || !source.title || !list(source.parts).length) throw Error('没有取得有效资料');
  const parts = source.parts.filter(p => ['metadata', 'subtitle', 'comments', 'danmaku'].includes(p.kind) && p.text)
    .map(p => ({ kind: p.kind, text: clip(p.text, 4000), coverage: clip(p.coverage, 100) }));
  if (!parts.length) throw Error('没有取得有效正文');
  const entry = { id: 'bili-' + idFor([source.bvid, parts]), type: 'bili', bvid: source.bvid,
    title: clip(source.title, 150), url: 'https://www.bilibili.com/video/' + source.bvid,
    acquiredAt: now, parts, boundary: '仅取得这些文字；没有画面或原始音频，不代表看完番剧或视频' };
  const existing = journal.sources.find(s => s.id === entry.id);
  journal.sources = [...journal.sources.filter(s => s.id !== entry.id), existing || entry].slice(-24);
  return { journal, source: existing || entry };
}

function evidenceFor(journal, input, messages, seen, redact) {
  const seqs = unique(input.sourceSeqs), ids = unique(input.sourceIds);
  if (seqs.length > 6 || ids.length > 3 || (!seqs.length && !ids.length)) throw Error('请提供已读消息 seq 或本会话实际取得的 sourceId');
  const evidence = seqs.map(seq => {
    const m = messages.find(m => m?.seq === seq);
    if (!Number.isSafeInteger(seq) || !seen.has(seq) || !m) throw Error('来源消息不在本会话已读快照中');
    return { type: 'message', seq, at: Number(m.time) || 0, userId: clip(m.userId, 20),
      sender: redact(clip(m.sender, 60)), isSelf: m.isSelf === true, text: redact(clip(m.plain || m.text, 1200)) };
  });
  for (const id of ids) {
    const s = journal.sources.find(s => s.id === id);
    if (!s) throw Error('sourceId 不是本会话实际取得的资料');
    // Retain a bounded supporting excerpt, not another full copy of the query.
    evidence.push({ ...s, parts: s.parts.map(p => ({ ...p, text: clip(p.text, 800) })) });
  }
  return evidence;
}

export function reflectExperience(raw, input, { messages = [], seen = new Set(), now = Date.now(), redact = v => v, assertPublic = () => {} } = {}) {
  const journal = normalizeExperience(raw);
  if (!KINDS.includes(input.kind)) throw Error('kind 必须是 interest / relationship / feeling');
  const topic = redact(clip(input.topic, 100)), position = redact(clip(input.position, 300)), reason = redact(clip(input.reason, 400));
  if (!topic || !position || !reason) throw Error('需要具体主题、态度和理由');
  const evidence = evidenceFor(journal, input, messages, seen, redact);
  const target = clip(input.target, 20);
  if (input.kind === 'relationship' && !target) throw Error('关系事件必须指定来源中真实出现的人');
  if (input.kind === 'feeling' && ['annoyed','disappointed'].includes(input.feeling) && !target && evidence.some(e => e.type === 'message' && !e.isSelf)) throw Error('对聊天事件的不快必须指定对象，不能变成对所有人的情绪');
  if (target && !evidence.some(e => e.type === 'message' && !e.isSelf && e.userId === target)) throw Error('target 必须填写来源消息的 userId 字符串原值，不能填昵称、sender 或角色名；保持当前 key/token 不变');
  const visibility = input.visibility === 'public' ? 'public' : 'conversation';
  // Only a reflection exclusively based on acquired public material can travel
  // across conversations. Personal/chat/relationship evidence stays scoped.
  if (visibility === 'public') {
    if (input.kind !== 'interest' || target || evidence.some(e => !acquiredPublic(e))) throw Error('聊天与人物经历不能公开到其他会话');
    assertPublic(topic + '\n' + position + '\n' + reason);
  }
  const old = input.id ? journal.records.find(r => r.id === input.id) : null;
  if (input.id && !old) throw Error('待修正的 id 不存在');
  if (old && (old.kind !== input.kind || old.target !== target || old.visibility !== visibility)) throw Error('修正不能改变经历类别、对象或可见范围');
  const feeling = FEELINGS.includes(input.feeling) ? input.feeling : '';
  if (input.kind === 'feeling' && !feeling) throw Error('感受需要 feeling');
  const identity = [input.kind, topic, target, visibility];
  const entry = { id: old?.id || 'exp-' + idFor(identity), kind: input.kind, topic, position, reason, target,
    feeling, visibility, evidence, createdAt: old?.createdAt || now, updatedAt: now,
    expiresAt: input.kind === 'feeling' ? now + Math.max(1, Math.min(24, Number(input.hours) || 6)) * 3600000 : 0,
    resolved: input.resolved === true,
    revisions: old ? [...list(old.revisions), { position: old.position, reason: old.reason, at: old.updatedAt }].slice(-4) : [] };
  const same = journal.records.find(r => r.id === entry.id);
  if (!old && same) throw Error('同一主题已有记录，请用原 id 修正，避免堆重复印象');
  journal.records = [...journal.records.filter(r => r.id !== entry.id), entry].slice(-60);
  return { journal, entry };
}

export function selectExperiences(raw, { text = '', target = '', now = Date.now(), limit = 6 } = {}) {
  const recall = isRecall(text);
  const records = normalizeExperience(raw).records.filter(r => recall || (!r.resolved && (!r.expiresAt || r.expiresAt > now)));
  const tokens = unique([clip(text), ...(String(text).match(/[\u4e00-\u9fff]{2,8}|[a-z0-9]{3,}/gi) || [])]);
  const relevant = r => r.target ? r.target === target : tokens.some(t => t && (r.topic.includes(t) || t.includes(r.topic) || String(r.reason).includes(t)));
  return records.map(r => ({ r, score: (relevant(r) ? 10 : 0) + (r.kind === 'interest' && !r.target ? 1 : 0) }))
    .filter(x => x.score > 0 && (!x.r.target || x.r.target === target))
    .sort((a, b) => b.score - a.score || b.r.updatedAt - a.r.updatedAt).slice(0, limit).map(x => x.r);
}

export function experienceContext(raw, options = {}) {
  const records = selectExperiences(raw, options);
  if (!records.length) return '';
  const rows = records.map(r => {
    const origins = r.evidence.map(e => e.type === 'bili' ? '取得的' + e.parts.map(p => p.kind).join('/') + '《' + e.title + '》' : ['study','reading'].includes(e.type)?'实际读取的'+(e.type==='study'?'学习资料':'原作')+'片段《'+e.title+'》；'+e.parts.map(p=>p.coverage).join('/') : (e.isSelf ? '自己实际说过' : e.sender + '当时提供的说法')).join('；');
    const historical = r.resolved ? '（历史：已经化解，不是当前不快）' : r.expiresAt && r.expiresAt <= (options.now || Date.now()) ? '（历史：感受已到期，不是当前情绪）' : '';
    const revisions = isRecall(options.text) ? list(r.revisions).slice(-2).map(v=>'此前判断：'+clip(v.position,160)+'；当时依据：'+clip(v.reason,160)).join('\n') : '';
    return `[${r.id}] ${r.kind === 'interest' ? '兴趣观点' : r.kind === 'relationship' ? '相处经历' : '暂时感受'}${historical}·${r.topic}${r.target ? '（仅针对 ' + r.target + '）' : ''}：${r.position}；原因：${r.reason}；依据：${origins}${list(r.revisions).length ? '；已修正过观点' : ''}${revisions?'\n'+revisions:''}`;
  });
  return '【可接续的实际经历】只在相关处自然使用，不背档案；转述不升级为事实，观点不升级为亲身观看。\n' + rows.join('\n');
}

export function publicExperiences(journals) {
  const records = journals.flatMap(j => normalizeExperience(j).records).filter(r => r.visibility === 'public' && r.kind === 'interest' && !r.target && r.evidence.length&&r.evidence.every(acquiredPublic));
  return { records: [...new Map(records.sort((a,b)=>a.updatedAt-b.updatedAt).map(r => [r.id, r])).values()].slice(-60), sources: [] };
}

export function communicationHint({ energy = 70, interested = false } = {}) {
  const low = energy <= 20, mid = energy <= 45;
  return '【交流余力】' + (low ? '较低，少加支线或主动找话题；必要答案给完整，可以坦率说稍后再展开。' : mid ? '一般，优先当前问题，不连续抛新话题。' : '充足，可按话题自然延伸，不强行提问。')
    + (interested ? '当前话题有已有兴趣依据，愿意围绕具体内容多接一两句；余力数值不因此增加。' : '')
    + '余力与对人的喜恶分开；认真求助和有效约定不因低余力敷衍。';
}

export function activityContext({ now = new Date(), enabled = true, factor = 1, sleeping = false } = {}) {
  const clock = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const value = Number.isFinite(Number(factor)) ? Math.max(0, Math.min(1.5, Number(factor))) : 1;
  const state = !enabled ? '作息调节已关闭，不能按钟点推断自己困了。'
    : sleeping ? '配置中的低活动时段，少主动开支线；正在回应的具体问题仍认真处理。'
    : value >= 0.8 ? '配置中的正常或活跃时段，可以继续当前话题；夜间钟点本身不是去睡的理由。'
    : '配置中的较低活动时段，按当前话题决定多聊或少聊，不等于已经睡了。';
  return '【此刻作息】本地时间 ' + clock + (enabled ? '，作息系数 ' + Number(value.toFixed(3)) : '') + '。' + state
    + '以这次状态为准，旧对话说过的困意或晚安不自动延续。交流余力表示聊天投入程度，不是身体困意；后台潜水、沉睡、唤醒是消息调度，不是去睡觉或被人吵醒。'
    + '对方还在继续话题时，接当前内容，不反复用想睡了、晚安收尾。确实想少聊时说具体原因；对方明确告别或去睡时可以自然道晚安，之后重新开口就重新判断。';
}
