import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {capturePersonContracts,upsertPersonContract,personContractView,personContractHint,validatePersonContract} from '../src/person-continuity.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const msg=(plain,time=10,userId='123')=>({plain,text:plain,userId,seq:time,time,directToAi:true});
function saved(...messages){let s={};for(const m of messages)for(const r of capturePersonContracts('private:'+m.userId,m))s=upsertPersonContract(s,r);return s;}
const view=(s,key='group:456',target='123',allowed=()=>true)=>personContractView(s,{key,target,allowed});
test('two directions of a nickname remain distinct across changed group cards',()=>{
 const s=saved(msg('以后叫我阿陆就行'),msg('以后我叫你鲸宝',11));const rows=view(s);
 assert.equal(rows.find(r=>r.kind==='peerAlias').value,'阿陆');assert.equal(rows.find(r=>r.kind==='selfAlias').value,'鲸宝');assert.deepEqual(view(s,'private:123'),rows);assert.equal(view(s,'private:789').length,0);
});
test('latest correction, rejection and private-only change do not resurrect previous public aliases',()=>{
 const s=saved(msg('以后叫我阿陆'),msg('以后叫我陆陆',11),msg('别叫我陆陆了',12));assert.equal(view(s)[0].state,'revoked');assert.doesNotMatch(personContractHint(s,{key:'group:456',target:'123'}),/阿陆/);
 const p=saved(msg('以后叫我阿陆'),msg('私聊里叫我秘密豆',11));assert.equal(view(p)[0].state,'privateOnly');assert.equal(view(p)[0].value,'');assert.equal(view(p,'private:123')[0].value,'秘密豆');
});
test('same display name never combines people and denied sources do not participate',()=>{
 const s=saved(msg('叫我阿陆'),msg('叫我小叶',11,'789'));assert.equal(view(s)[0].value,'阿陆');assert.equal(view(s,'group:456','789')[0].value,'小叶');assert.equal(view(s,'group:456','123',()=>false).length,0);
});
test('third-party quotes, examples, indirect group talk and bot output do not create agreements',()=>{
 for(const m of [msg('他说以后叫我大王'),msg('比如叫我大王'),msg('“叫我大王”'),{...msg('叫我大王'),isSelf:true},{...msg('叫我大王'),directToAi:false}])assert.equal(capturePersonContracts('group:456',m).length,0);
});
test('explicit gentle banter and accompaniment boundaries are reusable and bounded to one person',()=>{
 const s=saved(msg('别拿考试开玩笑'),msg('别赶我去学习',11));assert.equal(view(s).length,2);assert.equal(view(s,'group:456','789').length,0);
});
test('model records require read evidence, the real speaker and an explicit literal agreement',()=>{
 const m=msg('叫我阿陆');const extra={target:'123',sourceSeqs:[10],contract:{kind:'peerAlias',value:'阿陆',scope:'shared'}};assert.equal(validatePersonContract('private:123',extra,[m],new Set([10])).scope,'shared');
 assert.throws(()=>validatePersonContract('private:123',extra,[m],new Set()),/已读/);assert.throws(()=>validatePersonContract('group:456',{...extra,target:'789'},[m],new Set([10])),/本人/);assert.throws(()=>validatePersonContract('private:123',{...extra,contract:{...extra.contract,state:'revoked'}},[m],new Set([10])),/状态/);
 assert.throws(()=>validatePersonContract('private:123',{...extra,contract:{kind:'peerAlias',value:'大王'}},[msg('假如有人说叫我大王')],new Set([10])),/明确/);
 const secret=msg('私聊里叫我秘密豆');assert.equal(validatePersonContract('private:123',{...extra,contract:{kind:'peerAlias',value:'秘密豆',scope:'shared'}},[secret],new Set([10])).scope,'private');
});
async function fixture(work,options={}){const h=await bridgeHarness({config:{socialV2:{rhythm:{enabled:false}}},...options});h.setMode('reserved2');h.setReady(true);try{await work(h);}finally{await h.close();}}
test('actual bridge receipt persists contracts and a fresh process recalls them without raw private text',()=>fixture(async h=>{
 h.appendSocialV2Message('private:123','朋友','叫我阿陆','叫我阿陆',false,false,'1',[],'123');h.appendSocialV2Message('group:456','改过群名片的朋友','你认得我吗','你认得我吗',false,false,'2',[],'123',[],{directToAi:true});
 assert.match(h.livedContextV2('group:456',h.getSocialV2State('group:456')),/阿陆/);
 const state=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));
 await fixture(async fresh=>{const st=fresh.getSocialV2State('group:456');st.recentMessages=[msg('你还记得该怎么称呼我吗',20)];assert.match(fresh.personContractsHintV2('group:456',st),/阿陆/);}, {savedSocialState:state});
}));
test('same bridge isolates virtual rehearsals from live contracts in both directions',()=>fixture(async h=>{
 h.appendSocialV2Message('private:123','朋友','叫我阿陆','叫我阿陆',false,false,'1',[],'123');
 const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));
 try{h.setPresets(['qq-chat-v2','qq-chat','standard']);const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/debug/group-rehearsal',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({action:'start',groupId:'456'})});const k=(await r.json()).key;assert.ok(k);
 const st=h.getSocialV2State(k);st.recentMessages=[msg('还记得我吗')];assert.doesNotMatch(h.livedContextV2(k,st),/阿陆/);
 h.appendSocialV2Message(k,'模拟','叫我模拟豆','叫我模拟豆',false,false,'2',[],'123',[],{directToAi:true});h.saveSocialV2State();assert.doesNotMatch(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'),/模拟豆/);await h.finishGroupRehearsal(k);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));
test('HTTP contract writing checks actual read sequences and rolls back if durable saving fails',()=>fixture(async h=>{
 const st=h.getSocialV2State('private:123');st.recentMessages=[msg('我希望你认真听我说',10)];st.modelSeenSeqs.add(10);
 const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));const call=extra=>fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/memory-append',{method:'POST',headers:{'x-console-token':'fixture-console-token','x-agent-call':'1','x-agent-token':st.agentToken,'content-type':'application/json'},body:JSON.stringify({key:'private:123',category:'person',content:'明确偏好',extra})});
 try{const extra={target:'123',sourceSeqs:[10],contract:{kind:'preference',slot:'attention',value:'认真听我说'}};assert.equal((await call(extra)).status,200);assert.equal((await call({...extra,target:'789'})).status,400);
 const before=JSON.stringify(h.socialV2.personContinuity);fs.mkdirSync(h.temp+'/state/social-v2.json.tmp-block');const saved=fs.readFileSync(h.temp+'/state/social-v2.json');fs.unlinkSync(h.temp+'/state/social-v2.json');fs.mkdirSync(h.temp+'/state/social-v2.json');
 assert.equal((await call({...extra,contract:{...extra.contract,slot:'other'}})).status,400);assert.equal(JSON.stringify(h.socialV2.personContinuity),before);fs.rmdirSync(h.temp+'/state/social-v2.json');fs.writeFileSync(h.temp+'/state/social-v2.json',saved);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));

const self=(plain,time)=>({plain,text:plain,isSelf:true,time});
test('a real bot proposal and first-party quoted OK create a durable agreement, bot output alone does not',()=>{
 const proposal=self('那以后统一叫朋友B，别的都作废',1000);
 const yes={...msg('ok',2000),quoteTargetIsSelf:true,text:'[引用 小鲸鱼：那以后统一叫朋友B，别的都作废]ok'};
 assert.deepEqual(capturePersonContracts('private:123',proposal,{messages:[proposal]}),[]);
 const entries=capturePersonContracts('private:123',yes,{messages:[proposal,yes]});
 assert.equal(entries[0].value,'朋友B');assert.equal(entries[0].scope,'shared');
 const extra={target:'123',sourceSeqs:[yes.seq],contract:{kind:'peerAlias',value:'朋友B',scope:'shared'}};
 assert.equal(validatePersonContract('private:123',extra,[proposal,yes],new Set([yes.seq])).value,'朋友B');
});
test('quoted assent rejects fake proposals, unrelated speakers, stale quotes and bot suggestions in the other direction',()=>{
 const proposal=self('那以后统一叫朋友B，别的都作废',1000),yes={...msg('ok',2000),quoteTargetIsSelf:true,text:'[引用 小鲸鱼：那以后统一叫朋友B，别的都作废]ok'};
 for(const messages of [[yes],[self('别的问题',1000),yes],[{...proposal,time:1},{...yes,time:200001}],[proposal,msg('哈哈',1500,'789'),yes]]){
  assert.equal(capturePersonContracts('private:123',messages.at(-1),{messages}).length,0);
 }
 const other=self('以后叫我鲸宝',1000),agree=msg('好的',2000);
 assert.equal(capturePersonContracts('private:123',agree,{messages:[other,agree]})[0].kind,'selfAlias');
 const secret=self('以后叫我鲸宝，只在私聊叫',1000);
 assert.equal(capturePersonContracts('private:123',agree,{messages:[secret,agree]})[0].scope,'private');
});
test('actual group addressing wrapper is parsed only when addressed to the bot',()=>{
 const directed={...msg('[对 @999 说的] @小鲸鱼 以后叫我朋友B',2000),directToAi:true};
 assert.equal(capturePersonContracts('group:456',directed)[0].value,'朋友B');
 assert.equal(capturePersonContracts('group:456',{...directed,directToAi:false}).length,0);
});
test('a later explicit permission can change the scope of the already agreed alias',()=>{
 let store=saved(msg('私聊里叫我朋友B',1000));const question=self('重新定哪条，是外号本身，还是群里能不能叫',2000);
 const yes={...msg('都能叫，但你群里还没叫过',3000),quoteTargetIsSelf:true,text:'[引用 小鲸鱼：重新定哪条，是外号本身，还是群里能不能叫]都能叫，但你群里还没叫过'};
 const r=capturePersonContracts('private:123',yes,{messages:[question,yes],store})[0];
 assert.equal(r.value,'朋友B');assert.equal(r.scope,'shared');store=upsertPersonContract(store,r);assert.equal(view(store)[0].value,'朋友B');
 assert.equal(capturePersonContracts('private:123',yes,{messages:[question,yes]}).length,0);
});
test('fresh startup reconstructs a retained quoted agreement and suppresses the old nickname in all runtime and console projections',()=>fixture(async h=>{
 const key='private:123';h.appendSocialV2Message(key,'朋友','我想换个称呼','我想换个称呼',false,false,'1',[],'123');
 h.recordSentMessagesV2(key,['那以后统一叫朋友B，别的都作废']);
 h.appendSocialV2Message(key,'朋友','[引用 小鲸鱼：那以后统一叫朋友B，别的都作废]ok','ok',true,false,'2',[],'123');
 const saved=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));assert.equal(saved.personContinuity.contracts[0].value,'朋友B');
 // Reproduce a pre-upgrade file containing the real conversation but no contracts.
 saved.personContinuity.contracts=[];
 await fixture(async fresh=>{
  fresh.loadMemes().byTarget['123']=[{kind:'nickname',text:'旧外号'}];fresh.personOf('123','朋友',true);
  fresh.appendSocialV2Message('group:456','换过群名片','我外号现在叫什么','我外号现在叫什么',false,false,'3',[],'123',[],{directToAi:true});
  const st=fresh.getSocialV2State('group:456');assert.match(fresh.currentConversationV2('group:456',st,st.unread).hint,/朋友B/);
  assert.equal(fresh.memeNicknameFor('123','朋友',{key:'group:456'}),'朋友B');
  assert.doesNotMatch(fresh.memesMoodText('group:456'),/旧外号/);
  const server=fresh.startConsoleServer();await new Promise(r=>server.once('listening',r));
  try{for(const route of ['/api/socialV2/people','/api/socialV2/affinity','/api/debug/selftest']){
   const response=await fetch('http://127.0.0.1:'+server.address().port+route,{headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},...(route.endsWith('selftest')?{method:'POST',body:JSON.stringify({memes:'get'})}:{})});
   const body=await response.json();assert.equal(response.status,200);const row=body.people?.find(x=>x.qq==='123')||body.list?.find(x=>x.qq==='123')||body.nicknames?.find(x=>x.target==='123');
   assert.equal((row.nicknameInfo||row).current.text,'朋友B');
  }}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 },{savedSocialState:saved});
}));
test('actual HTTP recent-message reads authorize memory after mark-read without acknowledging unoffered new messages',()=>fixture(async h=>{
 h.cfg.socialV2.wake={preSleepWaitEnabled:false};
 const key='private:123';h.appendSocialV2Message(key,'朋友','我希望你认真听我说','我希望你认真听我说',false,false,'1',[],'123');
 const st=h.getSocialV2State(key),seq=st.lastUnreadSeq,server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));
 const headers={'x-console-token':'fixture-console-token','x-agent-call':'1','x-agent-token':st.agentToken,'content-type':'application/json'};
 const call=async(route,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  assert.equal((await call('/api/socialV2/recent?key='+key)).status,200);
  assert.equal((await call('/api/socialV2/mark-read',{key,throughSeq:seq})).status,200);assert.equal(st.modelSeenSeqs.size,0);
  h.appendSocialV2Message(key,'朋友','我希望你别催我','我希望你别催我',false,false,'2',[],'123');const next=st.lastUnreadSeq;
  const extra={target:'123',sourceSeqs:[seq],contract:{kind:'preference',slot:'attention',value:'认真听我说'}};
  assert.equal((await call('/api/socialV2/memory-append',{key,category:'person',content:'认真听我说',extra})).status,200);
  assert.equal((await call('/api/socialV2/memory-append',{key,category:'person',content:'别催我',extra:{...extra,sourceSeqs:[next],contract:{kind:'preference',value:'别催我'}}})).status,400);
  assert.equal((await call('/api/socialV2/mark-read',{key,throughSeq:next})).status,400);
  assert.equal((await call('/api/socialV2/recent?key='+key)).status,200);
  assert.equal((await call('/api/socialV2/memory-append',{key,category:'person',content:'别催我',extra:{...extra,sourceSeqs:[next],contract:{kind:'preference',value:'别催我'}}})).status,200);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));
