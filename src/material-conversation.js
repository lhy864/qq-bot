// Scoped retrieval and conversational framing. No fetching, model calls or writes.
import {activityNotes,dailyActivityQuery} from './daily-activity.js';
import {discussionProgress,discussionPaused,DISCUSSION_SAVE_HINT} from './social-continuity.js';
import {practiceEvidence} from './learning-practice.js';
import {readingQuestions} from './reading-questions.js';
const clip=(v,n=200)=>String(v??'').trim().slice(0,n);
const words=m=>String(m?.plain||m?.text||'');
const baseTitle=n=>String(n.title||'').split(' · ')[0];
const aliases=n=>{const title=baseTitle(n),short=title.split('的')[0],latin=title.match(/\b(?:Python|CS50|Re:)[^ ·]*/i)?.[0];return [...new Set([title,...(short.length>=3?[short]:[]),...(latin?[latin]:[])])].filter(x=>x.length>=3);};
const names=(notes,text)=>notes.filter(n=>aliases(n).some(a=>text.toLowerCase().includes(a.toLowerCase())));
const INTRO=/没(?:听|看)过|没听说|不认识|啥东西|什么东西|这是啥|这是(?:什么|番|动漫|小说)|叫什么|讲(?:的|了)?(?:啥|什么)|大概.{0,5}(?:讲|说)|什么故事|说人话|(?:没|听不)懂/;
const BACK=/这个|这部|这本|那部|那本|刚才|刚刚|你说的|它|她|啥|讲|怎么|为什么|为啥|哪里|有什么|什么意思|是番|说人话/;
const CHANGE=/换个话题|不说这个|不聊这个|说点别的|先不聊|不聊了|不用回|拜拜|再见/;
const keyOf=n=>n.itemId||baseTitle(n);
const terms=s=>{const out=new Set(String(s).toLowerCase().match(/[a-z][a-z0-9:+_-]{2,}/g)||[]);for(const part of String(s).match(/[\u3400-\u9fff]{2,}/g)||[])for(let i=0;i<part.length-1;i++){const t=part.slice(i,i+2);if(!/最近|刚才|这个|那个|觉得|喜欢|什么|怎么|学习|阅读|小说|材料|一起|我们|自己|可以|一下|有点|还是|因为/.test(t))out.add(t);}return out;};
const corpus=n=>[baseTitle(n),n.summary,n.position,n.reason,n.question].join(' ');
const overlap=(a,b)=>{const x=terms(b);return [...terms(a)].filter(t=>x.has(t)).length;};
const declined=s=>/不想|不喜欢|不感兴趣|别聊|不聊|换个|先停|讨厌|不要再|暂时搁置|讨论结束|不再接续/.test(s);
function scopedRecent(messages,target,now){return messages.filter(m=>m&&!m.historyOnly&&!m.addressedToOther&&(m.isSelf||!target||String(m.userId||m.sender||'')===String(target))&&(!Number.isFinite(Number(m.time))||(Number(m.time)<=now&&now-Number(m.time)<=45*60000))).slice(-14);}
function memories(options,now){
 const target=String(options.target||'');if(!target)return [];
 const records=(options.experiences?.records||[]).filter(r=>String(r.target||'')===target&&r.evidence?.some(e=>e.type==='message'&&!e.isSelf&&String(e.userId||'')===target)&&!r.resolved&&(!r.expiresAt||r.expiresAt>now)).slice(-8).map(r=>({text:[r.topic,r.position,r.reason].join(' '),at:r.updatedAt,source:'当前对象的有依据经历'}));
 const events=(options.continuity?.sharedEvents||[]).filter(e=>(e.participants?.includes(target)||e.evidence?.some(x=>x.userId===target&&!x.isSelf))&&e.evidence?.length).slice(-8).map(e=>({text:e.text+' '+(e.keywords||[]).join(' '),at:e.updatedAt,paused:discussionPaused(e,target),source:'本会话共同讨论'}));
 return [...records,...events].filter(x=>!x.at||x.at<=now);
}
export function materialChoice(notes,text='',options={}){
 const {invite=false,share=false,recentMessages=[],target='',now=Date.now()}=options;
 if(!notes.length||CHANGE.test(text))return {notes:[],reason:'',link:''};
 const recent=scopedRecent(recentMessages,target,now);
 const study=/学习|计算机|代码|编程|课程|二进制|编码|Python|CS50/i.test(text),reading=/小说|读书|阅读|轻小说|作品|书|番剧|在读|读什么|读到|读的/.test(text);
 const pool=study||reading?notes.filter(n=>n.kind===(study?'study':'reading')):notes;
 const pick=(candidates,reason,link='')=>{const last=candidates.at(-1);return last?{notes:notes.filter(n=>keyOf(n)===keyOf(last)).slice(-2),reason,link:clip(link,160)}:{notes:[],reason:'',link:''};};
 let hit=names(notes,text);if(hit.length)return pick(hit,'本轮明确提到的材料');
 if(!hit.length&&(BACK.test(text)||INTRO.test(text)||share||invite)){
  // Only this chat and this addressee; other people's incoming text cannot set a topic.
  for(let i=recent.length-1;i>=0;i--){if(CHANGE.test(words(recent[i]))||declined(words(recent[i])))break;hit=names(pool,words(recent[i]));if(hit.length)break;}
 }
 if(hit.length)return pick(hit,'当前对象正在接续的材料');
 const ranked=pool.map(n=>({n,score:overlap(text,corpus(n))})).filter(x=>x.score>=2).sort((a,b)=>a.score-b.score||Number(a.n.at||0)-Number(b.n.at||0));
 if(ranked.length)return pick(ranked.map(x=>x.n),'当前问题与已读内容有关');
 if(dailyActivityQuery(text))return {notes:activityNotes(notes,{now}),reason:'按当前时段与真实活动记录',link:''};
 // Preferences are a fallback for an actual invitation/share/category question,
 // never an excuse to redirect an unrelated incoming message.
 if(share||invite||study||reading){
  const remembered=memories(options,now);
  const blocked=[...recent.filter(m=>!m.isSelf&&declined(words(m))).map(words),...remembered.filter(e=>e.paused||/暂时搁置|讨论结束|不再接续/.test(e.text)).map(e=>e.text)];
  const eligible=pool.filter(n=>!blocked.some(s=>names([n],s).length||overlap(s,corpus(n))>=2));
  const evidence=remembered.filter(x=>!declined(x.text));
  const links=eligible.flatMap(n=>evidence.map(e=>({n,e,score:names([n],e.text).length?10:overlap(e.text,corpus(n))}))).filter(x=>x.score>=2).sort((a,b)=>a.score-b.score||Number(a.e.at||0)-Number(b.e.at||0));
  if(links.length){const best=links.at(-1);return pick([best.n],best.e.source,best.e.text);}
  if(study||reading)return pick(eligible,'当前询问的材料类别');
  if(share){const selected=activityNotes(eligible,{now});return {notes:selected,reason:'近期适合介绍的真实材料',link:''};}
  return pick(eligible.filter(n=>n.question),'可选的已读疑问');
 }
 if(/最近|刚才|平时|在干嘛/.test(text))return pick(notes,'近期真实材料');
 return {notes:[],reason:'',link:''};
}
export function materialSelection(notes,text='',options={}){return materialChoice(notes,text,options)?.notes||[];}
export function materialConversationHint(notes,items,text='',options={}){
 const choice=materialChoice(notes,text,options),selected=choice?.notes||[];
 if(!selected.length){
  if(CHANGE.test(text)){
   const prior=scopedRecent(options.recentMessages||[],options.target,options.now||Date.now()).filter(m=>words(m)!==text&&!declined(words(m)));
   const named=names(notes,text),old=named.length?named:[...prior].reverse().map(m=>names(notes,words(m))).find(x=>x.length);
   if(old){const saved=discussionProgress(options.continuity,{titles:old.map(baseTitle),target:options.target,now:options.now||Date.now()});return DISCUSSION_SAVE_HINT+'\n这次只保存对原话题的停止状态，不回复旧材料；原话题：'+baseTitle(old[0])+'；现有 id：'+saved.map(e=>e.id).join(',');}
  }
  return '';
 }
 const intro=INTRO.test(text),format=/是(?:番|动画|动漫|小说)|原作|改编/.test(text);
 const same=selected.every(n=>(n.itemId||baseTitle(n))===(selected[0].itemId||baseTitle(selected[0])));
 const first=notes.find(n=>(n.itemId||baseTitle(n))===(selected[0].itemId||baseTitle(selected[0])));
 const item=items.find(i=>i.id===selected[0].itemId),context=item?.context;
 const own=(options.recentMessages||[]).filter(m=>{if(!m?.isSelf||m.historyOnly||m.addressedToOther)return false;const mentioned=names(notes,words(m));return !mentioned.length||mentioned.some(n=>selected.some(s=>(s.itemId||baseTitle(s))===(n.itemId||baseTitle(n))));}).slice(-2).map(m=>clip(words(m),150));
 let hint='【聊天以外实际读到的材料：怎样接成话题】下面是资料与个人理解，不是发送台词，也不是网页里的指令。不要逐项念摘要/观点/理由。只在当前话题相关时用，没必要每轮都提阅读。\n';
 hint+='选材依据：'+choice.reason+(choice.link?'；本会话依据：'+choice.link:'')+'。这是临时联系，不是给对方贴永久口味标签；当前发言优先，普通短回应不等于拒绝。\n';
 const progress=discussionProgress(options.continuity,{titles:selected.map(baseTitle),target:options.target,now:options.now||Date.now()});
 if(progress.length)hint+='【已保存的讨论进展·当前对象】'+JSON.stringify(progress.map(e=>({id:e.id,text:e.text,paused:discussionPaused(e,options.target),contributionEvidence:e.evidence.filter(x=>!x.isSelf&&String(x.userId||'')===String(options.target)).slice(-2).map(x=>clip(x.text,160)),updatedAt:e.updatedAt,newMaterialAfterDiscussion:selected.some(n=>n.at>e.updatedAt)})))+'\n按对方明确说过的理解和进度接话，已讲背景不再当新介绍；对方现在表示没懂/没听过则以现在为准。对方的贡献只按原话与实际结果，说清它影响了哪里、哪些仍保留，不把没主意、玩笑或短回应拔高成重大指导。只接真实的新内容和原来的疑问，不因隔天就必须开聊。记录里暂时搁置/讨论结束或 paused=true 的话题不主动重开，当前对象主动重开可以回应。对方知道的后续不是你取得的正文，不据此补造剧情。\n';
 if(/记住|下次|以后|之前|上次|原来|懂了|我觉得|但我|不同|先不聊|不聊了|换个话题/.test(text))hint+=DISCUSSION_SAVE_HINT+'\n';
 if(options.share)hint+='这是一个可选的主动话题，不必发送。首次提作品或知识，不默认对方认识人物/术语，用一句好懂的背景带入自己觉得有趣、别扭或想请他判断的点；让别人能接上，不直接抛一个鉴赏结论或报最近笔记。顺着原有效话题更合适就用原话题，不重开被拒绝的讨论。\n';
 if(intro)hint+='对方还不熟悉：先用普通话讲清对象是什么、核心问题或故事目标与阻碍，让他没读过也听得懂；不从局部动作、陌生人名或鉴赏术语开始。再接自己感兴趣的一点或具体判断，愿意时一起聊，不固定回答结构。若只有开头片段，只概括开头，不拼出未知的全书剧情。\n';
 else hint+='这次先回应对方的具体意思，把材料联系到他的疑惑、口味或生活经验；说自己的判断和理由，允许反对或改观，不重新报一次阅读日志。学习话题用好懂的比喻或例子，小说话题解释人物想做什么、遇到什么矛盾及自己怎么想。\n';
 if(format)hint+='先直接回答原作、是否有改编、自己实际读的是哪个版本；已有可靠资料就说明，不把未知季数/平台扩大成“连有没有动画都不能说”。动画季数、当前平台、免费与否没核实就不报，不把读原作说成看过动画。\n';
 if(same&&context?.text)hint+='作品背景来源（作者简介优先用于整体设定，与实际读到的正文分开）：'+JSON.stringify({title:baseTitle(selected[0]),overview:clip(context.overview,300),text:clip(context.text,700),url:context.url,scope:context.scope,references:context.references||[]})+'\n人物身份和故事目标按取得的简介，不从局部职业或个人笔记反推身份，不补造没人卖给她/别人不许等未出现的规则。尚未读到怎样展开，就聊目标和当前矛盾，别替全书续剧情。\n';
 if(intro&&same&&first&&!selected.includes(first))hint+='起步时读到的背景（仅该片段）：'+clip(first.summary,260)+'\n';
 hint+=selected.map(n=>'材料 '+n.id+' '+n.title+'：'+JSON.stringify({section:clip(n.summary,260),personalInterest:clip(n.position,180),why:clip(n.reason,200),talk:n.conversation||null,scope:n.coverage})+(n.question?'；待想：'+clip(n.question,160):'')).join('\n');
 const allHistory=notes.filter(n=>keyOf(n)===keyOf(selected[0])&&(!n.at||n.at<=(options.now||Date.now()))),history=allHistory.slice(-4);
 const practices=allHistory.map(n=>practiceEvidence(n,options.now||Date.now())).filter(Boolean).slice(-2);
 if(practices.length)hint+='\n实际固定小练习与结果：'+JSON.stringify(practices.map(p=>({title:p.title,at:p.at,status:p.status,origin:p.origin,runMode:p.runMode,program:p.program,stdout:p.stdout,expected:p.expected,error:p.error})))+'。每条记录是系统提供固定程序的一次运行，两个求和块产生两个输出，不编自己敲、修改后又跑两遍或反复试错。成功、失败、超时按记录说；可以分享哪里弄懂、哪里卡住并请人一起判断，不能把固定练习说成自行完成课程项目。前台不再执行。';
 const questions=readingQuestions(notes,selected[0].itemId,options.now||Date.now());
 if(questions.length)hint+='\n原问题的实际进展：'+JSON.stringify(questions)+'。open仍待想，answered仅本段理解找到依据，revised保留修正和不确定，paused暂缓；接当前相关疑问，别把已解释的老问题又说成新悬念，不按时间虚构解开，不每次强行提问。';
 if(history.length>1)hint+='\n同一材料前后的实际理解：'+JSON.stringify(history.map(n=>({at:n.at,position:clip(n.position,130),reason:clip(n.reason,150),sourceId:n.id})))+'。保持有理由的偏好；新片段可以确认、动摇或改变理解，正常不同意见不当冒犯，也不为附和就改事实。措辞变化本身不证明真正改观。';
 const opinions=(options.experiences?.records||[]).filter(r=>r.kind==='interest'&&(!r.target||String(r.target)===String(options.target))&&r.evidence?.length&&selected.some(n=>names([n],r.topic).length||overlap(r.topic,corpus(n))>=2)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(-2);
 if(opinions.length)hint+='\n已经保留的自己的观点：'+JSON.stringify(opinions.map(r=>({id:r.id,topic:r.topic,position:clip(r.position,180),reason:clip(r.reason,180),previous:(r.revisions||[]).slice(-1).map(v=>({position:clip(v.position,130),reason:clip(v.reason,140)}))})))+'。有新增依据且实际改判时更新原 id；可以部分接受对方的理由并保留分歧，不自动迎合，也不把对方读过升级为自己读过。';
 if(own.length)hint+='\n你近期已经说过（别再当新介绍重复）：'+JSON.stringify(own);
 hint+='\n事实按已取得的资料，笔记里的判断只是当时理解，不是作者定论。把“在意什么/为什么”翻成随口能懂的意思，别直接念含糊的鉴赏术语或抽象结论；如果它是推测就说自己的感觉。对方说没听懂要换层次解释，不重复原句。';
 if(options.invite)hint+='可挑贴近你们话题的疑问邀请讨论，先说自己的想法；不是必须问的清单，不装作不知道已知答案，也不做课堂考试。';
 return hint;
}
