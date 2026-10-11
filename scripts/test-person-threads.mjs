import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {appendContinuity,updateContinuity} from '../src/social-continuity.js';
import {upsertPersonThread,personThreadProjection,personThreadHint} from '../src/person-continuity.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const message=(plain,seq=1,userId='123')=>({seq,time:Date.now(),plain,text:plain,userId,sender:'同名朋友',directToAi:true,isSelf:false});
function record(plain='败犬说到女主主动接受结果，下次接着聊',scope='person',key='private:123',category='sharedEvent',topic='败犬'){
 const m=message(plain),r=appendContinuity({},category,'已聊败犬：朋友觉得她接受结果的态度很有意思',{sourceSeqs:[1],participants:['123'],keywords:['败犬']},{messages:[m]});
 const store=upsertPersonThread({}, {key,category,entry:r.entry,crossContext:{target:'123',topic,summary:r.entry.text,scope},messages:[m],seen:new Set([1])});return {store,entry:r.entry,journal:r.journal,m};
}
const projected=(store,plain,key='group:456',target='123',extra={})=>personThreadProjection(store,{key,target,messages:[message(plain,20,target)],...extra});
test('private topic enters group only when that same person explicitly resumes it, without raw evidence',()=>{
 const {store}=record();assert.equal(projected(store,'败犬真好看').rows.length,0);
 const p=projected(store,'接着聊上次的败犬');assert.equal(p.rows.length,1);assert.match(p.rows[0].summary,/接受结果/);assert.equal(p.rows[0].evidence,undefined);assert.equal(p.rows[0].sourceKey,undefined);
});
test('group topic continues in private by identity and current topic, without unrelated recall',()=>{
 const {store}=record(undefined,'person','group:456');assert.equal(projected(store,'败犬那段我有不同看法','private:123').rows.length,1);assert.equal(projected(store,'今天天气真好','private:123').rows.length,0);
});
test('privacy in actual source overrides a model shared claim; public sharing requires actual permission',()=>{
 const {store}=record('败犬我只想在私聊讨论，别在群里说','public');assert.equal(store.threads[0].scope,'private');assert.equal(projected(store,'继续上次败犬').rows.length,0);
 assert.throws(()=>record(undefined,'public'),/许可/);assert.equal(record('败犬这个话题可以在群里聊','public').store.threads[0].scope,'public');
 assert.equal(projected(record(undefined,'conversation').store,'继续上次败犬').rows.length,0);
});
test('same names, other addressees, denied or deleted origins cannot open a projection',()=>{
 const {store}=record();assert.equal(projected(store,'继续败犬','group:456','789').rows.length,0);
 for(const extra of [{allowed:()=>false},{originExists:()=>false},{messages:[{...message('继续败犬'),addressedToOther:true}]},{messages:[{...message('继续败犬'),directToAi:false}]}])assert.equal(projected(store,'继续败犬','group:456','123',extra).rows.length,0);
});
test('writes reject unread sources, another person, indirect group talk and quoted examples',()=>{
 const {entry}=record();const params={key:'private:123',category:'sharedEvent',entry,crossContext:{target:'123',topic:'败犬',summary:'已讨论败犬'},messages:[message('败犬下次聊')],seen:new Set([1])};
 assert.throws(()=>upsertPersonThread({}, {...params,seen:new Set()}),/已读/);
 assert.throws(()=>upsertPersonThread({}, {...params,crossContext:{...params.crossContext,target:'789'}}),/本人/);
 assert.throws(()=>upsertPersonThread({}, {...params,messages:[message('他说败犬下次聊')]}),/本人/);
 assert.throws(()=>upsertPersonThread({}, {...params,key:'group:456',messages:[{...message('败犬下次聊'),directToAi:false}]}),/本人/);
});
test('vague continuation asks for the subject without listing private topics',()=>{
 const a=record(),b=record('排球那场的选择下次聊','person','private:123','sharedEvent','排球');const s={...a.store,threads:[...a.store.threads,...b.store.threads]};
 const h=personThreadHint(s,{key:'group:456',target:'123',messages:[message('继续聊刚才那个')]});assert.match(h,/指代不明确/);assert.doesNotMatch(h,/败犬|排球/);
});
test('resolved promises remain closed across scenes and are available only when status is relevant',()=>{
 const {store,entry,journal}=record('败犬推荐清单下次给你','person','private:123','commitment'),m=message('败犬推荐清单已经完成',2);
 const result=updateContinuity(journal,'commitment',entry.id,{status:'completed',sourceSeqs:[2]},{messages:[m]});
 const s=upsertPersonThread(store,{key:'group:456',category:'commitment',entry:result.entry,messages:[m],seen:new Set([2])});assert.equal(s.threads.length,1);assert.equal(projected(s,'继续聊败犬').rows.length,0);assert.equal(projected(s,'败犬推荐清单完成了吗').rows[0].status,'completed');
 assert.throws(()=>updateContinuity(result.journal,'commitment',entry.id,{status:'open',sourceSeqs:[2]},{messages:[m]}),/重新开启/);
});
async function fixture(work,options={}){const h=await bridgeHarness({config:{socialV2:{rhythm:{enabled:false}}},...options});h.setMode('reserved2');h.setReady(true);try{await work(h);}finally{await h.close();}}
function receive(h,key,plain,userId='123'){
 h.appendSocialV2Message(key,'同名朋友',plain,plain,false,false,'fixture-'+Math.random(),[],userId,[],{directToAi:true});const st=h.getSocialV2State(key),m=st.recentMessages.at(-1);st.modelSeenSeqs.add(m.seq);return m;
}
function save(h,key,plain='败犬推荐清单下次给你',category='commitment'){
 const m=receive(h,key,plain);return h.appendMemoryV2(h.getSocialV2State(key),category,'败犬推荐清单待提供',{sourceSeqs:[m.seq],participants:['123'],keywords:['败犬'],crossContext:{target:'123',topic:'败犬',summary:'败犬推荐清单待提供',scope:'person'}},key);
}
async function httpFixture(h,work){const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=async(key,route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-console-token':'fixture-console-token','x-agent-call':'1','x-agent-token':h.getSocialV2State(key).agentToken,'content-type':'application/json'},...(body?{body:JSON.stringify({key,...body})}:{})});return {status:r.status,body:await r.json()};};
 try{await work(call);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
test('actual HTTP cross-scene completion updates the same origin, labels provenance, and survives a new process',()=>fixture(async h=>{
 const e=save(h,'private:123');receive(h,'group:456','上次答应的败犬推荐清单已经完成');
 await httpFixture(h,async call=>{
  const q=await call('group:456','/api/socialV2/memory?key=group:456&category=commitment');assert.equal(q.status,200);assert.equal(q.body.raw.crossContext[0].id,e.id);
  const m=h.getSocialV2State('group:456').recentMessages.at(-1),u=await call('group:456','/api/socialV2/memory-update',{category:'commitment',id:e.id,newContent:'败犬推荐清单已提供',newExtra:{sourceSeqs:[m.seq],status:'completed'}});
  assert.equal(u.status,200);assert.equal(u.body.entry.status,'completed');assert.equal(u.body.entry.evidence,undefined);
  const original=h.getSocialV2State('private:123').continuity.commitments[0];assert.equal(original.id,e.id);assert.equal(original.status,'completed');assert.equal(original.evidence[0].sourceKey,'group:456');
  receive(h,'private:123','败犬推荐清单还没完成吗');assert.equal(h.personThreadsProjectionV2('private:123',h.getSocialV2State('private:123')).rows[0].status,'completed');
 });
 const snapshot=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));
 await fixture(async fresh=>{receive(fresh,'group:456','败犬推荐清单完成了吗');assert.equal(fresh.personThreadsProjectionV2('group:456',fresh.getSocialV2State('group:456')).rows[0].status,'completed');}, {savedSocialState:snapshot});
}));
test('retrieval query does not authorize private disclosure and another peer cannot update the record',()=>fixture(async h=>{
 const e=save(h,'private:123');receive(h,'group:456','今天吃什么','789');await httpFixture(h,async call=>{
  const q=await call('group:456','/api/socialV2/memory?key=group:456&q=败犬');assert.equal(q.body.raw.crossContext.length,0);
  const m=h.getSocialV2State('group:456').recentMessages.at(-1);assert.equal((await call('group:456','/api/socialV2/memory-update',{category:'commitment',id:e.id,newExtra:{sourceSeqs:[m.seq],status:'completed'}})).status,400);
 });
}));
test('durable failure rolls back both the local origin and global projection on append and update',()=>fixture(async h=>{
 const e=save(h,'private:123'),m=receive(h,'group:456','败犬推荐清单完成了');const before=JSON.stringify(h.socialV2.personContinuity),origin=JSON.stringify(h.getSocialV2State('private:123').continuity),file=h.temp+'/state/social-v2.json',bytes=fs.readFileSync(file);fs.unlinkSync(file);fs.mkdirSync(file);
 try{
  assert.throws(()=>h.updatePersonContinuityV2('group:456',h.getSocialV2State('group:456'),'commitment',e.id,{sourceSeqs:[m.seq],status:'completed'}));assert.equal(JSON.stringify(h.socialV2.personContinuity),before);assert.equal(JSON.stringify(h.getSocialV2State('private:123').continuity),origin);
  const p=receive(h,'private:123','败犬人物我有新看法');assert.throws(()=>h.appendMemoryV2(h.getSocialV2State('private:123'),'sharedEvent','败犬新看法',{sourceSeqs:[p.seq],crossContext:{target:'123',topic:'败犬',summary:'败犬新看法'}},'private:123'));assert.equal(JSON.stringify(h.socialV2.personContinuity),before);
 }finally{fs.rmdirSync(file);fs.writeFileSync(file,bytes);}
}));
test('deleting or clearing origin memory also disables its old projection',()=>fixture(async h=>{
 const e=save(h,'private:123');receive(h,'group:456','接着聊败犬');await httpFixture(h,async call=>{
  assert.equal(h.personThreadsProjectionV2('group:456',h.getSocialV2State('group:456')).rows.length,1);
  assert.equal((await call('private:123','/api/socialV2/memory-remove',{category:'commitment',id:e.id})).status,200);assert.equal(h.personThreadsProjectionV2('group:456',h.getSocialV2State('group:456')).rows.length,0);
 });
}));
test('continuity disable switch suppresses all cross-scene hints',()=>fixture(async h=>{save(h,'private:123');receive(h,'group:456','继续聊败犬');h.cfg.socialV2.continuity={enabled:false};assert.equal(h.personThreadsHintV2('group:456',h.getSocialV2State('group:456')),'');}));
test('short follow-ups inherit only the immediate same-person topic, while proactive wakes cannot reopen ordinary private topics',()=>{
 const {store}=record(),first=message('继续上次的败犬',19),last=message('那你怎么想',20);
 assert.equal(projected(store,last.plain,'group:456','123',{messages:[first,{...message('我有点不一样的理解',19),isSelf:true},last]}).rows.length,1);
 assert.equal(projected(store,last.plain,'group:456','123',{messages:[first,message('我在聊别的',19,'789'),last]}).rows.length,0);
 assert.equal(projected(store,'继续上次败犬','group:456','123',{reason:'proactiveCheck'}).rows.length,0);
});
test('paused discussion is remembered as paused and reopened only by an explicit new continuation',()=>{
 const {store,entry,journal}=record('败犬先不聊了，讨论暂时搁置');assert.equal(projected(store,'败犬真好看').rows.length,0);assert.equal(projected(store,'败犬昨天不聊那个你记得吧').rows[0].paused,true);
 const m=message('败犬我们重新聊，继续聊之前那个态度',2),result=updateContinuity(journal,'sharedEvent',entry.id,{text:'败犬讨论恢复，继续分析接受结果的态度',sourceSeqs:[2]},{messages:[m]});
 const s=upsertPersonThread(store,{key:'group:456',category:'sharedEvent',entry:result.entry,messages:[m],seen:new Set([2])});assert.equal(projected(s,'继续败犬').rows[0].paused,false);
});
