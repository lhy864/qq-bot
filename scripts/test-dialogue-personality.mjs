import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { replyFocus, expressionContext, buildExpressionHint, classifyInteraction, selectMemePhrases, selectContextSlang, observeExpressionPreference } from '../src/persona-expression.js';

const msg = (actor,text,extra={}) => ({ userId:actor, sender:actor, text, ...extra });
test('slang definitions follow the live topic instead of global popularity',()=>{
  const pool=[{content:'极限拉扯',count:1},{content:'典中典',count:100}];
  assert.deepEqual(selectContextSlang(pool,{recentMessages:[msg('A','这波极限拉扯')]}),[pool[0]]);
  assert.equal(selectContextSlang(pool,{recentMessages:[msg('A','帮我保存文件')]}).length,0);
});
test('multi-party focus survives unrelated interjection, shifts after a reply, excludes other-directed request', () => {
  const a=msg('A','鲸鱼，帮我看看报错', {seq:1,directToAi:true}), b=msg('B','哈哈',{seq:2});
  const st={recentMessages:[a,b],unread:[a,b]};
  assert.equal(replyFocus(st),a); assert.equal(expressionContext(st),'serious');
  a.messageId='-10000';assert.match(buildExpressionHint(st),/replyToMessageId="-10000"/);
  st.recentMessages.push({isSelf:true,text:'先保存文件'});
  const c=msg('C','来聊游戏吧',{seq:3}); st.recentMessages.push(c); st.unread=[c];
  assert.equal(replyFocus(st),c); assert.equal(expressionContext(st),'casual');
  st.recentMessages.push(msg('B','帮我看看报错',{seq:4,addressedToOther:true}));
  assert.equal(replyFocus(st),c);
});
test('exam meme is casual, real study request and distress remain serious', () => {
  for(const [text,expected] of [['期末考试这波极限拉扯哈哈','casual'],['鲸鱼，我论文不会写，帮我','serious'],['我真的焦虑得撑不住了哈哈','supportive']])
    assert.equal(expressionContext({recentMessages:[msg('A',text)]}),expected);
});
test('stop preference stays with its speaker and repair hints do not force questions or memes', () => {
  const st={expressionQuietTargets:['A'],recentMessages:[msg('A','鲸鱼，别给我起外号',{directToAi:true}),msg('B','哈哈')]};
  observeExpressionPreference(st,msg('B','别开玩笑',{addressedToOther:true})); assert.deepEqual(st.expressionQuietTargets,['A']);
  assert.equal(expressionContext(st),'restrained');
  assert.match(buildExpressionHint(st),/不例行反问|先简短认清误会/);
  st.recentMessages.push({isSelf:true},msg('B','鲸鱼，这个梗你看',{directToAi:true}));
  assert.equal(expressionContext(st),'casual');
});
test('the live wake prompt refreshes personality from the active role without resetting an existing context',async()=>{
  const h=await bridgeHarness({config:{socialV2:{enabled:true},role:{maxInjectChars:20000}}});
  try{
    fs.mkdirSync(h.temp+'/roles',{recursive:true});fs.writeFileSync(h.temp+'/roles/模拟角色.md','# 模拟角色\n\n## 性格主轴：测试\n喜欢具体的理由\n\n## 工具\n其他规则');
    fs.writeFileSync(h.temp+'/state/current-role.json',JSON.stringify({role:'模拟角色',mode:'active'}));
    const st=h.getSocialV2State('group:456');h.appendSocialV2Message('group:456','A','你觉得呢','你觉得呢',false,false,'-1234',[],'9911');
    assert.match(h.buildWakePromptV2('group:456','atMention'),/【稳定性格】喜欢具体的理由/);
  }finally{await h.close();}
});
test('complaints, meme teasing and greetings do not become negative affinity; direct attack and repeated pressure do', () => {
  for(const [text,opts,expected] of [
    ['这游戏真垃圾',{},'normal'],['你也太菜了哈哈',{},'fun'],['你真垃圾哈哈',{},'rude'],
    ['你就是个废物',{},'rude'],['你就是个废物',{addressedToOther:true},'normal'],
    ['在吗，给你分享个好玩的',{},'gift'],['快点回我',{},'normal'],['快点回我',{repeatedPush:true},'push']
  ]) assert.equal(classifyInteraction(text,opts),expected,text);
});
test('meme candidates exclude recent repetition, empty reactions and serious help', () => {
  const entries=[{text:'哈哈',usage:100},{text:'典中典',usage:80},{text:'极限拉扯',usage:2},{text:'梦里什么都有',usage:1}];
  const st={recentMessages:[{isSelf:true,text:'典中典'},msg('A','这一局极限拉扯')]};
  assert.deepEqual(selectMemePhrases(entries,st,3).map(x=>x.text),['极限拉扯','梦里什么都有']);
  st.recentMessages.push(msg('A','帮我修报错')); assert.equal(selectMemePhrases(entries,st).length,0);
});
test('real relationship read refreshes elapsed-days threshold without modifying stored counters or manual tier', async()=>{
  const h=await bridgeHarness({config:{socialV2:{enabled:true,relations:{enabled:true,tiers:[{id:'friendly',label:'友好',msgs:60,days:2},{id:'normal',label:'普通',msgs:20,days:0},{id:'stranger',label:'陌生人',msgs:0,days:0}]}}}});
  try { const p=h.personOf('9911','模拟A',true); p.msgCount=81; p.firstSeenAt=Date.now()-2.1*86400000; p.lastSeenAt=Date.now(); p.autoTier='normal';
    h.relationOf('9911');const before=JSON.stringify(p); assert.equal(h.relationOf('9911').tier,'friendly'); assert.equal(JSON.stringify(p),before);
    h.cfg.socialV2.relations.manual={'9911':'normal'}; assert.equal(h.relationOf('9911').tier,'normal');
  }finally{await h.close();}
});

async function fixture(run){
  let handler;
  const h=await bridgeHarness({config:{socialV2:{enabled:true,sticker:{enabled:false}}},globals:{http:{...http,createServer(fn){
    handler=fn;const stub=new EventEmitter();stub.address=()=>({port:h.cfg.consolePort});stub.listen=(_p,_host,done)=>{done();return stub;};return stub;
  }}}});
  h.setMode('reserved2');h.setReady(true); await h.ensureSession('group:456');
  const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));h.cfg.consolePort=server.address().port;h.startConsoleServer();
  const request=async(route,body,agent)=>{const r=await fetch(`http://127.0.0.1:${h.cfg.consolePort}${route}`,{method:body?'POST':'GET',
    headers:{'x-console-token':'fixture-console-token','content-type':'application/json',...(agent?{'x-agent-call':'1','x-agent-token':agent}:{})},...(body?{body:JSON.stringify(body)}:{})});return {code:r.status,data:await r.json()};};
  const call=body=>request('/api/debug/group-rehearsal',body);
  try{await run(h,request,call);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();}
}
test('rehearsal captures normal text send, preserves real group mapping and never persists synthetic conversation',()=>fixture(async(h,request,call)=>{
  const maps={...h.state.sessions}, real=h.getSocialV2State('group:456');real.recentMessages.push(msg('real','PRIVATE-FIXTURE-OLD-CHAT'));
  assert.equal((await call({action:'start',groupId:'999'})).code,403);
  const started=await call({action:'start',groupId:'456'});assert.equal(started.code,200);const key=started.data.key,st=h.getSocialV2State(key);
  // A random synthetic number can incidentally contain the real group's digits.
  // Identity and the isolated namespace, not substring coincidence, are the boundary.
  assert.match(key,/^group:8\d{12}$/);assert.notEqual(key,'group:456');assert.equal(h.state.sessions['group:456'],maps['group:456']);
  const injection=await call({action:'messages',key,requestId:'batch-one',messages:[{actor:'A',text:'鲸鱼，帮我看报错',directToAi:true},{actor:'B',text:'哈哈'}]});
  assert.equal(injection.code,200);assert.equal(st.lastUnreadSeq,2);assert.equal(expressionContext(st),'serious');
  assert.equal((await call({action:'messages',key,requestId:'batch-one',messages:[{actor:'A',text:'重试'}]})).data.duplicate,true);
  assert.equal(st.lastUnreadSeq,2);
  assert.doesNotMatch(h.buildWakePromptV2(key,'atMention'),/PRIVATE-FIXTURE/);
  const sent=await request('/api/socialV2/send-message',{key,messages:'模拟A，先保存文件'},st.agentToken);assert.equal(sent.code,200,JSON.stringify(sent.data));
  assert.equal(h.calls.http.filter(x=>/\/send_(?:group|private)_msg$/.test(x.url)).length,0);
  assert.equal((await call({action:'results',key})).data.outputs.length,1);
  await h.sendToQQ(key,'模拟系统提示');
  assert.equal(h.calls.sent.length,0);
  assert.equal((await call({action:'results',key})).data.outputs.length,2);
  h.saveSocialV2State();const disk=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));assert.ok(!disk.conversations[key]);
  assert.ok(!JSON.parse(fs.readFileSync(h.temp+'/state/sessions.json','utf8')).sessions[key]);
  const token=st.agentToken;await call({action:'finish',key});assert.equal(h.socialV2.conversations.has(key),false);
  assert.equal((await request(`/api/socialV2/recent?key=${key}`,null,token)).code,403);
  assert.equal(h.state.sessions['group:456'],maps['group:456']);assert.equal(real.recentMessages[0].text,'PRIVATE-FIXTURE-OLD-CHAT');
  await assert.rejects(h.sendMessagesV2(key,['stale-send'],[]));assert.equal(h.calls.http.filter(x=>/\/send_group_msg$/.test(x.url)).length,0);
}));
test('synthetic session cannot read real members/history or use other chat, voice, memory, management routes',()=>fixture(async(h,request,call)=>{
  const {data:{key}}=await call({action:'start',groupId:'456'}),token=h.getSocialV2State(key).agentToken;
  for(const [route,body] of [[`/api/socialV2/recent?key=group:456`,null],['/api/status',null],['/api/groups',null],
    ['/api/socialV2/memory-append',{key,category:'person',content:'fake'}],['/api/send/group',{key,groupId:456,message:'unexpected'}],
    ['/api/socialV2/send-voice',{key,name:'fixture'}],['/api/debug/group-rehearsal',{action:'start',groupId:'456'}]])
    assert.equal((await request(route,body,token)).code,403,route);
  const prompt=await request(`/api/socialV2/prompt?key=${key}`,null,token);assert.equal(prompt.code,200);assert.equal(prompt.data.memory,'');
  assert.equal((await request('/api/socialV2/send-message',{key,messages:'unexpected',replyToMessageId:'123456'},token)).code,403);
  assert.equal((await request('/api/socialV2/send-message',{key,messages:'unexpected',atUserId:'123456'},token)).code,403);
  await call({action:'finish',key});
}));
test('continuous style rehearsal appends during one busy model turn without new prompts and remains operator-only',()=>fixture(async(h,request,call)=>{
 const maps={...h.state.sessions},{data:{key}}=await call({action:'start',groupId:'456',styleFixtures:true,continuous:true}),st=h.getSocialV2State(key);
 const first=await call({action:'messages',key,requestId:'first',messages:[{actor:'A',text:'鲸鱼，数学有点难',directToAi:true}]});assert.equal(first.code,200);
 const sid=h.state.sessions[key];h.v2TurnStartAt.set(sid,Date.now());const prompts=h.calls.prompts.length;
 const second=await call({action:'messages',key,requestId:'second',messages:[{actor:'A',text:'现在是休息',directToAi:true}]});assert.equal(second.code,200);assert.equal(h.calls.prompts.length,prompts);
 assert.equal((await request('/api/socialV2/wait',{key,purpose:'invalid',timeoutMs:100},st.agentToken)).code,400,'continuous scope reaches the real wait validator');
 assert.equal((await request('/api/debug/group-rehearsal',{action:'messages',key,requestId:'agent',messages:[{actor:'A',text:'不能注入'}]},st.agentToken)).code,403);
 const disk=JSON.parse(fs.readFileSync(h.temp+'/state/sessions.json','utf8'));assert.ok(!disk.sessions[key]);assert.equal(h.state.sessions['group:456'],maps['group:456']);
 h.v2TurnStartAt.delete(sid);await call({action:'finish',key});assert.equal(h.calls.http.filter(x=>/\/send_group_msg$/.test(x.url)).length,0);
}));
test('failed rehearsal creation rolls back only synthetic state',()=>fixture(async(h,request,call)=>{
  const maps={...h.state.sessions},count=h.socialV2.conversations.size;h.api.sessions.create=async()=>{throw Error('fixture failure');};
  assert.equal((await call({action:'start',groupId:'456'})).code,502);assert.deepEqual({...h.state.sessions},maps);
  assert.equal(h.socialV2.conversations.size,count);
}));
