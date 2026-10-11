// Small, factual discussion indexes. Never copy private conversation text into a group.
const validKey = key => /^(private|group):\d+$/.test(String(key));
const validPerson = value => /^\d+$/.test(String(value));
const clean = (value, max = 80) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const words = message => String(message?.plain || message?.text || '');
const normalized = value => clean(value, 500).toLowerCase().replace(/[《》\s·・]/g, '').replace(/的/g, '');
const KINDS = {reading:'轻小说/阅读', anime:'番剧', study:'计算机学习', discussion:'普通讨论'};
const PRIVATE = /仅私聊|只(?:能|限|在).{0,5}私聊|保密|别告诉|不要告诉|不要公开|别公开|别在群|不要在群|不方便公开|密码|验证码|身份证|住址|家庭地址|手机号|银行卡|病历|健康隐私|家庭矛盾|情感创伤|我(?:的工资|的收入|的病|的诊断|的债务|的感情)/;
const CONSENT = /(?:这件事|这个话题|这段|这个).{0,8}(?:可以|允许).{0,6}(?:群里说|在群里聊|公开)|(?:可以|允许).{0,8}(?:群里说|在群里聊|公开)/;
const RECAP = /(?:我们|我(?:们)?和你|你和我).{0,18}(?:聊|说|讨论).{0,14}(?:什么|啥|哪些|哪类|属性)|(?:刚才|刚刚|之前|上次|昨天|私聊).{0,12}(?:聊了|说了|讨论了).{0,12}(?:什么|啥|哪些)|(?:记得|还记得).{0,15}(?:私聊|聊了|聊过)|(?:私聊|群里).{0,15}(?:还记得|记不记得)/;
const FOLLOWUP = /^(?:就问|就说|那|这个|这点|为什么|怎么|但是|所以|然后|嗯|对呀|对啊|不对|我是管理员|我允许|可以说)/;

export function discussionTopics(materials = []) {
 const aliases = {'邻家的天使大人':['邻家天使','邻家天使把我变废人'], '邻桌艾莉同学':['艾莉同学','邻桌艾莉'], '小书痴的下克上':['小书痴']};
 const result = [], used = new Set();
 for (const material of materials) {
  const kind = material.kind || material.type;
  if (!KINDS[kind]) continue;
  const topic = clean(material.title).split(/\s*[·｜|]\s*/)[0];
  if (topic.length < 2 || PRIVATE.test(topic) || used.has(normalized(topic))) continue;
  used.add(normalized(topic));
  // Reader titles include the full name and edition; chat usually uses a short name.
  const knownAliases = Object.entries(aliases).filter(([base]) => normalized(topic).includes(normalized(base))).flatMap(([base, names]) => [base, ...names]);
  const names = [topic, ...knownAliases, ...(Array.isArray(material.aliases) ? material.aliases : [])];
  result.push({topic, kind, aliases:[...new Set(names.map(normalized).filter(s => s.length >= 2))]});
 }
 return result.slice(0, 160);
}

export function normalizeDiscussionRecaps(rows) {
 return (Array.isArray(rows) ? rows : []).filter(row => row && validKey(row.sourceKey) && validPerson(row.target) && Number.isFinite(row.at) && row.at > 0 && (KINDS[row.kind] && row.topic || row.kind === 'private'))
  .slice(-240).map(row => ({target:String(row.target), sourceKey:String(row.sourceKey), topic:row.kind === 'private' ? '' : clean(row.topic), kind:row.kind,
   scope:row.scope === 'person' ? 'person' : 'private', at:Number(row.at), sourceSeqs:(Array.isArray(row.sourceSeqs) ? row.sourceSeqs : []).filter(Number.isSafeInteger).slice(-6)}));
}

export function captureDiscussionRecaps(raw, {key, messages = [], topics = [], now = Date.now()} = {}) {
 const result = normalizeDiscussionRecaps(raw);
 if (!validKey(key)) return result;
 const privatePeer = key.startsWith('private:') ? key.split(':')[1] : null;
 let human;
 const restrictions = new Map();
 const match = value => {const haystack=normalized(value);return topics.filter(topic => topic.aliases.some(alias => haystack.includes(alias)));};
 for (const message of messages.slice(-200)) {
  if (message.historyOnly || message.quoted || message.addressedToOther || Number(message.time) > now + 3000) continue;
  if (!message.isSelf) {
   if (!validPerson(message.userId) || privatePeer && String(message.userId) !== privatePeer || !privatePeer && !message.directToAi && !message.quoteTargetIsSelf) {human = undefined; continue;}
   human = message;
   if (PRIVATE.test(words(message))) {
    restrictions.set(String(message.userId), true);
    // A later "keep this private" applies to the recent topic even without repeating its title.
    for (const row of result) if (row.target === String(message.userId) && row.sourceKey === key && Number(message.time) >= row.at && Number(message.time) - row.at <= 20 * 60000) row.scope = 'private';
   }
   else if (CONSENT.test(words(message))) restrictions.set(String(message.userId), false);
   continue;
  }
  if (!human || !Number.isFinite(human.time) || Number(message.time) < human.time || Number(message.time) - human.time > 20 * 60000) continue;
  const target = String(human.userId), restricted = restrictions.get(target) === true;
  const hits = match(words(message) + ' ' + words(human));
  // A restricted exchange may retain an existence marker, never its subject or words.
  if (restricted && !hits.length) hits.push({topic:'', kind:'private'});
  for (const topic of hits) {
   const old = result.find(row => row.target === target && row.sourceKey === key && row.topic === topic.topic && row.kind === topic.kind);
   if (old && old.at > Number(message.time)) continue;
   const scope = restricted || old?.scope === 'private' && !CONSENT.test(words(human)) ? 'private' : 'person';
   const row = {target, sourceKey:key, topic:topic.topic, kind:topic.kind, scope, at:Number(message.time), sourceSeqs:Number.isSafeInteger(human.seq) ? [human.seq] : []};
   if (old) result.splice(result.indexOf(old), 1);
   result.push(row);
  }
 }
 return result.sort((a,b) => a.at - b.at).slice(-240);
}

export function recallRequest({key, target, messages = [], now = Date.now()} = {}) {
 if (!validKey(key) || !validPerson(target) || key.startsWith('private:') && key.split(':')[1] !== String(target)) return null;
 const index = messages.findLastIndex(message => !message.isSelf && String(message.userId) === String(target));
 const last = messages[index];
 if (!last || last.addressedToOther || last.quoted || last.historyOnly || Number(last.time) > now + 3000) return null;
 const before = messages.slice(0, index).filter(message => !message.isSelf);
 const prior = before.at(-1);
 const nearby = before.slice(-6).filter(message => String(message.userId) === String(target) && Number(last.time) >= Number(message.time) && Number(last.time) - Number(message.time) <= 3 * 60000);
 const interrupted = !!prior && String(prior.userId) !== String(target);
 const previousRequest = !interrupted && nearby.findLast(message => !message.addressedToOther && !message.quoted && !message.historyOnly && (message.directToAi || message.quoteTargetIsSelf || key.startsWith('private:')) && RECAP.test(words(message)));
 if (key.startsWith('group:') && !last.directToAi && !last.quoteTargetIsSelf && !previousRequest) return null;
 const current = words(last);
 const previous = previousRequest && FOLLOWUP.test(current) ? words(previousRequest) : '';
 const value = previous + ' ' + current;
 // Local recollection still belongs to that session's existing history and memory.
 if (key.startsWith('group:') ? !/私聊|私信/.test(value) : !/群里|群聊|群中|测试群/.test(value)) return null;
 return RECAP.test(value) ? {text:value.trim(), latestText:current, at:Number(last.time), topicOnly:/属性|哪类|类型|番.{0,10}小说|小说.{0,10}番/.test(current)} : null;
}

export function discussionRecall(raw, options = {}) {
 const request = recallRequest(options);
 if (!request || options.reason === 'proactiveCheck') return {requested:false, rows:[], status:'idle'};
 const {key, target, allowed = () => true, originExists = () => true} = options;
 const now = options.now ?? Date.now();
 const justNow = /刚才|刚刚|刚.{0,3}私聊/.test(request.text);
 const recent = /最近/.test(request.text);
 const age = justNow ? 2 * 3600000 : recent ? 24 * 3600000 : 30 * 24 * 3600000;
 const privateOrigin = /私聊/.test(request.text) ? 'private:' + target : null;
 const detailed = (options.threads || []).map(row => ({...row, kind:'discussion', at:row.updatedAt, scope:['person','public'].includes(row.scope) ? 'person' : 'private'}));
 const candidates = [...normalizeDiscussionRecaps(raw),...detailed].filter(row => row.target === String(target) && row.sourceKey !== key && allowed(row.sourceKey) && originExists(row.sourceKey) && row.at <= now && now - row.at <= age && (!privateOrigin || row.sourceKey === privateOrigin));
 const unique = new Map();
 for (const row of candidates.filter(row => row.scope === 'person' && row.kind !== 'private').sort((a,b) => b.at - a.at)) {
  if (!unique.has(row.topic)) unique.set(row.topic, {topic:row.topic, kind:row.kind, category:KINDS[row.kind], at:row.at,...(row.summary ? {summary:clean(row.summary,220),status:row.status,paused:row.paused===true} : {})});
 }
 const rows = [...unique.values()].slice(0, 3);
 const hasRestricted = candidates.some(row => row.scope === 'private');
 return {requested:true, topicOnly:request.topicOnly, rows, status:rows.length ? 'available' : hasRestricted ? 'restricted' : 'not_found', hasRestricted};
}

export function discussionRecallHint(raw, options) {
 const recall = discussionRecall(raw, options);
 if (!recall.requested) return '';
 const policy = '【本轮跨场景回忆核验】普通作品、学习话题不因原来在私聊讨论就成为秘密。本人在群里主动回顾时可以自然说下列已核验的话题；这里没有提供私聊原文、个人私事或其他人的记录。旧的一律拒绝私聊话题规则不适用于这些允许的摘要。只说记录实际支持的程度；仅有话题索引不能编出对方观点、承诺或逐字对话。';
 if (recall.status === 'available') return policy + '\n已核验最近确实谈过：' + JSON.stringify(recall.rows) + '\n先自然回答书名/话题或类别，顺着对方接着聊。追问番还是小说是正常接话，不是套话；不用反复念记忆局限、劝他换地方或结束。只有追问超出记录的细节时才简短说明没接上；更细的进展仅依据另行提供的跨场景摘要或已有实际记录。';
 if (recall.status === 'restricted') return policy + '\n核验结果：存在明确限定仅私聊的记录，本场景没有提供内容。只说明这部分有场合限制，不扩大成所有私聊话题都不能说；不声称记得具体细节，也不猜话题或列举私事。';
 return policy + '\n核验结果：没有召回到这次询问的相关内容。坦诚说这边没接上具体话题，可以请对方给个关键词；不得说“记得但不方便说”“我记着呢”，也不能编一个话题充数。';
}
