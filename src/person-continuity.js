// First-party contracts and bounded topic projections. No model, network or disk access.
import {discussionPaused} from './social-continuity.js';
import {normalizeDiscussionRecaps} from './person-recall.js';
const text=(v,n=180)=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n);
const validKey=k=>/^(private|group):\d+$/.test(String(k));
const id=v=>/^\d+$/.test(String(v))?String(v):'';
const sensitive=s=>/密码|口令|验证码|身份证|住址|家庭地址|手机号|银行卡|秘密|保密|别告诉|不要告诉|不要公开|别公开|私下|仅私聊|只在私聊|只能私聊/.test(s);
export function normalizePersonContinuity(raw={}){
 return {version:1,contracts:(Array.isArray(raw?.contracts)?raw.contracts:[]).filter(r=>id(r?.target)&&validKey(r.sourceKey)&&['peerAlias','selfAlias','preference'].includes(r.kind)&&r.slot&&r.value&&Number(r.at)>0)
 .slice(-400).map(r=>({...r,target:id(r.target),value:text(r.value),slot:text(r.slot,40),scope:['shared','private','conversation'].includes(r.scope)?r.scope:'private',state:r.state==='revoked'?'revoked':'active',at:Number(r.at),sourceSeq:Number(r.sourceSeq)||0})),
 threads:normalizePersonThreads(raw?.threads),recaps:normalizeDiscussionRecaps(raw?.recaps)};
}
export function capturePersonContracts(key,message){
 if(!validKey(key)||message?.isSelf||!id(message?.userId)||message?.quoted||message?.historyOnly)return [];
 const peer=key.startsWith('private:')?key.split(':')[1]:id(message.userId);
 if(peer!==id(message.userId)||key.startsWith('group:')&&!message.directToAi&&!message.quoteTargetIsSelf)return [];
 const raw=text(message.plain||message.text,400).replace(/^\[CQ:at,[^\]]+\]\s*/,'').trim();
 if(/^(?:[“「"'>]|(?:他说|她说|有人说|比如|例如|假如|如果|假设|转发|引用))/.test(raw))return [];
 const scope=/私聊|私下|我们俩|只有我们/.test(raw)?'private':/只在这个群|仅本群/.test(raw)?'conversation':'shared';
 const out=[],push=(kind,slot,value,state='active')=>{value=text(value,kind==='preference'?100:24).replace(/^[“「"']|[”」"']$/g,'');if(!value||/^[\d\s]+$/.test(value))return;out.push({target:peer,kind,slot,value,scope,state,sourceKey:key,sourceSeq:Number(message.seq)||0,at:Number(message.time)||Date.now()});};
 const alias='[“「"\']?([^，。！？!?；;\n”」"\']{1,24})[”」"\']?';
 let m=raw.match(new RegExp('^(?:(?:以后|今后|接下来|在私聊里|私聊里|只在私聊里|在群里)[，, ]*)?(?:你)?(?:就)?(?:叫我|称呼我)(?:为)?[：: ]?'+alias));
 if(m)push('peerAlias','address',m[1].replace(/(?:就行|就好|好了|吧|哦|啦|啊)$/,''));
 m=raw.match(new RegExp('^(?:(?:以后|今后|接下来|在私聊里|私聊里|只在私聊里)[，, ]*)?(?:我(?:就)?叫你|你的外号(?:就)?(?:叫|是))[：: ]?'+alias));
 if(m)push('selfAlias','address',m[1].replace(/(?:就行|就好|好了|吧|哦|啦|啊)$/,''));
 m=raw.match(new RegExp('^(?:(?:以后|今后|你)[，, ]*)?(?:不要|别|不许|别再)(?:再)?叫我[：: ]?'+alias));
 if(m)push('peerAlias','address',m[1].replace(/(?:了|啦|啊|吧)$/,''),'revoked');
 m=raw.match(new RegExp('^(?:(?:以后|今后)[，, ]*)?(?:我)?(?:不再|不|不要再)叫你[：: ]?'+alias));
 if(m)push('selfAlias','address',m[1].replace(/(?:了|啦|啊|吧)$/,''),'revoked');
 m=raw.match(/^(?:(?:以后|今后|你)[，, ]*)?((?:不要|别)(?:再)?拿[^，。！？!?；;]{1,30}(?:开玩笑|调侃|取笑))/);
 if(m)push('preference','banter',m[1]);
 m=raw.match(/^(?:(?:以后|今后|你)[，, ]*)?((?:不要|别)(?:再)?(?:催我|劝我睡觉|赶我去学习|赶我走)[^，。！？!?；;]{0,25})/);
 if(m)push('preference',/睡觉/.test(m[1])?'sleep':'company',m[1]);
 return out;
}
export function upsertPersonContract(raw,entry){
 const store=normalizePersonContinuity(raw),r={...entry,value:text(entry.value)};
 if(!id(r.target)||!validKey(r.sourceKey)||!['peerAlias','selfAlias','preference'].includes(r.kind)||!r.slot||!r.value)throw Error('无效的按人约定');
 const identity=x=>x.target===r.target&&x.kind===r.kind&&x.slot===r.slot;
 const old=store.contracts.filter(identity).sort((a,b)=>b.at-a.at||b.sourceSeq-a.sourceSeq)[0];
 if(old&&old.at>r.at)return store;
 if(old&&r.state==='revoked'&&r.kind!=='preference'&&old.value!==r.value)return store;
 // Retain a few previous forms to suppress superseded automatic nicknames.
 store.contracts=store.contracts.filter(x=>!identity(x)||x.at!==r.at||x.sourceSeq!==r.sourceSeq||x.sourceKey!==r.sourceKey);
 store.contracts.push(r);store.contracts=store.contracts.slice(-400);return store;
}
export function validatePersonContract(key,extra,messages,seen,now=Date.now()){
 const c=extra.contract,seqs=extra.sourceSeqs;
 if(!c||!Array.isArray(seqs)||!seqs.length||seqs.length>6||seqs.some(n=>!Number.isSafeInteger(n)||!seen.has(n)))throw Error('按人约定需要当前已读来源 sourceSeqs');
 const target=id(extra.qq||extra.target),source=seqs.map(seq=>messages.find(m=>m.seq===seq));
 if(!target||source.some(m=>!m||m.isSelf||m.addressedToOther||id(m.userId)!==target)||key.startsWith('private:')&&key.split(':')[1]!==target||key.startsWith('group:')&&!source.some(m=>m.directToAi||m.quoteTargetIsSelf))throw Error('只能根据本人已读消息保存自己的称呼或相处偏好');
 const value=text(c.value,c.kind==='preference'?100:24);
 if(!value||!source.some(m=>String(m.plain||m.text).includes(value)))throw Error('约定值必须出现在本人原话中');
 const recognized=source.flatMap(m=>capturePersonContracts(key,{...m,directToAi:true})).find(r=>r.kind===c.kind&&r.value===value);
 if(!recognized&&c.kind!=='preference')throw Error('称呼需要本人明确约定，不能从转述或玩笑推断');
 const joined=source.map(m=>String(m.plain||m.text)).join(' ');
 if(c.kind==='preference'&&!recognized&&!/^(?:(?:以后|今后)[，, ]*)?(?:我(?:不)?喜欢|我希望|请你|不要|别)/.test(joined))throw Error('相处偏好缺少本人明确表达');
 let scope=recognized?.scope||'private';
 if(c.scope==='private'||sensitive(joined))scope='private';
 if(c.scope==='conversation')scope='conversation';
 if(c.scope==='shared'&&!recognized&&(!key.startsWith('private:')||/可以.{0,6}(?:公开|群里)|在哪.{0,6}都/.test(joined))&&!sensitive(joined))scope='shared';
 if(c.state&&recognized&&c.state!==recognized.state)throw Error('约定状态与本人原话不一致');
 return {target,kind:c.kind,slot:recognized?.slot||text(c.slot,40)||'preference',value,scope,state:recognized?.state||'active',sourceKey:key,sourceSeq:Math.max(...seqs),at:now};
}
export function personContractView(raw,{key,target,allowed=()=>true}={}){
 if(!validKey(key)||!id(target)||key.startsWith('private:')&&key.split(':')[1]!==String(target))return [];
 const latest=new Map();
 for(const r of normalizePersonContinuity(raw).contracts.filter(r=>r.target===String(target)&&allowed(r.sourceKey)&&(r.scope!=='conversation'||r.sourceKey===key)).sort((a,b)=>a.at-b.at||a.sourceSeq-b.sourceSeq))latest.set(r.kind+'|'+r.slot,r);
 return [...latest.values()].filter(r=>r.scope==='shared'||r.scope==='private'||r.scope==='conversation'&&r.sourceKey===key)
 .map(r=>r.scope==='private'&&key.startsWith('group:')?{target:r.target,kind:r.kind,slot:r.slot,value:'',state:'privateOnly'}:Object.fromEntries(['target','kind','slot','value','state'].map(k=>[k,r[k]])));
}
export function personContractHint(raw,options){
 const rows=personContractView(raw,options);if(!rows.length)return '';
 return '【同一个人的称呼与相处约定】对象 userId='+options.target+'，这是同一位熟人，换群名片或聊天场合不重新认识。peerAlias 是你称呼对方，selfAlias 是对方称呼你；两者不能弄反。active 可自然使用，revoked 停止使用。privateOnly 表示记得有私聊限定约定，这里没有提供具体内容；自然使用平常称呼，不说忘了或不认识，也不猜私密称呼。只调整对该人的相处，不套到其他人。\n'+rows.map(r=>JSON.stringify(r)).join('\n');
}
export const PERSON_CONTRACT_HINT='【按人延续】本人明确约定双方称呼、修改/拒绝称呼或相处偏好时，可用 qq_memory_append(category="person",extra={target:本人userId,sourceSeqs:已读本人消息seq,contract:{kind:"peerAlias/selfAlias/preference",slot:"address或偏好主题",value:本人原话里的称呼或偏好,scope:"shared/private/conversation",state:"active/revoked"}})。普通称呼可跨场合，私聊限定/秘密不得公开；不替别人约定，不把名字相同当同一人。工具自动保存明确的称呼请求，但复杂表达需要读原话后记录；已保存就不重复写。';

export function normalizePersonThreads(rows){
 return (Array.isArray(rows)?rows:[]).filter(r=>r?.id&&id(r.target)&&validKey(r.sourceKey)&&['sharedEvent','commitment'].includes(r.category)&&r.topic&&r.summary)
 .slice(-240).map(r=>({id:text(r.id,64),category:r.category,target:id(r.target),sourceKey:r.sourceKey,topic:text(r.topic,60),summary:text(r.summary,220),scope:['person','public','private','conversation'].includes(r.scope)?r.scope:'private',
 status:['open','waiting','completed','cancelled'].includes(r.status)?r.status:'open',paused:r.paused===true,updatedAt:Number(r.updatedAt)||0,owner:r.owner==='other'?'other':'self',dueAt:Number(r.dueAt)||0,followUpCount:Math.min(2,Math.max(0,Number(r.followUpCount)||0)),lastFollowUpAt:Number(r.lastFollowUpAt)||0}));
}
const isPrivateSubject=s=>sensitive(s)||/仅限私聊|只(?:能|限|在)?.{0,5}私聊|不(?:能|要)在群|别在群|不方便公开|情感创伤|家庭矛盾|病历|健康隐私|真实姓名|联系方式|学校地址|我(?:家的|的工资|的收入|的病|的诊断|的债务|的感情)/.test(s);
const publicConsent=s=>/可以.{0,8}(?:群里说|在群里聊|公开)|(?:这件事|这个话题).{0,8}(?:群里也能|群里也可以)|在哪.{0,4}都能聊/.test(s);
const resume=s=>/接着|继续|上次|之前|昨天|刚才|那天|说好的|约好|答应|后来|进展|看完|读完|做完|结束|完成|搞定|取消|不聊|搁置|记得|聊过/.test(s);
const vague=s=>/接着聊|继续聊|刚才那个|之前那个|上次那个|昨天那个/.test(s);
const statusQuery=s=>/看完|读完|做完|结束|完成|搞定|取消|进展|后来|记得|说好|约好|答应|搁置|不聊/.test(s);
function firstPartySources(key,target,seqs,messages,seen){
 if(!validKey(key)||!id(target)||!Array.isArray(seqs)||!seqs.length||seqs.length>6||seqs.some(n=>!Number.isSafeInteger(n)||!seen.has(n)))throw Error('跨场景记录需要当前已读来源 sourceSeqs');
 const source=seqs.map(seq=>messages.find(m=>m.seq===seq)),human=source.filter(m=>m&&!m.isSelf);
 if(source.some(m=>!m||m.quoted||m.historyOnly)||!human.length||human.some(m=>id(m.userId)!==String(target)||m.addressedToOther||/^(?:[“「"'>]|他说|她说|有人说|比如|假如|转发|引用)/.test(String(m.plain||m.text).trim()))||key.startsWith('private:')&&key.split(':')[1]!==String(target)||key.startsWith('group:')&&!human.some(m=>m.directToAi||m.quoteTargetIsSelf))throw Error('只能接续本人直接参与且已经读过的讨论');
 return source;
}
export function upsertPersonThread(raw,{key,category,entry,crossContext,messages=[],seen=new Set(),now=Date.now()}){
 const store=normalizePersonContinuity(raw),old=store.threads.find(r=>r.id===entry.id);
 if(!crossContext&&!old)return store;
 const target=id(crossContext?.target||old?.target),source=firstPartySources(key,target,(entry.evidence||[]).map(e=>e.seq),messages,seen);
 if(old&&(old.target!==target||old.category!==category))throw Error('不能将已有话题换绑到其他人');
 const topic=text(crossContext?.topic||old.topic,60),summary=text(crossContext?.summary||entry.text,220),joined=source.map(m=>String(m.plain||m.text)).join(' ');
 if(topic.length<2||!summary||crossContext&&!source.some(m=>String(m.plain||m.text).includes(topic)))throw Error('跨场景主题必须出现在已读来源中');
 let scope=old?.scope||'person';
 if(crossContext?.scope==='private'||isPrivateSubject(joined+' '+summary+' '+topic))scope='private';
 else if(crossContext?.scope==='conversation')scope='conversation';
 else if(crossContext?.scope==='public'){
  if(!source.filter(m=>!m.isSelf).some(m=>publicConsent(String(m.plain||m.text))))throw Error('公开范围需要本人明确许可');scope='public';
 }else if(crossContext?.scope==='person'&&(!old||old.scope==='person'))scope='person';
 const row={id:entry.id,category,target,sourceKey:old?.sourceKey||key,topic,summary,scope,status:entry.status||'open',paused:discussionPaused(entry,target),updatedAt:now,owner:entry.owner,dueAt:entry.dueAt,followUpCount:entry.followUpCount,lastFollowUpAt:entry.lastFollowUpAt};
 store.threads=store.threads.filter(r=>r.id!==row.id);store.threads.push(row);store.threads=store.threads.slice(-240);return store;
}
export function personThreadProjection(raw,{key,target,messages=[],allowed=()=>true,originExists=()=>true,reason='',now=Date.now(),limit=3}={}){
 if(!validKey(key)||!id(target)||key.startsWith('private:')&&key.split(':')[1]!==String(target))return {rows:[],ambiguous:false};
 // Current utterance, not an arbitrary retrieval query, authorizes private-to-group continuation.
 const last=[...messages].reverse().find(m=>!m.isSelf&&String(m.userId)===String(target));
 if(!last||last.addressedToOther||last.quoted||last.historyOnly||key.startsWith('group:')&&!last.directToAi&&!last.quoteTargetIsSelf)return {rows:[],ambiguous:false};
 let current=String(last.plain||last.text||'');
 // A short follow-up may inherit a topic the same person explicitly resumed seconds ago.
 if(/^(?:那|这个|这点|为什么|怎么|但是|但我|可我|所以|然后|嗯|对呀|对啊|不对)/.test(current)&&current.length<50){
  const prior=messages.slice(0,messages.indexOf(last)).filter(m=>!m.isSelf).at(-1);
  if(prior&&String(prior.userId)===String(target)&&!prior.addressedToOther&&!prior.historyOnly&&!prior.quoted&&(!key.startsWith('group:')||prior.directToAi||prior.quoteTargetIsSelf)&&Number(last.time)>=Number(prior.time)&&Number(last.time)-Number(prior.time)<=120000)current=String(prior.plain||prior.text||'')+' '+current;
 }
 const directResume=resume(current);
 const candidates=normalizePersonContinuity(raw).threads.filter(r=>r.target===String(target)&&(r.sourceKey!==key||(r.paused||['completed','cancelled'].includes(r.status))&&statusQuery(current))&&allowed(r.sourceKey)&&originExists(r)&&r.updatedAt<=now)
 .filter(r=>key.startsWith('private:')?r.scope!=='conversation':!['private','conversation'].includes(r.scope));
 const relevant=candidates.filter(r=>current.toLowerCase().includes(r.topic.toLowerCase()))
 .filter(r=>!key.startsWith('group:')||r.scope==='public'||directResume)
 .filter(r=>!r.paused&&!['completed','cancelled'].includes(r.status)||statusQuery(current)||/重新聊|再聊聊/.test(current))
 .filter(r=>reason!=='proactiveCheck'||!['completed','cancelled'].includes(r.status)&&!r.paused&&r.scope==='public');
 const ambiguous=vague(current)&&!relevant.length&&candidates.length>1;
 const rows=relevant.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit).map(r=>Object.fromEntries(['id','category','topic','summary','status','paused','owner','dueAt','followUpCount'].map(k=>[k,r[k]])));
 return {rows,ambiguous};
}
export function personThreadHint(raw,options){
 const {rows,ambiguous}=personThreadProjection(raw,options);
 if(!rows.length)return ambiguous?'【接续指代不明确】对方只说继续那个话题，没有确定指哪个。问一句指哪个，不猜旧私聊内容，也不列举私密话题。':'';
 return '【与当前这个人的跨场景进展】这里只给已允许接续的相关摘要；同一 userId 换场景也不重新认识。顺着当前话继续，不背档案、不重新从头介绍。已完成/取消不重开，搁置的讨论只在本人主动恢复时接；不把记录当新消息。当前令牌可用 qq_memory_update(id) 更正下列同一记录，仍须附本轮本人已读 sourceSeqs；无新进展不重复保存。\n'+rows.map(r=>JSON.stringify(r)).join('\n');
}
export const PERSON_THREAD_HINT='【跨场景讨论接续】有实际进展的共同事件或明确约定，可在既有 qq_memory_append(category="sharedEvent/commitment") 的 extra 里加 crossContext={target:本轮本人userId,topic:已读原话里的确切作品/概念,summary:简短写已聊到哪/彼此明确看法/未解问题或约定进展,scope:"person/private/public/conversation"}。sourceSeqs 仍是本会话已读依据，不记录普通闲聊。person 是一般话题，由工程按本人和当前话题筛选；私密或仅私聊须 private；public 需要本人明确允许群里讲。换场合已有同一 id 就更新而非复制。旧的仅本会话记忆不会自动公开。';
