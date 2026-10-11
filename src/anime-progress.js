// Simulation only. Episode/completion counters never acquire plot knowledge.
const integer=(value,fallback=0)=>Number.isFinite(Number(value))?Math.max(0,Math.floor(Number(value))):fallback;
export const animeDayKey=(at=Date.now())=>{const d=new Date(at);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
export function animeCatalogItems(raw){
 const items=Array.isArray(raw)?raw:[...(Array.isArray(raw?.items)?raw.items:[]),...(Array.isArray(raw?.list)?raw.list:[])];
 return [...new Map(items.filter(x=>x&&String(x.title||'').trim()).map(x=>[String(x.title),x])).values()];
}
export function animeDaySummary(state={}, {now=Date.now(),target=1}={}){
 const day=animeDayKey(now),finished=Array.isArray(state.finished)?state.finished:[];
 const completed=finished.filter(x=>!x.dropped&&Number(x.total)>0&&Number(x.watched)>=Number(x.total)
   &&(x.completedDay||animeDayKey(x.at))===day);
 const goal=Math.min(3,Math.max(1,integer(target,1)));
 return {day,target:goal,completedToday:completed.length,advancedToday:state.day===day?integer(state.advancedToday):0,goalMet:completed.length>=goal};
}
export function advanceAnimeDaily(raw={}, {now=Date.now(),target=1,catalog=[],maxWatching=2,seedCount=5}={}){
 const a=structuredClone(raw);for(const k of ['watching','queue','finished','history'])if(!Array.isArray(a[k]))a[k]=[];
 const summary=animeDaySummary(a,{now,target});if(summary.goalMet)return {changed:false,state:a,result:{ok:true,why:'今日目标已完成',...summary}};
 if(a.day!==summary.day){a.day=summary.day;a.advancedToday=0;}
 const capacity=Math.min(20,Math.max(1,integer(maxWatching,2)));
 const seed=()=>{const seen=new Set([...a.watching,...a.finished].map(x=>x.title));const queued=new Set();
  a.queue=a.queue.filter(x=>x?.title&&!seen.has(x.title)&&!queued.has(x.title)&&(queued.add(x.title),true));
  if(a.queue.length)return;
  for(const x of catalog.filter(x=>x?.title&&!seen.has(x.title)).slice(0,Math.max(1,integer(seedCount,5))))
   a.queue.push({title:x.title,total:integer(x.total,12)||12,tags:x.tags||[],recommendedBy:null,priority:30,at:now});};
 const fill=()=>{seed();a.queue.sort((x,y)=>(Number(y.priority)||0)-(Number(x.priority)||0));
  while(a.watching.length<capacity&&a.queue.length){const x=a.queue.shift();if(!x?.title||a.watching.some(w=>w.title===x.title)||a.finished.some(f=>f.title===x.title))continue;
   a.watching.push({...x,total:integer(x.total,12)||12,watched:0,startedAt:now,lastAt:0});}};
 fill();let completed=0,episodes=0;
 while(summary.completedToday+completed<summary.target&&a.watching.length){
  const current=a.watching[0],total=integer(current.total,12)||12,watched=Math.min(total,integer(current.watched));
  const added=total-watched;current.total=total;current.watched=total;current.lastAt=now;
  a.advancedToday=integer(a.advancedToday)+added;episodes+=added;completed++;
  a.finished.push({...current,dropped:false,at:now,completedDay:summary.day,simulation:true});a.watching.shift();
  a.history.push({day:summary.day,title:current.title,ep:total,episodes:added,at:now,by:'每日自动完成（模拟）'});fill();
 }
 if(!completed)return {changed:false,state:raw,result:{ok:false,why:'队列和番剧库暂无可追条目',...summary}};
 a.history=a.history.slice(-400);a.autoDay=summary.day;a.lastAutoAt=now;
 return {changed:true,state:a,result:{ok:true,completed,episodes,...animeDaySummary(a,{now,target}),why:'每日目标已推进（模拟）'}};
}
