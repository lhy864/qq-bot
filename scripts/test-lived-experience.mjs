import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeExperience, addAcquiredSource, reflectExperience, experienceContext, selectExperiences, publicExperiences, communicationHint, activityContext } from '../src/lived-experience.js';
import { acquireBiliObservation } from '../src/bili-observation.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const messages=[{seq:1,userId:'9911',sender:'模拟A',text:'我喜欢能承担代价的选择',time:100},{seq:2,userId:'9922',sender:'模拟B',text:'我喜欢轻松的日常',time:200}];
const context={messages,seen:new Set([1,2]),now:1000};
const reflection={kind:'interest',topic:'虚构故事',position:'更喜欢有代价的选择',reason:'冲突不是靠一句话凭空消失',sourceSeqs:[1]};
const source={type:'bili',bvid:'BV1234567890',title:'模拟公开资料',parts:[{kind:'subtitle',text:'明确承担后果',coverage:'字幕文字'}]};

test('unread, foreign and invented sources are rejected',()=>{
  assert.throws(()=>reflectExperience({},reflection,{...context,seen:new Set()}),/已读/);
  assert.throws(()=>reflectExperience({}, {...reflection,sourceSeqs:[7]},context),/已读/);
  assert.throws(()=>reflectExperience({}, {...reflection,sourceSeqs:[],sourceIds:['fake']},context),/实际取得/);
});
test('public interest requires only acquired public sources; chat and relationships cannot travel',()=>{
  assert.throws(()=>reflectExperience({}, {...reflection,visibility:'public'},context),/不能公开/);
  const acquired=addAcquiredSource({},source).journal;
  const r=reflectExperience(acquired,{...reflection,sourceSeqs:[],sourceIds:[acquired.sources[0].id],visibility:'public'},context);
  assert.equal(publicExperiences([r.journal]).records.length,1);
  assert.equal(publicExperiences([reflectExperience({},reflection,context).journal]).records.length,0);
});
test('specific feelings do not spill from A to B and expire without erasing opinions',()=>{
  assert.throws(()=>reflectExperience({}, {...reflection,kind:'feeling',feeling:'annoyed'},context),/指定对象/);
  const r=reflectExperience({}, {...reflection,kind:'feeling',target:'9911',feeling:'annoyed',hours:1},context);
  assert.equal(selectExperiences(r.journal,{text:'虚构故事',target:'9922',now:2000}).length,0);
  assert.equal(selectExperiences(r.journal,{text:'虚构故事',target:'9911',now:2000}).length,1);
  assert.equal(selectExperiences(r.journal,{text:'虚构故事',target:'9911',now:3602000}).length,0);
  assert.throws(()=>reflectExperience({}, {...reflection,kind:'relationship',target:'9922'},context),/userId/);
  assert.throws(()=>reflectExperience({}, {...reflection,kind:'relationship',target:'虚构甲'},context),/userId.*昵称/);
});
test('correction retains history; resolution closes a feeling without changing its person',()=>{
  const r=reflectExperience({},reflection,context);
  assert.throws(()=>reflectExperience(r.journal,reflection,context),/原 id/);
  const c=reflectExperience(r.journal,{...reflection,id:r.entry.id,position:'认可对方补充的铺垫'},context);
  assert.equal(c.entry.revisions[0].position,r.entry.position);
  assert.throws(()=>reflectExperience(c.journal,{...reflection,id:r.entry.id,kind:'relationship',target:'9911'},context),/不能改变/);
  const f=reflectExperience({}, {...reflection,kind:'feeling',feeling:'disappointed',target:'9911'},context);
  const healed=reflectExperience(f.journal,{...reflection,id:f.entry.id,kind:'feeling',feeling:'calm',target:'9911',resolved:true},context);
  assert.equal(selectExperiences(healed.journal,{target:'9911',now:2000}).length,0);
  assert.match(experienceContext(healed.journal,{target:'9911',text:'上回那件事后来怎么处理',now:2000}),/已经化解.*不是当前不快/);
});
test('recall surfaces prior reasons instead of only the latest generalized opinion',()=>{
  const first=reflectExperience({},reflection,context);
  const second=reflectExperience(first.journal,{...reflection,id:first.entry.id,position:'认可具体承担后果',reason:'新设定补充公开承认、归还奖励、替被冤枉者受处分'},context);
  const third=reflectExperience(second.journal,{...reflection,id:first.entry.id,position:'代价要影响后续选择',reason:'后来继续讨论形成更一般的看法'},context);
  assert.match(experienceContext(third.journal,{text:'最初为什么改判',now:2000}),/当时依据：新设定补充公开承认、归还奖励、替被冤枉者受处分/);
  assert.doesNotMatch(experienceContext(third.journal,{text:'普通新话题',now:2000}),/当时依据/);
});
test('same score with different histories produces different usable context',()=>{
  const a=reflectExperience({}, {...reflection,kind:'relationship',target:'9911',topic:'认真讨论',position:'可以直接讨论分歧'},context);
  const b=reflectExperience({}, {...reflection,kind:'relationship',target:'9922',sourceSeqs:[2],topic:'轻松日常',position:'先接轻松日常'},context);
  assert.match(experienceContext(a.journal,{target:'9911',now:2000}),/直接讨论分歧/);
  assert.match(experienceContext(b.journal,{target:'9922',now:2000}),/先接轻松日常/);
});
test('latest public correction wins regardless of conversation iteration order',()=>{
  const acquired=addAcquiredSource({},source).journal;
  const a=reflectExperience(acquired,{...reflection,sourceSeqs:[],sourceIds:[acquired.sources[0].id],visibility:'public'},context);
  const b=reflectExperience(a.journal,{...reflection,id:a.entry.id,position:'修正后的观点',sourceSeqs:[],sourceIds:[acquired.sources[0].id],visibility:'public'},{...context,now:2000});
  assert.equal(publicExperiences([b.journal,a.journal]).records[0].position,'修正后的观点');
});
test('interest improves willingness while low communication load still preserves serious help',()=>{
  const input={energy:10,interested:true};
  assert.match(communicationHint(input),/具体内容多接/);assert.equal(input.energy,10);
  assert.match(communicationHint(input),/认真求助.*不因低余力敷衍/);
});
test('late active hours and low communication load are not bedtime instructions',()=>{
  const now=new Date(2026,9,9,23,10),hint=activityContext({now,factor:1.2,sleeping:false});
  assert.match(hint,/23:10.*系数 1.2/);assert.match(hint,/正常或活跃时段/);
  assert.match(hint,/旧对话说过的困意或晚安不自动延续/);
  assert.match(hint,/后台潜水、沉睡、唤醒是消息调度/);
  assert.match(hint,/对方明确告别或去睡时可以自然道晚安/);
  const tired=hint+'\n'+communicationHint({energy:5});
  assert.match(tired,/投入程度，不是身体困意/);assert.match(tired,/认真求助.*不因低余力敷衍/);
});
test('low activity and disabled rhythm retain their distinct behavior',()=>{
  const now=new Date(2026,9,10,4,0);
  const low=activityContext({now,factor:0.05,sleeping:true});
  assert.match(low,/低活动时段.*正在回应的具体问题仍认真处理/);assert.doesNotMatch(low,/正常或活跃时段/);
  const off=activityContext({now,enabled:false,factor:0.05,sleeping:true});
  assert.match(off,/作息调节已关闭/);assert.doesNotMatch(off,/配置中的低活动|作息系数/);
});
test('bili adapter preserves separate metadata, subtitles and viewer opinions without reading video',async()=>{
  const calls=[];
  const deps={videoInfo:async()=>({bvid:source.bvid,title:source.title,cid:1,aid:2,desc:'简介'}),subtitle:async()=>{calls.push('sub');return {text:'字幕正文'};},comments:async()=>{calls.push('comments');return {list:[{text:'观众猜测'}]};},danmaku:async()=>{calls.push('dm');return {sample:['观众玩梗']};},formatBiliResult:(kind,r)=>kind+JSON.stringify(r)};
  const r=await acquireBiliObservation({url:source.bvid},deps);
  assert.equal(calls.length,3);assert.deepEqual(r.source.parts.map(p=>p.kind),['metadata','subtitle','comments','danmaku']);
  assert.match(r.source.parts[2].text,/观众猜测/);
  await assert.rejects(acquireBiliObservation({url:'https://evil.invalid/b23.tv/fake'},deps),/短链/);
  await assert.rejects(acquireBiliObservation({url:'http://127.0.0.1/private'},deps),/B 站/);
});

async function fixture(options={}) {
  let handler;
  const fakeHttp={createServer(fn){handler=fn;const server=new EventEmitter();server.address=()=>({port:31999});server.listen=(_p,_h,cb)=>{server.listening=true;cb();return server;};return server;}};
  const h=await bridgeHarness({config:{allow:{private:['9911','9922'],groups:['456']},socialV2:{affinity:{enabled:true,timeEnabled:false},patience:{enabled:true,recoverPerMinute:0.001},rhythm:{enabled:true}}},...options,globals:{...options.globals,http:fakeHttp}});
  h.setMode('reserved2');h.startConsoleServer();
  h.request=(url,body,token)=>new Promise((resolve,reject)=>{
    const req=new EventEmitter();req.method=body===undefined?'GET':'POST';req.url=url;req.headers={host:'127.0.0.1:31999','content-type':'application/json','x-console-token':'fixture-console-token'};
    if(token!==undefined){req.headers['x-agent-call']='1';req.headers['x-agent-token']=token;}
    req.pause=()=>{};let status;
    Promise.resolve(handler(req,{writeHead(c){status=c;},end(text){resolve({status,body:JSON.parse(text)});}})).catch(reject);
    if(body!==undefined)queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});
  });return h;
}
test('real bridge persists grounded experience, reloads it and recalls it without old messages',async()=>{
  const h=await fixture();let saved;
  try{
    const key='private:9911',st=h.getSocialV2State(key);st.recentMessages=messages;st.modelSeenSeqs=new Set([1,2]);
    const r=await h.request('/api/socialV2/experience',{key,...reflection},st.agentToken);assert.equal(r.status,200,JSON.stringify(r.body));
    const wrong=await h.request('/api/socialV2/experience?key=private:9922',undefined,st.agentToken);assert.equal(wrong.status,403);
    const operatorView=await h.request('/api/socialV2/memory?key='+key);assert.equal(operatorView.body.raw.experience.records.length,1);
    const modelView=await h.request('/api/socialV2/memory?key='+key,undefined,st.agentToken);assert.equal(modelView.body.raw.experience,undefined);
    saved=JSON.parse(fs.readFileSync(path.join(h.temp,'state/social-v2.json'),'utf8'));
  }finally{await h.close();}
  const next=await fixture({savedSocialState:saved});
  try{const st=next.getSocialV2State('private:9911');st.recentMessages=[];assert.match(next.livedContextV2('private:9911',st),/承担代价|有代价/);assert.equal(st.experience.records.length,1);}finally{await next.close();}
});
test('unified prompt keeps the person score but drops legacy score/tool and dismissive low energy',async()=>{
  const h=await fixture();
  try{
    const key='private:9911',st=h.getSocialV2State(key);h.personOf('9911','模拟A',true).aff={good:20};st.affinity.points=0;st.patience=2;st.patienceAt=Date.now();
    st.recentMessages=[{...messages[0],directToAi:true,text:'认真帮我排查崩溃'}];
    const prompt=h.buildWakePromptV2(key,'atMention');
    assert.match(prompt,/95\/100/);assert.doesNotMatch(prompt,/qq_affinity_add|让他看见进度在动|能一个字解决|每轮判断/);
    assert.match(prompt,/认真求助.*不因低余力敷衍/);
    assert.equal(fs.existsSync(path.join(h.temp,'state/anime.json')),false);
    const modelPrompt=await h.request('/api/socialV2/prompt?key='+key,undefined,st.agentToken);
    assert.equal(modelPrompt.body.affinity.points,95);assert.equal(modelPrompt.body.affinity.kind,'person');
    assert.match(modelPrompt.body.experienceHint,/事实/);
  }finally{await h.close();}
});
test('wake and qq_get_prompt both refresh configured activity without erasing old dialogue',async()=>{
  const h=await fixture({config:{allow:{private:['9911'],groups:['456']},socialV2:{rhythm:{enabled:true,hours:Array(24).fill(1.2)},patience:{enabled:true},sticker:{enabled:false}}}});
  try{
    const key='private:9911',st=h.getSocialV2State(key);
    st.patience=100;st.patienceAt=Date.now();
    st.recentMessages=[{seq:1,isSelf:true,text:'之前说困了，想睡了',time:Date.now()-60000},{seq:2,userId:'9911',text:'继续聊聊那部作品吧',directToAi:true,time:Date.now()}];
    const before=JSON.stringify(st.recentMessages);
    const wake=h.buildWakePromptV2(key,'private');
    assert.match(wake,/【此刻作息】.*作息系数 1.2.*正常或活跃时段/);
    const prompt=await h.request('/api/socialV2/prompt?key='+key,undefined,st.agentToken);
    assert.equal(prompt.status,200);assert.match(prompt.body.experienceHint,/【此刻作息】.*正常或活跃时段/);
    assert.match(prompt.body.experienceHint,/旧对话说过的困意或晚安不自动延续/);
    assert.equal(JSON.stringify(st.recentMessages),before);
  }finally{await h.close();}
});
test('repeated compliments are bounded and normal silence does not punish affinity',async()=>{
  const h=await fixture();
  try{
    const st=h.getSocialV2State('private:9911');st.recentMessages=[{...messages[0],directToAi:true}];
    for(let n=0;n<10;n++)h.affinityTouchByMessage('9911','模拟A','谢谢你很可爱',false,st);
    const p=h.personOf('9911',null,false);assert.equal(p.aff.good,1);assert.equal(p.aff.disturb||0,0);
    const before=JSON.stringify(p.aff);h.affinityNeglect('9911','模拟A','未回复');assert.equal(JSON.stringify(p.aff),before);
  }finally{await h.close();}
});
test('conversation load ignores unrelated group traffic',async()=>{
  const h=await fixture();
  try{const st=h.getSocialV2State('group:456');st.patience=40;st.patienceAt=Date.now();st.recentMessages=Array.from({length:8},(_,i)=>({...messages[0],seq:i+1,time:Date.now(),text:'别人互相聊天',directToAi:false}));
    assert.equal(h.patienceOnIncoming(st).drained,0);assert.ok(st.patience>=40);
  }finally{await h.close();}
});
test('acquisition rechecks authorization after awaiting upstream and never stores a stale result',async()=>{
  let release;const pending=new Promise(r=>{release=r;});const h=await fixture({globals:{acquireBiliObservation:async()=>pending}});
  try{
    const key='private:9911',st=h.getSocialV2State(key),token=st.agentToken;
    const call=h.request('/api/socialV2/bili-observation',{key,url:source.bvid},token);
    await new Promise(r=>setTimeout(r,10));
    assert.equal((await h.request('/api/socialV2/bili-observation',{key,url:source.bvid},token)).status,429);
    h.socialV2.paused=true;release({source,text:'模拟资料'});assert.equal((await call).status,403);assert.equal(normalizeExperience(st.experience).sources.length,0);
  }finally{release?.({source,text:'模拟资料'});await h.close();}
});
test('failed durable write restores the in-memory journal and reports failure',async()=>{
  const fakeFs={...fs,renameSync(from,to){if(String(to).endsWith('social-v2.json'))throw Error('fixture disk failure');return fs.renameSync(from,to);}};
  const h=await fixture({globals:{fs:fakeFs}});
  try{const key='private:9911',st=h.getSocialV2State(key);st.recentMessages=messages;st.modelSeenSeqs=new Set([1]);
    assert.equal((await h.request('/api/socialV2/experience',{key,...reflection},st.agentToken)).status,400);
    assert.equal(normalizeExperience(st.experience).records.length,0);
  }finally{await h.close();}
});
test('invalid references return usable seen identifiers, never unread content or another chat',async()=>{
  const h=await fixture();
  try{
    const key='private:9911',st=h.getSocialV2State(key);st.recentMessages=[...messages,{seq:9,userId:'9911',sender:'模拟A',text:'UNREAD-HIDDEN-CONTENT'}];st.modelSeenSeqs=new Set([1]);
    const r=await h.request('/api/socialV2/experience',{key,...reflection,sourceSeqs:[9]},st.agentToken);
    assert.equal(r.status,400);assert.match(r.body.error,/\"seq\":1/);assert.doesNotMatch(r.body.error,/UNREAD-HIDDEN|\"seq\":9|模拟B/);
    assert.equal(normalizeExperience(st.experience).records.length,0);
  }finally{await h.close();}
});
test('successful acquired sources can support later opinions; retired credentials cannot publish a pending result',async()=>{
  let release;const h=await fixture({globals:{acquireBiliObservation:async()=>({source,text:'仅有模拟字幕文字'})}});
  try{
    const key='private:9911',st=h.getSocialV2State(key),token=st.agentToken;
    const acquired=await h.request('/api/socialV2/bili-observation',{key,url:source.bvid},token);
    assert.equal(acquired.status,200);assert.ok(acquired.body.sourceId);assert.equal(acquired.body.source.parts,undefined);
    const r=await h.request('/api/socialV2/experience',{key,...reflection,sourceSeqs:[],sourceIds:[acquired.body.sourceId]},token);
    assert.equal(r.status,200);assert.equal(r.body.entry.evidence[0].parts[0].kind,'subtitle');
  }finally{await h.close();}
  const pending=new Promise(r=>{release=r;}), next=await fixture({globals:{acquireBiliObservation:async()=>pending}});
  try{
    const key='private:9911',st=next.getSocialV2State(key),token=st.agentToken;
    const call=next.request('/api/socialV2/bili-observation',{key,url:source.bvid},token);
    await new Promise(r=>setTimeout(r,5));st.agentToken='replacement-fixture-token';release({source,text:'仅有模拟字幕文字'});
    assert.equal((await call).status,403);assert.equal(normalizeExperience(st.experience).sources.length,0);
  }finally{release?.({source,text:'模拟'});await next.close();}
});
