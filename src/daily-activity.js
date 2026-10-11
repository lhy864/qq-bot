// Activity preferences and evidence selection. No timer, fetching or state writes.
import {practiceEvidence} from './learning-practice.js';
const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
const clip=(s,n=140)=>String(s??'').trim().slice(0,n);
const identity=n=>n.itemId||String(n.title||'').split(' · ')[0];
function local(t){const parts=Object.fromEntries(calendar.formatToParts(new Date(t)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return {day:parts.year+'-'+parts.month+'-'+parts.day,hour:Number(parts.hour)};}
export function dailyActivityWindow(now=Date.now()){
 const {day,hour}=local(now);
 const learning=hour>=9&&hour<12||hour>=14&&hour<18;
 const label=learning?'白天学习':hour>=12&&hour<14?'午间休息':hour>=18||hour<3?'晚间放松':'清晨与低活动时段';
 return {day,hour,timeZone:'Asia/Shanghai',label,preferredKind:learning?'study':hour>=12&&hour<14||hour>=18||hour<3?'reading':'',
 description:learning?'优先读计算机资料，空闲时也可换换脑子':hour>=12&&hour<14?'优先轻松阅读或聊天':hour>=18||hour<3?'优先小说与娱乐，愿意时也能继续学':'按当前作息和真实活动决定，不由钟点推断已经睡了'};
}
export function dailyActivityQuery(text=''){
 const t=String(text).trim();
 if(/小说|读书|计算机|学习|复习|看番|补番|追番|动漫|编程|Python|CS50/i.test(t))return false;
 return /(?:你|小鲸鱼|鲸鱼).{0,10}(?:在干嘛|干什么|干嘛呢|忙啥|忙什么|做什么|有什么安排|在干什么)|(?:最近|现在|今天|这会儿).{0,4}(?:在干嘛|干什么|干嘛呢|忙啥|忙什么|做什么|有什么安排)|^(?:在干嘛|干嘛呢|忙啥|忙什么)[?？!！。\s]*$/.test(t)&&!/^我(?:最近|现在|今天|这会儿)?/.test(t);
}
export function dailyActivityContextNeeded(text=''){
 return dailyActivityQuery(text)||practiceHistoryQuery(text)||/(?:你|小鲸鱼|鲸鱼).{0,10}(?:平时|一般|白天|上午|下午|晚上|今天|现在).{0,18}(?:学|读|看|做|写|练|活动|安排)|(?:白天.{0,8}晚上|上午.{0,8}下午).{0,14}(?:做|干|安排|活动)/.test(String(text));
}
export function practiceHistoryQuery(text=''){return /(?:你|小鲸鱼|鲸鱼).{0,28}(?:跑过|运行过|写过|做过|试过|动手|跑了|实际.{0,4}(?:写|做|跑|试)|(?:做|写|跑|试).{0,8}(?:代码|练习).{0,6}(?:过|了吗|了没|没))/ .test(String(text));}
export function chooseLeisureItem(candidates,{lastKind='',manual=false,now=Date.now()}={}){
 if(!candidates.length)return undefined;
 const kind=manual?'':dailyActivityWindow(now).preferredKind;
 const preferred=kind?candidates.filter(i=>i.kind===kind):candidates.filter(i=>i.kind!==lastKind);
 return [...(preferred.length?preferred:candidates)].sort((a,b)=>(Number(a.lastReadAt)||0)-(Number(b.lastReadAt)||0))[0];
}
export function activityNotes(notes,{now=Date.now()}={}){
 const window=dailyActivityWindow(now),valid=notes.filter(n=>Number(n.at)>0&&Number(n.at)<=now&&now-Number(n.at)<=7*86400000);
 const today=valid.filter(n=>local(Number(n.at)).day===window.day),preferred=today.filter(n=>n.kind===window.preferredKind);
 const recentPreferred=valid.filter(n=>n.kind===window.preferredKind&&now-Number(n.at)<=48*3600000);
 const pool=preferred.length?preferred:today.length?today:recentPreferred.length?recentPreferred:valid;
 const latest=[...pool].sort((a,b)=>Number(a.at)-Number(b.at)).at(-1);
 return latest?valid.filter(n=>identity(n)===identity(latest)).sort((a,b)=>Number(a.at)-Number(b.at)).slice(-2):[];
}
export function dailyActivityHint(notes,{now=Date.now(),phase='idle',activeTitle='',enabled=true,asksPractice=false}={}){
 const window=dailyActivityWindow(now),valid=notes.filter(n=>Number(n.at)>0&&Number(n.at)<=now&&now-Number(n.at)<=7*86400000);
 const recent=['study','reading'].map(kind=>[...valid.filter(n=>n.kind===kind)].sort((a,b)=>Number(a.at)-Number(b.at)).at(-1)).filter(Boolean)
  .map(n=>({title:clip(n.title),kind:n.kind,readAt:local(Number(n.at)).day+' '+local(Number(n.at)).hour+' 时'}));
 const attempts=notes.map(n=>practiceEvidence(n,now)).filter(Boolean);
 const proof=attempts.length?'保存的实际小练习尝试 '+attempts.length+' 次，成功 '+attempts.filter(p=>p.status==='succeeded').length+' 次；最近结果：'+JSON.stringify(attempts.slice(-2).map(p=>({title:p.title,at:p.at,status:p.status,origin:p.origin,runMode:p.runMode,program:p.program,stdout:p.stdout,expected:p.expected,error:p.error})))+'。程序由维护代码提供，每条记录仅一次程序运行，程序里的两个求和块产生两个输出；不能说自己敲过代码、改完再跑两遍或反复试出来。可以口语说试了这个例子，只说对应尝试与结果，不扩大成完成作业、自己写过工程或掌握课程。':'当前没有保存的实际代码执行记录。对方问你跑过/写过什么时，先诚实说明还没实际运行，愿意时给出想试的具体小例子；不能用“入门那会儿/我当初从1加到100”补造经历，也不把通用知识说成不会。';
 return '【自己的近况：时段倾向与实际活动分开】北京时间 '+String(window.hour).padStart(2,'0')+' 时，'+window.label+'，'+window.description+'。时段只是安排倾向，不证明已经执行。'
 +(!enabled?'后台学习与阅读已暂停。':phase!=='idle'&&activeTitle?'正在处理的真实材料：'+clip(activeTitle)+'。':'当前没有后台阅读任务进行。')
 +(recent.length?'可接续的实际笔记（日期按记录，不一律说刚才）：'+JSON.stringify(recent)+'。':'近期没有可用的实际笔记，不编刚学过、刚读过或看过。')
 +(asksPractice?'【本次亲身练习核对】'+proof:attempts.length?'已有实际小练习记录，相关时可以聊它的尝试与结果；不把读资料自动当作做练习。':'')
 +'白天一般优先学习（9–12、14–18 时），午间休息和晚间一般优先阅读娱乐；这是可调整的打算，不能说成自己每天确实如此。问近况先自然说此刻状态、实际最近做的事或接下来的打算，不把看番当默认答案。当前主要在回应对方，也可以想陪他聊；学习安排不变成送客理由。不向 QQ 复述这些系统字段。不按晚上推断脑子报废、只能娱乐或困了。代码练习以有效执行记录为准，资料阅读和追番数值不是代码或动画观看证明。自己的惯常行为也需要记录，别把资料中的配环境、练习或别人经历套成“我每次/我经常”；可以吐槽这次读资料的感受、说想怎么试。活动时长和熬到几点没记录就不编，不为凑日程改写记录。';
}
