// Contextual expression policy; character identity remains in the existing role card.
const STOP = /(?:别|不要|停止|不许|停下).{0,5}(?:调侃|开玩笑|阴阳|骂|嘴臭|叫我|起外号)|收起.{0,3}(?:玩笑|调侃)/;
const RESUME = /(?:可以|继续|恢复).{0,5}(?:调侃|开玩笑|叫外号)|不用那么认真/;
const SERIOUS = /认真(?:问|回答|点|一下)|求助|帮我|请帮|报错|故障|怎么(?:办|解决|修)|看病|生病/;
const DISTRESS = /难过|崩溃|焦虑|失眠|难受|心情不好|很累|委屈|害怕|撑不住|自杀|不想活|想死/;
const PLAYFUL = /哈哈|笑死|玩笑|开玩笑|绷|极限拉扯|乐了/;
const REQUEST = /帮我|请帮|求助|认真|怎么办|怎么解决|你(?:觉得|说|看)|[?？]/;
const wordsOf = msg => String(msg?.tail || msg?.plain || msg?.text || '');
const identity = msg => String(msg?.userId || msg?.sender || '').trim().slice(0, 80);

// Transport face labels describe tone, not a request to teach emoji.
export function expressionIntent(st) {
  const focus=replyFocus(st);
  if(!focus||focus.historyOnly||focus.addressedToOther)return null;
  const raw=String(focus.plain||focus.text||''),text=raw.replace(/\[(?:表情\s+|QQ表情:)[^\]]*\]/g,'');
  const subject=/表情|黄豆|emoji|这个梗|这梗/i.test(text);
  const correction=/^(?:不不[，, ]|不对[，, ])/u.test(text)||/不是(?:专门|用来|用于|在|这个用法)|(?:是|用于).{0,12}(?:时候|开玩笑|装乖)/u.test(text);
  if(subject&&correction)return 'correction';
  if(subject&&/怎么|什么时候|意思|用法|能不能|会不会|发.{0,6}(?:个|一个)|想看|看看你发/i.test(text))return 'query';
  const previous=(st.recentMessages||[]).filter(m=>m.isSelf).slice(-2).map(m=>String(m.plain||m.text||'')).join('\n');
  if(/什么时候发|这个(?:是啥意思|是什么意思|什么意思|怎么用)|这个怎么说/.test(text)&&/表情|黄豆|emoji|\[(?:表情 |QQ表情:)/i.test(raw+previous))return 'query';
  return null;
}

export function expressionTargets(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(x => typeof x === 'string').map(x => x.slice(0, 80)).filter(Boolean))].slice(-100);
}

export function expressionBoundaryEvents(value) {
  return (Array.isArray(value)?value:[]).filter(e=>e&&typeof e.target==='string'&&e.target.length<=80&&typeof e.quiet==='boolean'&&Number.isFinite(e.at)&&e.at>=0)
    .map(e=>({target:e.target,quiet:e.quiet,at:e.at})).slice(-100);
}
export function sharedExpressionTargets(states) {
  const latest=new Map();
  for(const st of states){
    for(const target of expressionTargets(st.expressionQuietTargets))if(!latest.has(target))latest.set(target,{quiet:true,at:0});
    for(const e of expressionBoundaryEvents(st.expressionBoundaryEvents)){const old=latest.get(e.target);if(!old||e.at>=old.at)latest.set(e.target,e);}
  }
  return [...latest].filter(([,e])=>e.quiet).map(([target])=>target);
}

export function observeExpressionPreference(st, msg) {
  const who = identity(msg);
  if (!who || msg?.isSelf || msg?.addressedToOther) return;
  const text = wordsOf(msg);
  const quiet = new Set(expressionTargets(st.expressionQuietTargets));
  if (STOP.test(text) || RESUME.test(text)) {
    const stop=STOP.test(text);if(stop)quiet.add(who);else quiet.delete(who);
    st.expressionBoundaryEvents=[...expressionBoundaryEvents(st.expressionBoundaryEvents).filter(e=>e.target!==who),{target:who,quiet:stop,at:Date.now()}].slice(-100);
  }
  st.expressionQuietTargets = [...quiet].slice(-100);
}

// Keep an unanswered direct request in focus when another speaker interjects.
// Only the current incoming batch is considered; old answered topics never stick.
export function replyFocus(st) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const lastSelf = recent.findLastIndex(m => m?.isSelf);
  const pending = recent.slice(lastSelf + 1).filter(m => m && !m.isSelf && !m.addressedToOther);
  const unread = Array.isArray(st?.unread) ? new Set(st.unread.map(m => m?.seq)) : null;
  const candidates = pending.filter(m => !unread || !Number.isSafeInteger(m.seq) || unread.has(m.seq));
  const direct = candidates.filter(m => m.directToAi || m.quoteTargetIsSelf || /鲸鱼|小鲸|本鲸/.test(wordsOf(m)));
  return direct.find(m => REQUEST.test(wordsOf(m)) || STOP.test(wordsOf(m)))
    || direct.at(-1) || candidates.find(m => SERIOUS.test(wordsOf(m)) && REQUEST.test(wordsOf(m)))
    || candidates.at(-1) || [...recent].reverse().find(m => m && !m.isSelf && !m.addressedToOther);
}

export function expressionContext(st) {
  const last = replyFocus(st);
  const text = wordsOf(last);
  if (expressionTargets(st?.expressionQuietTargets).includes(identity(last)) || STOP.test(text)) return 'restrained';
  if (DISTRESS.test(text) && !(PLAYFUL.test(text) && !/真的|真(?:的)?很|撑不住|救命|帮我|求助|自杀|不想活|想死/.test(text))) return 'supportive';
  if (SERIOUS.test(text)) return 'serious';
  if (/论文|作业|考试/.test(text) && /帮|求助|怎么|不会|不懂|认真/.test(text)) return 'serious';
  return 'casual';
}

export function buildExpressionHint(st, { enabled = true, library = {} } = {}) {
  const mode = expressionContext(st);
  let out = '【表达与性格】以当前角色为准，性格通过当下的态度和选择体现。表情、口癖、分条随意思使用，不凑次数；有理由的不同意见与真正的拒绝仍保留。';
  const notes = { restrained: '本轮收起调侃、辱骂和外号，直接回应。停止偏好只针对提出要求的人；只有对方明确恢复才恢复。', supportive: '本轮优先倾听和体谅，少下结论，不强塞梗、脏话或催问。', serious: '本轮认真回应已有问题，表达清楚，口癖和调侃让位于实际帮助。', casual: '轻松聊天可以显出兴致：接梗、偏心自己的口味、为一个小发现雀跃，熟人来搭话也值得开心。温度在短句里，不靠不耐烦证明个性；陌生人保留分寸。' };
  out += notes[mode];
  const focus = replyFocus(st);
  if (focus) out += `当前优先回应「${String(focus.card || focus.sender || focus.userId || '发言者').slice(0, 40)}」的这句话：${wordsOf(focus).slice(0, 160)}。这只是回复优先级，其他待回应的人仍分别处理；称呼、停止偏好和约定不串给旁人。`;
  const incoming = (st?.recentMessages || []).filter(m => m && !m.isSelf);
  if (focus?.messageId && incoming.at(-1) !== focus) out += `回复对象不是最新发言者，第一条用 replyToMessageId="${focus.messageId}" 引用该消息；不能引用时明确称呼该说话人，别让旁人猜。`;
  if (new Set((st?.unread || []).filter(m => !m?.addressedToOther).map(identity)).size > 1) out += '本批有多人：若分别回应两人，分两次调用发送工具，各自引用对方的 messageId 或明确称呼。一个 messages 数组只回应同一人，不把停止要求、玩笑和答案混发成没有对象的两条。';
  out += '可以表达自己的口味和容易出现的习惯；没有角色背景或已保存经历的支持时，用“我容易/我倾向”，不临时编造“我昨天/上周/刚玩过”的具体经历，也不把示例当已发生的事。';
  out += '可以只回一个有态度的小反应，也可以顺着同一个玩笑继续；不必每次完成“回答+细节+提问”的结构，不例行反问。对方纠正误会，认清后继续当前意思，不争输赢。认真问题给实际帮助，不以装傻、假失忆或故意答错表现个性。';
  if (enabled && mode === 'casual') {
    const pool = [...(Array.isArray(library.swear) ? library.swear : []), ...(Array.isArray(library.zuan) ? library.zuan : [])]
      .map(x => String(x?.w || '').trim()).filter(x => x && x.length <= 12 && !/[\r\n]/.test(x));
    if (pool.length) out += '可选表达例子：' + pool.slice(0, 3).join('、') + '；合适才用，可以一句都不用。同一口癖刚用过就少重复。';
  }
  out += '讨论视频时区分查到资料、读到字幕与看到画面；未取得的内容不补编，能力不足就具体说缺哪部分。';
  return out;
}

// Conservative affinity classification: a keyword is not evidence of its target.
export function classifyInteraction(text, { patterns = {}, directed = true, addressedToOther = false, repeatedPush = false, spamHint = false } = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (addressedToOther || !directed) return 'normal';
  const has = (k, fallback) => (Array.isArray(patterns[k]) ? patterns[k] : fallback).some(w => w && t.includes(w));
  const rude = has('rude', ['傻逼','弱智','智障','废物','滚','闭嘴','有病','恶心','垃圾','蠢','别说了']);
  const attack = /(?:你|鲸鱼|小鲸|机器人).{0,6}(?:傻逼|弱智|智障|废物|有病|恶心|垃圾|蠢)|^(?:滚|闭嘴|别说了)[!！。\s]*$/.test(t);
  const joking = /开玩笑|逗你|互损|玩梗/.test(t) || (PLAYFUL.test(t) && !/一直|每次|真是|真垃圾|就是个|闭嘴|滚/.test(t));
  if (rude && attack && !joking) return 'rude';
  if (repeatedPush && has('push', ['怎么不回','快点','回我','理我','说话啊','在吗','在不在'])) return 'push';
  if (has('gift', ['给你','送你','存这个','给你看','发你','拿去'])) return 'gift';
  if (has('good', ['谢谢','感谢','辛苦','厉害','牛逼','牛啊','说得对','有意思','喜欢你','可爱','靠谱','专业','对不起','抱歉'])) return 'good';
  if (has('fun', ['哈哈','笑死','绝了','典','急了','蚌埠','你说的对但是'])) return 'fun';
  return spamHint ? 'spam' : 'normal';
}

export function selectMemePhrases(entries, st, limit = 5) {
  if (expressionContext(st) !== 'casual') return [];
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const own = recent.filter(m => m?.isSelf).slice(-6).map(wordsOf).join('\n');
  const topic = wordsOf(replyFocus(st));
  return (Array.isArray(entries) ? entries : []).filter(e => {
    const text = String(e?.text || '');
    return text.length >= 2 && !/^(?:哈哈+|嘿嘿+|行吧|好的|收到|[?？]+)$/.test(text) && !own.includes(text);
  }).map((e, i) => ({ e, i, score: topic.includes(String(e.text)) ? 2 : 0 }))
    .sort((a,b) => b.score - a.score || (Number(a.e.usage) || 0) - (Number(b.e.usage) || 0) || a.i - b.i)
    .slice(0, Math.max(0, Math.min(8, Number(limit) || 0))).map(x => x.e);
}

export function selectContextSlang(entries, st) {
  const messages = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const focus = replyFocus(st);
  const text = [wordsOf(focus), ...messages.filter(m => !m?.isSelf && !m?.addressedToOther).slice(-3).map(wordsOf)].join('\n');
  return (Array.isArray(entries) ? entries : []).filter(e => e?.content && text.includes(String(e.content)));
}
