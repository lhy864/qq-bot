import {normalizePersonContinuity,personContractView} from './person-continuity.js';

// The same score breakdown serves the runtime and the management page.
export function affinityBreakdown(person,config={},initial=50,now=Date.now()){
 const a=person?.aff||{},weights={good:Number(config.wGood)||2.5,gift:Number(config.wGift)||2,fun:Number(config.wFun)||1.5,normal:Number(config.wNormal)||0.2,spam:Number(config.wSpam)||-1.5,push:Number(config.wPush)||-2.5,rude:Number(config.wRude)||-4,neglect:Number(config.wNeglect)||-8};
 let interactionDelta=(Number(a.disturbWeighted)||0)*Number(config.wDisturb??-1);
 for(const[k,w]of Object.entries(weights))interactionDelta+=(Number(a[k])||0)*w;
 const manualOffset=Number(a.manualOffset)||0,rawDelta=interactionDelta+manualOffset,cap=Number(config.deltaCap)||45;
 const interactionValue=config.enabled===false?(Number(config.initial)||50):Math.max(0,Math.min(100,initial+Math.max(-cap,Math.min(cap,rawDelta))));
 const inactiveDays=Math.max(0,(now-(Number(person?.affinityAt)||now))/86400000),mid=Number(config.initial)||50,floor=Number(config.silenceFloor)||40;
 const value=config.enabled===false?interactionValue:inactiveDays>0.5&&interactionValue>mid?Math.max(Math.max(mid,floor),interactionValue-(Number(config.decayPerDay)||1.5)*inactiveDays):interactionValue;
 const decayApplied=interactionValue-value;
 const day=Math.floor(now/86400000),normalLimit=Number(config.normalDailyMax)||10,positiveLimit=3;
 const normalUsed=a.normalDay===day?(Number(a.normalToday)||0):0,positiveUsed=a.positiveDay===day?(Number(a.positiveToday)||0):0;
 return {value,interactionValue,decayApplied,inactiveDays,rounded:Math.round(value),initial,cap,minimum:Math.max(0,initial-cap),maximum:Math.min(100,initial+cap),rawDelta,interactionDelta,manualOffset,saturated:Math.abs(rawDelta)>=cap,
  normalUsed,normalLimit,normalRemaining:Math.max(0,normalLimit-normalUsed),positiveUsed,positiveLimit,positiveRemaining:Math.max(0,positiveLimit-positiveUsed),nextResetAt:(day+1)*86400000};
}

export function nicknameSnapshot(store,legacy,target,{key,allowed=()=>true}={}){
 const rows=normalizePersonContinuity(store).contracts.filter(r=>r.target===String(target)&&allowed(r.sourceKey)&&(!key||r.scope!=='conversation'||r.sourceKey===key)).sort((a,b)=>a.at-b.at||a.sourceSeq-b.sourceSeq);
 const peer=rows.filter(r=>r.kind==='peerAlias').at(-1),self=rows.filter(r=>r.kind==='selfAlias').at(-1);
 const backup=(legacy?.byTarget?.[target]||[]).find(r=>r.kind==='nickname'&&r.text)||null;
 const project=r=>r?{text:r.value,kind:r.kind,scope:r.scope,state:r.state,sourceKey:r.sourceKey,source:'本人约定'}:null;
 const info={target:String(target),peer:project(peer),self:project(self),backup:backup?{text:backup.text,source:backup.manual?'控制台备用':'自动外号'}:null};
 if(!key){info.current=info.peer||info.backup;return info;}
 const scoped=personContractView(store,{key,target:String(target),allowed}).find(r=>r.kind==='peerAlias');
 info.current=scoped?{text:scoped.state==='active'?scoped.value:'',state:scoped.state,source:'本人约定'}:info.backup;
 return info;
}
