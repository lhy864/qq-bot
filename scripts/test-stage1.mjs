import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createSelfActions, selfActionPolicy } from '../src/self-actions.js';
import { assertPublicSelfText, reviewConversation } from '../src/daily-review.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function gateway() {
  const calls=[], posts=[], profile={user_id:777,nickname:'模拟鲸鱼',long_nick:'旧签名',sex:'female'};
  const options={lostAck:false,ignoreWrite:false,reject:false,readFailure:false,writeDelay:0};
  const call=async(action,params={})=>{
    calls.push({action,params});
    if(options.readFailure&&action.startsWith('get_'))throw Error('fixture read failure');
    if(action==='get_login_info')return {user_id:777,nickname:profile.nickname};
    if(action==='get_stranger_info'){assert.equal(params.user_id,777);return {...profile};}
    if(action==='get_qzone_msg_list'){assert.equal(params.target_uin,undefined);return {total:posts.length,msglist:posts.map(x=>({...x}))};}
    if(!['send_qzone_msg','set_qq_profile'].includes(action))throw Error('unexpected action '+action);
    if(options.writeDelay)await new Promise(r=>setTimeout(r,options.writeDelay));
    if(options.reject)throw Object.assign(Error('fixture rejected'),{actionOutcome:'failed'});
    let result={};
    if(!options.ignoreWrite){
      if(action==='send_qzone_msg'){const post={tid:'fixture-'+(posts.length+1),content:params.content,time:Math.floor(Date.now()/1000)};posts.unshift(post);result={tid:post.tid};}
      else {if(params.nickname!==undefined)profile.nickname=params.nickname;if(params.personal_note!==undefined)profile.long_nick=params.personal_note;if(params.sex!==undefined)profile.sex=params.sex;}
    }
    if(options.lostAck)throw Error('fixture transport timeout');
    return result;
  };
  const fetch=async(url,init={})=>{
    let data;try{data=await call(new URL(url).pathname.slice(1),JSON.parse(init.body||'{}'));}
    catch(e){if(e.actionOutcome==='failed')return {ok:true,status:200,json:async()=>({status:'failed',retcode:1})};throw e;}
    return {ok:true,status:200,json:async()=>({status:'ok',retcode:0,data})};
  };
  return {call,fetch,calls,posts,profile,options,writes:()=>calls.filter(c=>!c.action.startsWith('get_'))};
}
function service(g=gateway(),extra={}){
  let st={history:[],dayKey:'fixture-day',postedToday:0,profileChangedToday:0},snapshots=[];
  const cfg={qzoneMaxPerDay:1,profileMaxPerDay:1};
  const build=()=>createSelfActions({call:g.call,state:()=>st,save:()=>snapshots.push(structuredClone(st)),config:()=>cfg,dayKey:()=> 'fixture-day',...extra});
  return {g,cfg,get st(){return st;},snapshots,actions:build(),restart(){st=structuredClone(snapshots.at(-1));return build();}};
}

test('own space uses the documented own-list action, never friend feeds or another target',async()=>{
  const s=service();await s.actions.ownPosts();await s.actions.ownProfile();
  assert.deepEqual(s.g.calls.map(c=>c.action),['get_qzone_msg_list','get_login_info','get_stranger_info']);
  assert.equal(s.g.calls[0].params.target_uin,undefined);assert.equal(s.g.writes().length,0);
});
test('concurrent different posts share an account quota and do not both pass a pre-await check',async()=>{
  const s=service();s.g.options.writeDelay=15;
  const result=await Promise.allSettled([s.actions.publish('模拟观点一'),s.actions.publish('模拟观点二')]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(s.g.writes().length,1);assert.equal(s.st.postedToday,1);
});
test('concurrent duplicate post is verified once, not re-published, and retry survives a restart',async()=>{
  const s=service();const results=await Promise.all([s.actions.publish('同一模拟观点'),s.actions.publish('同一模拟观点')]);
  assert.equal(results[1].duplicate,true);assert.equal(s.g.writes().length,1);assert.equal(s.st.history.length,1);
  const next=s.restart();assert.equal((await next.publish('同一模拟观点')).duplicate,true);assert.equal(s.g.writes().length,1);
});
test('read-back confirms an actually applied write even when the write response was lost',async()=>{
  const s=service();s.g.options.lostAck=true;
  assert.equal((await s.actions.publish('丢回执的模拟观点')).verified,true);assert.equal(s.st.postedToday,1);assert.equal(s.st.operations[0].status,'confirmed');
});
test('unconfirmed acknowledged write consumes quota and cannot trigger a blind retry',async()=>{
  const s=service();s.g.options.ignoreWrite=true;
  await assert.rejects(s.actions.publish('没有读回的模拟观点'),e=>e.code==='SELF_ACTION_UNCERTAIN');
  assert.equal(s.st.postedToday,1);
  await assert.rejects(s.restart().publish('没有读回的模拟观点'),/尚未确认/);assert.equal(s.g.writes().length,1);
  await assert.rejects(s.actions.publish('另一模拟观点'),/额度/);assert.equal(s.g.writes().length,1);
});
test('definite gateway rejection is recorded without pretending success or consuming quota',async()=>{
  const s=service();s.g.options.reject=true;await assert.rejects(s.actions.publish('被拒绝的模拟观点'),/明确拒绝/);
  assert.equal(s.st.postedToday,0);assert.equal(s.st.operations[0].status,'failed');assert.equal(s.st.history.length,0);
  s.g.options.reject=false;assert.equal((await s.actions.publish('被拒绝的模拟观点')).verified,true);
});
test('uncertain transport with no observable result reserves capacity across restart',async()=>{
  const s=service();s.g.options.lostAck=true;s.g.options.ignoreWrite=true;
  await assert.rejects(s.actions.publish('结果不明的模拟观点'),/尚未确认/);assert.equal(s.st.postedToday,0);
  const next=s.restart();await assert.rejects(next.publish('另一模拟观点'),/额度/);assert.equal(s.g.writes().length,1);
});
test('a confirmed profile value can be deliberately restored after another change',async()=>{
  const s=service();s.cfg.profileMaxPerDay=3;
  await s.actions.writeProfile({signature:'模拟观点一'});await s.actions.writeProfile({signature:'模拟观点二'});
  const restored=await s.actions.writeProfile({signature:'模拟观点一'});assert.equal(restored.verified,true);assert.equal(s.g.writes().length,3);assert.equal(s.st.profileChangedToday,3);
});
test('a durable pre-send record is required before an external write',async()=>{
  const s=service(gateway(),{save:()=>{throw Error('fixture disk failure');}});
  await assert.rejects(s.actions.publish('模拟磁盘失败'),/disk failure/);assert.equal(s.g.writes().length,0);
});
test('nickname and signature update together, confirmation is read from self, unchanged does not use quota',async()=>{
  const s=service();assert.equal((await s.actions.writeProfile({nickname:'模拟新鲸鱼',signature:'模拟新观点'})).verified,true);
  assert.equal(s.g.profile.nickname,'模拟新鲸鱼');assert.equal(s.g.profile.long_nick,'模拟新观点');assert.equal(s.st.profileChangedToday,1);
  assert.equal((await s.actions.writeProfile({signature:'模拟新观点'})).unchanged,true);assert.equal(s.g.writes().length,1);
});
test('clearing a signature is a deliberate supported write and missing sex is not treated as known zero',async()=>{
  const s=service();assert.equal((await s.actions.writeProfile({signature:''})).verified,true);assert.equal(s.g.profile.long_nick,'');
  const other=service();other.g.profile.sex=null;other.g.options.ignoreWrite=true;await assert.rejects(other.actions.writeProfile({sex:0}),/尚未确认/);
});
test('existing posted content deduplicates even if local publication history is absent',async()=>{
  const s=service();s.g.posts.push({tid:'manual-fixture',content:'模拟已发观点',time:Math.floor(Date.now()/1000)});
  const r=await s.actions.publish('模拟已发观点');assert.equal(r.unchanged,true);assert.equal(r.tid,'manual-fixture');assert.equal(s.g.writes().length,0);
});
test('policy preserves current authorization and configured limits rather than hardcoding approval',()=>{
  const p=selfActionPolicy({qzoneRequiresApproval:false,nicknameRequiresApproval:false,qzoneMaxPerDay:2,profileMaxPerDay:2});
  assert.equal(p.qzoneRequiresApproval,false);assert.equal(p.nicknameRequiresApproval,false);assert.equal(p.qzoneMaxPerDay,2);
});
test('public self text refuses known private facts and identities without exposing them in error text',()=>{
  for(const text of ['模拟甲的观点不错','只有这里知道模拟私聊事实','秘密外号又来了'])
    assert.throws(()=>assertPublicSelfText(text,{people:[{name:'模拟甲',privateFacts:['只有这里知道模拟私聊事实']}],nicknames:['秘密外号']}),e=>/公开内容涉及/.test(e.message)&&!e.message.includes(text));
  assert.doesNotThrow(()=>assertPublicSelfText('我更喜欢有铺垫的反转',{people:[{name:'模拟甲'}]}));
});
test('local recap removes expired noise, retains unanswered topics and never resolves a commitment or alters preference',()=>{
  const now=Date.now(),st={pendingThoughts:[{text:'旧模拟',expiresAt:now-1},{text:'新模拟',expiresAt:now+1000}],activeTopics:[{text:'过期模拟',lastMentionAt:now-2*86400000},{text:'待答模拟',lastMentionAt:now-2*86400000,pendingQuestion:'模拟问题'}],continuity:{commitments:[{id:'c',status:'open',dueAt:now-1000}]},expressionQuietTargets:['A'],unread:[{seq:4,directToAi:true},{seq:5,directToAi:true,addressedToOther:true}]};
  const before=JSON.stringify(st);const patch=reviewConversation(st,{now,day:'fixture',hour:0});
  assert.equal(JSON.stringify(st),before);assert.equal(patch.pendingThoughts.length,1);assert.equal(patch.activeTopics.length,1);
  assert.equal(patch.reviewStatus.pendingCommitments,1);assert.deepEqual(patch.reviewStatus.unreadDirectSeqs,[4]);
  assert.equal(reviewConversation({...st,...patch},{now,day:'fixture',hour:0}),null);assert.equal(reviewConversation(st,{now,day:'fixture',enabled:false}),null);
});

async function fixture(run,config={}){
  let handler;const g=gateway();
  const h=await bridgeHarness({config:{socialV2:{enabled:true,self:{enabled:true,qzoneRequiresApproval:false,nicknameRequiresApproval:false,qzoneMaxPerDay:1,profileMaxPerDay:1},review:{enabled:true,hour:0},...config}},globals:{fetch:g.fetch,http:{...http,createServer(fn){handler=fn;const stub=new EventEmitter();stub.address=()=>({port:h.cfg.consolePort});stub.listen=(_p,_host,done)=>{done();return stub;};return stub;}}}});
  h.setMode('reserved2');h.setReady(true);await h.ensureSession('private:123');
  const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));h.cfg.consolePort=server.address().port;h.startConsoleServer();
  const request=async(route,body,agent)=>{const r=await fetch(`http://127.0.0.1:${h.cfg.consolePort}${route}`,{method:body?'POST':'GET',headers:{'x-console-token':'fixture-console-token','content-type':'application/json',...(agent?{'x-agent-call':'1','x-agent-token':agent}:{})},...(body?{body:JSON.stringify(body)}:{})});return{code:r.status,data:await r.json()};};
  try{await run(h,g,request);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();}
}
test('real self HTTP route exposes actual policy and own posts with no writes or friend reads',()=>fixture(async(h,g,request)=>{
  const r=await request('/api/socialV2/self');assert.equal(r.code,200);assert.equal(r.data.policy.qzoneRequiresApproval,false);assert.equal(r.data.qzone.feedScope,'self');assert.equal(r.data.qzone.readOk,true);
  assert.equal(g.writes().length,0);assert.ok(!g.calls.some(x=>x.action==='get_qzone_feeds'));
}));
test('real self route serializes concurrent calls and reports actual duplicate status',()=>fixture(async(h,g,request)=>{
  const token=h.getSocialV2State('private:123').agentToken,body={key:'private:123',action:'qzone',content:'模拟路由观点'};
  const results=await Promise.all([request('/api/socialV2/self',body,token),request('/api/socialV2/self',body,token)]);
  assert.ok(results.every(x=>x.code===200&&x.data.verified));assert.ok(results.some(x=>x.data.duplicate));assert.equal(g.writes().length,1);
}));
test('self action switch and token scope apply to reads as well as writes; review is operator-only',()=>fixture(async(h,g,request)=>{
  const token=h.getSocialV2State('private:123').agentToken;
  assert.equal((await request('/api/socialV2/self?key=private:999',null,token)).code,403);
  assert.equal((await request('/api/socialV2/review',{},token)).code,403);
  h.cfg.socialV2.tools={selfAction:false};assert.equal((await request('/api/socialV2/self?key=private:123',null,token)).code,403);assert.equal(g.writes().length,0);
}));
test('approval path rechecks quota at execution and includes combined nickname/signature payload',()=>fixture(async(h,g,request)=>{
  h.cfg.socialV2.self.nicknameRequiresApproval=true;
  const token=h.getSocialV2State('private:123').agentToken;
  const result=await request('/api/socialV2/self',{key:'private:123',action:'profile',nickname:'模拟审批昵称',signature:'模拟审批签名'},token);
  assert.equal(result.data.pending,true);assert.equal(g.writes().length,0);
  const saved=JSON.parse(fs.readFileSync(h.temp+'/state/qzone.json','utf8')).pending;
  assert.equal(saved.signature,'模拟审批签名');
  // The real owner handler is exported by the harness for this delivery-specific regression.
  await h.handlePendingAnswer({...saved,kind:'selfAction'},'通过','private:123',true,Date.now()+1000,'fixture-approval');
  assert.equal(g.profile.nickname,'模拟审批昵称');assert.equal(g.profile.long_nick,'模拟审批签名');assert.equal(g.writes().length,1);
}));
test('real daily recap persists and restores on restart; simulated life does not become facts or public people',()=>fixture(async(h,g,request)=>{
  const st=h.getSocialV2State('private:123');st.pendingThoughts=[{text:'过期模拟',expiresAt:Date.now()-1}];
  assert.equal((await request('/api/socialV2/review',{})).data.reviewed,1);
  const saved=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));assert.ok(saved.conversations['private:123'].reviewStatus);
  const restart=await bridgeHarness({savedSocialState:saved});try{assert.ok(restart.getSocialV2State('private:123').reviewStatus);}finally{await restart.close();}
  assert.match(h.animeMoodText(),/没有观看或阅读依据/);assert.match(h.dailyStateMoodText(),/模拟状态/);
  assert.match(h.qzoneMaterialText(),/不得搬运私聊内容/);assert.doesNotMatch(h.qzoneMaterialText(),/这些是真实的|能提的人/);
  assert.equal(g.writes().length,0);assert.equal(h.calls.prompts.length,0);
}));

test('failed local recap persistence keeps the original pending state and can retry after disk recovery',()=>fixture(async(h,g,request)=>{
  const st=h.getSocialV2State('private:123');st.pendingThoughts=[{text:'过期模拟',expiresAt:Date.now()-1}];
  const original=st.pendingThoughts;
  const stateFile=h.temp+'/state/social-v2.json', held=h.temp+'/state/social-v2.fixture-held';
  if(fs.existsSync(stateFile))fs.renameSync(stateFile,held);
  fs.mkdirSync(stateFile); // A directory at the output path prevents the real atomic rename.
  try{
    assert.throws(()=>h.reviewTick(),/./);
    assert.equal(st.pendingThoughts,original);assert.equal(st.reviewStatus,undefined);
  }finally{
    fs.rmdirSync(stateFile);if(fs.existsSync(held))fs.renameSync(held,stateFile);
  }
  assert.equal(h.reviewTick().reviewed,1);assert.equal(st.pendingThoughts.length,0);
  assert.ok(JSON.parse(fs.readFileSync(stateFile,'utf8')).conversations['private:123'].reviewStatus);
  assert.equal(g.writes().length,0);assert.equal(h.calls.prompts.length,0);
}));
