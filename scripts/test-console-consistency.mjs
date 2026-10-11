import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {affinityBreakdown,nicknameSnapshot} from '../src/console-consistency.js';
import {upsertPersonContract,personContractView} from '../src/person-continuity.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const day=Math.floor(Date.now()/86400000);
test('94.24 is a rounded score rather than a ceiling; effective limits and daily reset are explicit',()=>{
 const p={aff:{manualOffset:20,normal:121.2,normalDay:day,normalToday:10,positiveDay:day,positiveToday:3}};
 const d=affinityBreakdown(p,{},50);assert.ok(Math.abs(d.value-94.24)<1e-9);assert.equal(d.rounded,94);assert.equal(d.maximum,95);assert.equal(d.saturated,false);assert.equal(d.normalRemaining,0);assert.equal(d.positiveRemaining,0);
 const fresh=affinityBreakdown(p,{},50,(day+1)*86400000);assert.equal(fresh.value,d.value);assert.equal(fresh.normalRemaining,10);assert.equal(fresh.positiveRemaining,3);
});
const contract=(value,scope='shared',at=Date.now(),kind='peerAlias',sourceKey='private:123',state='active')=>({target:'123',kind,slot:'address',value,scope,sourceKey,sourceSeq:1,at,state});

test('the existing inactivity decay is shown once and agrees with runtime and operator adjustments',()=>fixture(async(h,api)=>{
 const p=h.personOf('100002','模拟甲',true);p.aff={manualOffset:20};p.affinityAt=Date.now()-2*86400000;
 const d=affinityBreakdown(p,{},50);assert.ok(Math.abs(d.value-67)<0.001);assert.ok(Math.abs(d.decayApplied-3)<0.001);assert.equal(d.interactionValue,70);
 const people=await api('/api/socialV2/people'),rows=await api('/api/socialV2/affinity');assert.equal(people.people[0].affinity,67);assert.equal(rows.list[0].affinity,67);assert.ok(Math.abs(rows.list[0].affinityDetails.value-h.affinityCompute(p))<0.001);
 const adjusted=await api('/api/socialV2/affinity',{qq:'100002',delta:-5});assert.equal(adjusted.affinity,62);assert.ok(Math.abs(adjusted.affinityDetails.value-62)<0.001);assert.equal(adjusted.affinityDetails.decayApplied,0);
}));
test('both nickname directions are distinct, agreed and revoked names outrank the legacy nickname',()=>{
 let store=upsertPersonContract({},contract('小陆'));store=upsertPersonContract(store,contract('鲸宝','shared',Date.now()+1,'selfAlias'));
 const legacy={byTarget:{123:[{kind:'nickname',text:'旧外号'}]}};
 assert.equal(nicknameSnapshot(store,legacy,'123',{key:'group:456'}).current.text,'小陆');assert.equal(nicknameSnapshot(store,legacy,'123').self.text,'鲸宝');
 store=upsertPersonContract(store,contract('小陆','shared',Date.now()+2,'peerAlias','private:123','revoked'));
 assert.equal(nicknameSnapshot(store,legacy,'123',{key:'group:456'}).current.text,'');
 assert.equal(nicknameSnapshot(store,legacy,'789',{key:'group:456'}).current,null);
});
test('private nicknames are absent from runtime group projection, visible as scoped information to the operator',()=>{
 const store=upsertPersonContract({},contract('秘密昵称','private')),legacy={byTarget:{123:[{kind:'nickname',text:'旧外号'}]}};
 assert.equal(nicknameSnapshot(store,legacy,'123',{key:'group:456'}).current.state,'privateOnly');
 assert.equal(nicknameSnapshot(store,legacy,'123',{key:'group:456'}).current.text,'');
 assert.equal(nicknameSnapshot(store,legacy,'123').peer.scope,'private');
});
test('a later local nickname does not erase an older shared nickname in other conversations',()=>{
 let store=upsertPersonContract({},contract('小陆','shared',1));store=upsertPersonContract(store,contract('本群昵称','conversation',2,'peerAlias','group:456'));
 assert.equal(personContractView(store,{key:'group:789',target:'123'})[0].value,'小陆');assert.equal(personContractView(store,{key:'group:456',target:'123'})[0].value,'本群昵称');
});
async function fixture(work){const h=await bridgeHarness({config:{socialV2:{rhythm:{enabled:false},affinity:{timeEnabled:false},memes:{enabled:true,minUsage:3},continuity:{enabled:true}}}});h.setMode('reserved2');h.setReady(true);const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));const api=async(path,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,200,data.error);return data;};try{await work(h,api);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();}}
function receive(h,key,text='叫我小陆',userId='123'){h.appendSocialV2Message(key,'模拟甲',text,text,false,false,'fixture-'+Math.random(),[],userId,[],{directToAi:true});}
test('at saturation a real operator -5 request changes the score by five without discarding interaction counters',()=>fixture(async(h,api)=>{
 const p=h.personOf('100002','模拟甲',true);p.aff={good:400,manualOffset:20};const good=p.aff.good;
 assert.equal(h.affinityCompute(p),95);
 const r=await api('/api/socialV2/affinity',{qq:'100002',delta:-5});assert.equal(r.affinity,90);assert.equal(p.aff.good,good);
 const beyond=await api('/api/socialV2/affinity',{qq:'100002',value:100});assert.equal(beyond.affinity,95);assert.equal(beyond.adjustment.capped,true);assert.equal(beyond.affinityDetails.maximum,95);
}));
test('people, memes, score panel and real runtime projection agree; editing backup never overrides consent',()=>fixture(async(h,api)=>{
 receive(h,'private:123');h.personOf('123','模拟甲',true);
 const put=await api('/api/debug/selftest',{memes:'setNickname',qq:'123',text:'备用甲'});assert.equal(put.nicknameInfo.peer.text,'小陆');
 const people=await api('/api/socialV2/people'),aff=await api('/api/socialV2/affinity'),memes=await api('/api/debug/selftest',{memes:'get'});
 assert.equal(people.people[0].nick,'小陆');assert.deepEqual(people.people[0].nicknameInfo,aff.list[0].nicknameInfo);assert.deepEqual(people.people[0].nicknameInfo,memes.nicknames.find(r=>r.target==='123'));
 assert.equal(h.memeNicknameFor('123','模拟甲',{key:'group:456'}),'小陆');
 await api('/api/debug/selftest',{memes:'setNickname',qq:'123',text:''});assert.equal(h.loadMemes().byTarget['123'].filter(x=>x.kind==='nickname').length,0);assert.equal(h.memeNicknameFor('123','模拟甲',{key:'group:456'}),'小陆');
}));
test('reading the people page does not manufacture a private conversation or session',()=>fixture(async(h,api)=>{
 h.personOf('789','只在群里见过的人',true);const before=h.socialV2.conversations.size;
 await api('/api/socialV2/people');assert.equal(h.socialV2.conversations.size,before);assert.equal(h.socialV2.conversations.has('private:789'),false);
}));

test('history discovery is repeatable, preserves scores and never merges two people by their matching names',()=>fixture(async(h,api)=>{
 const one=h.personOf('100002','同名的人',true),two=h.personOf('100003','同名的人',true),legacy=h.personOf(null,'同名的人',true);
 one.aff={good:2,manualOffset:7};two.aff={good:1};legacy.privateFacts=['旧档案的私事'];
 const initial=[h.affinityCompute(one),h.affinityCompute(two)];
 const group=h.getSocialV2State('group:456');group.recentMessages=[{userId:'100002',sender:'同名的人',text:'谢谢',isSelf:false}];
 const first=await api('/api/socialV2/affinity',{backfill:true});assert.equal(first.scoresRecalculated,false);
 await api('/api/socialV2/affinity',{backfill:true});
 assert.deepEqual([h.affinityCompute(one),h.affinityCompute(two)],initial);assert.equal(one.privateFacts.length,0);assert.equal(two.privateFacts.length,0);assert.deepEqual(Array.from(h.personOf(null,'同名的人',false).privateFacts),['旧档案的私事']);
}));
test('empty backup is truly removed and deletion preserves other per-person meme records',()=>fixture(async(h,api)=>{
 h.loadMemes().byTarget['123']=[{kind:'phrase',text:'个人用语'},{kind:'nickname',text:'备用甲'}];
 await api('/api/debug/selftest',{memes:'remove',qq:'123'});assert.deepEqual(h.loadMemes().byTarget['123'].map(x=>x.kind),['phrase']);
}));
test('meme scan ignores private replies and persists an increased count even when no new phrase was added',()=>fixture(async(h)=>{
 const group=h.getSocialV2State('group:456'),priv=h.getSocialV2State('private:123');group.recentMessages=[...Array(3)].map(()=>({isSelf:true,text:'笑死我了'}));priv.recentMessages=[...Array(5)].map(()=>({isSelf:true,text:'秘密暗号'}));
 assert.equal(h.memeScanRecent(),1);assert.equal(h.loadMemes().global.some(r=>r.text==='秘密暗号'),false);assert.match(h.memesMoodText(null,'group:456'),/笑死我了/);assert.doesNotMatch(h.memesMoodText(null,'private:123'),/笑死我了/);
 group.recentMessages.push({isSelf:true,text:'笑死我了'});assert.equal(h.memeScanRecent(),0);const saved=JSON.parse(fs.readFileSync(h.temp+'/state/memes.json','utf8'));assert.equal(saved.global[0].usage,4);assert.deepEqual(saved.global[0].sourceKeys,['group:456']);
}));
