import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { planHistory, normalizeRecovery, eventTimeMs, recoverySendExpired } from '../src/message-recovery.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const now=Date.now(), key='private:123', selfId='987';
const event=(id,text,age=60000,extra={})=>({message_id:id,time:Math.floor((now-age)/1000),self_id:987,user_id:123,message_type:'private',message:[{type:'text',data:{text}}],...extra});
const seed=()=>({recentMessages:[{seq:1,messageId:'known',time:now-20*60000,text:'前文',isSelf:false}],unread:[],lastAiReplyAt:0,historyRecovery:{}});
const snapshot=st=>JSON.stringify({recent:st.recentMessages,unread:st.unread,recovery:st.historyRecovery,seq:st.lastUnreadSeq,read:st.lastReadThroughSeq,incoming:st.lastIncomingAt,patience:st.patience});
test('old messages keep time as context; recent unresolved private turn may wake',()=>{
  const p=planHistory(seed(),[event(1,'早',15*60000),event(2,'现在方便吗')],{key,selfId,now});
  assert.equal(p.messages.length,2);assert.equal(p.messages[0].pending,false);assert.equal(p.messages[1].pending,true);
  assert.equal(p.messages[0].at,Math.floor((now-15*60000)/1000)*1000);
});
test('closed exchange, later reply and later topic suppress recovery wake',()=>{
  for(const [events,st] of [[ [event(1,'问题好了'),event(2,'晚安')],seed() ],[ [event(1,'问个问题'),event(2,'回答',30000,{user_id:987})],seed() ],[ [event(1,'旧问题')],{...seed(),recentMessages:[...seed().recentMessages,{time:now-20000,isSelf:false,text:'换个话题'}]} ]]) {
    assert.equal(planHistory(st,events,{key,selfId,now}).messages.some(m=>m.pending),false);
  }
});
test('recovery deduplicates live, unread, saved IDs and same-batch events',()=>{
  const st={...seed(),unread:[{messageId:'unread'}],historyRecovery:{seenIds:['saved']}};
  const p=planHistory(st,[event('known','重复'),event('unread','重复'),event('saved','重复'),event('new','新'),event('new','重复')],{key,selfId,now});
  assert.equal(p.messages.length,1);assert.equal(p.messages[0].id,'new');
});
test('only group mentions can wake; ordinary chat and old mentions remain history',()=>{
  const group=(id,age,at)=>event(id,'群里讨论',age,{message_type:'group',group_id:456,message:[...(at?[{type:'at',data:{qq:987}}]:[]),{type:'text',data:{text:'你怎么看'}}]});
  assert.equal(planHistory(seed(),[group(1,20000,false)],{key:'group:456',selfId,now}).messages[0].pending,false);
  assert.equal(planHistory(seed(),[group(1,20000,true)],{key:'group:456',selfId,now}).messages[0].pending,true);
  assert.equal(planHistory(seed(),[group(1,3*60000,true)],{key:'group:456',selfId,now}).messages[0].pending,false);
});
test('wrong account is rejected, other conversations and invalid timestamps are excluded',()=>{
  assert.throws(()=>planHistory(seed(),[event(1,'串号',1000,{self_id:777})],{key,selfId,now}),/identity/);
  assert.throws(()=>planHistory({...seed(),historyRecovery:{selfId:'777'}},[],{key,selfId,now}),/identity/);
  assert.equal(planHistory(seed(),[event(1,'其他人',1000,{user_id:777}),event(2,'无时间',0,{time:0})],{key,selfId,now}).messages.length,0);
  assert.equal(eventTimeMs('bad',now),null);assert.equal(eventTimeMs(now+60000,now),null);
});
test('bounded persisted cursor and IDs survive JSON; late send cannot revive old turn',()=>{
  const r=normalizeRecovery({floorAt:now,seenIds:Array.from({length:300},(_,i)=>''+i)});assert.equal(r.seenIds.length,256);
  assert.equal(normalizeRecovery(JSON.parse(JSON.stringify(r))).floorAt,now);
  const st={lastWakeReason:'historyRecovery',historyRecovery:{replyUntilAt:now-1,wakeAt:now-1000},recentMessages:[]};
  assert.equal(recoverySendExpired(st,now),true);st.recentMessages=[{time:now,isSelf:false}];assert.equal(recoverySendExpired(st,now),false);
});
async function fixture(options={}) {
  let handler;
  const fakeHttp={createServer(fn){handler=fn;const server=new EventEmitter();server.address=()=>({port:31999});server.listen=(_p,_h,cb)=>{server.listening=true;cb();return server;};return server;}};
  const h=await bridgeHarness({config:{socialV2:{wake:{batchWindowMs:60000}}},...options,globals:{http:fakeHttp,...options.globals}});
  h.setMode('reserved2');const st=h.getSocialV2State(key);st.recentMessages=seed().recentMessages;st.bootstrapSent=true;st.patience=70;
  h.startConsoleServer();h.request=(body,token)=>new Promise((resolve,reject)=>{const req=new EventEmitter();req.url='/api/socialV2/recover';req.method='POST';req.headers={host:'127.0.0.1:31999','content-type':'application/json','x-console-token':'fixture-console-token'};req.pause=()=>{};if(token!==undefined){req.headers['x-agent-token']=token;req.headers['x-agent-call']='1';}
    Promise.resolve(handler(req,{writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}})).catch(reject);
    queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});});return h;
}
test('real bridge imports without replaying commands, drains or affinity and restores on restart',async()=>{
  const h=await fixture();let saved;
  try{const st=h.getSocialV2State(key),seq=st.lastUnreadSeq;
    const r=h.importHistoryV2(key,[event(1,'/reset',15*60000),event(2,'早',12*60000)],selfId,{checked:true});
    assert.equal(r.imported,2);assert.equal(r.pending,0);assert.equal(st.unread.length,0);assert.equal(st.patience,70);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.archived.length,0);
    assert.equal(st.lastUnreadSeq,seq+2);assert.ok(st.recentMessages.some(m=>m.recovered&&m.historyOnly&&m.time<now-10*60000));
    saved=JSON.parse(fs.readFileSync(path.join(h.temp,'state/social-v2.json'),'utf8'));
  }finally{await h.close();}
  const restored=await bridgeHarness({savedSocialState:saved});restored.setMode('reserved2');try{assert.equal(restored.importHistoryV2(key,[event(1,'/reset',15*60000)],selfId).imported,0);}finally{await restored.close();}
});
test('old history merges in time order without evicting fresh message; old seq is context-only',async()=>{
  const h=await fixture();try{const st=h.getSocialV2State(key);h.appendSocialV2Message(key,'私聊','现在的问题','现在的问题',false,false,'fresh',[],123);
    h.importHistoryV2(key,[event(1,'前面的补充',15*60000)],selfId);
    assert.equal(st.recentMessages.at(-1).messageId,'fresh');assert.equal(st.unread.length,1);assert.equal(st.unread[0].messageId,'fresh');
    assert.match(h.buildWakePromptV2(key,'private'),/不逐条补回/);
  }finally{await h.close();}
});
test('delayed realtime /reset is history; later live repeat is deduplicated',async()=>{
  const h=await fixture();try{await h.ensureSession(key);const sid=h.state.sessions[key];await h.handleIncoming('private',123,event(1,'/reset',15*60000),h.cfg);
    assert.equal(h.state.sessions[key],sid);assert.equal(h.getSocialV2State(key).unread.length,0);assert.equal(h.calls.archived.length,0);
    const count=h.getSocialV2State(key).recentMessages.length;await h.handleIncoming('private',123,event(1,'/reset',0),h.cfg);assert.equal(h.getSocialV2State(key).recentMessages.length,count);
  }finally{await h.close();}
});
test('pending recovery that aged while queued does not start model; overdue outbound is blocked',async()=>{
  const h=await fixture();try{const st=h.getSocialV2State(key);h.importHistoryV2(key,[event(1,'现在方便吗')],selfId);assert.equal(st.unread.length,1);
    st.unread[0].time=now-10*60000;await h.sendWakePromptV2(key,'historyRecovery');assert.equal(st.unread.length,0);assert.equal(h.calls.prompts.length,0);
    st.lastWakeReason='historyRecovery';st.historyRecovery={...st.historyRecovery,replyUntilAt:now-1,wakeAt:now+1};
    await assert.rejects(h.sendMessagesV2(key,['迟到的消息'],[]),/过时/);assert.equal(h.calls.sent.length,0);
  }finally{await h.close();}
});
test('actual worker uses SDK history actions; dry-run does not alter state; repeated sync is idempotent',async()=>{
  const calls=[];const h=await fixture({globals:{oneBotRequest:async(action,params)=>{calls.push({action,params});return {status:'ok',data:action==='get_login_info'?{user_id:987}:{messages:[event(1,'前文补充',15*60000)]}};}}});
  try{const st=h.getSocialV2State(key),before=snapshot(st);const preview=await h.recoverConversationV2(key,{dryRun:true});assert.equal(preview.imported,1);assert.equal(snapshot(st),before);
    assert.equal((await h.recoverConversationV2(key)).imported,1);assert.equal((await h.recoverConversationV2(key)).imported,0);assert.ok(calls.some(c=>c.action==='get_friend_msg_history'&&c.params.user_id===123));
  }finally{await h.close();}
});
test('authorization revoked during query and session replacement leave history untouched',async()=>{
  for(const mutate of [h=>{h.cfg.allow.private=[];},h=>{h.state.sessions[key]='replacement';},h=>{h.socialV2.paused=true;}]) {
    let release;const h=await fixture({globals:{oneBotRequest:async(action)=>action==='get_login_info'?{status:'ok',data:{user_id:987}}:await new Promise(r=>{release=r;})}});
    try{const before=snapshot(h.getSocialV2State(key)),work=h.recoverConversationV2(key);while(!release)await new Promise(r=>setImmediate(r));mutate(h);release({status:'ok',data:{messages:[event(1,'前文',15*60000)]}});await assert.rejects(work);assert.equal(snapshot(h.getSocialV2State(key)),before);}finally{await h.close();}
  }
});
test('failed history query retains message cursor, and concurrent calls share one flight',async()=>{
  let release;const h=await fixture({globals:{oneBotRequest:async(action)=>action==='get_login_info'?{status:'ok',data:{user_id:987}}:await new Promise(r=>{release=r;})}});
  try{const st=h.getSocialV2State(key),seq=st.lastUnreadSeq,work=h.recoverConversationV2(key);while(!release)await new Promise(r=>setImmediate(r));assert.equal((await h.recoverConversationV2(key)).busy,true);release({status:'failed'});await assert.rejects(work);assert.equal(st.lastUnreadSeq,seq);assert.equal(st.historyRecovery.error,'history-unavailable');assert.equal(h.historyRecoveryFlights.size,0);}finally{await h.close();}
});
test('admin endpoint rejects models and unapproved chats, defaults to read-only preview',async()=>{
  const h=await fixture({globals:{oneBotRequest:async(action)=>({status:'ok',data:action==='get_login_info'?{user_id:987}:{messages:[event(1,'补充',15*60000)]}})}});
  try{assert.equal((await h.request({key},h.getSocialV2State(key).agentToken)).status,403);assert.equal((await h.request({key:'private:999'})).status,403);
    const r=await h.request({key});assert.equal(r.status,200);assert.equal(r.body.dryRun,true);assert.equal(h.getSocialV2State(key).recentMessages.length,1);
  }finally{await h.close();}
});
test('persist failure rolls back messages, dedup ledger and read cursor',async()=>{
  let fail=false;const fakeFs=new Proxy(fs,{get(target,key){if(key==='renameSync')return (...args)=>{if(fail&&String(args[1]).endsWith('social-v2.json'))throw Error('disk fixture');return target.renameSync(...args);};return target[key];}});
  const h=await fixture({globals:{fs:fakeFs}});try{const st=h.getSocialV2State(key),before=snapshot(st);fail=true;assert.throws(()=>h.importHistoryV2(key,[event(1,'旧补充',15*60000)],selfId));assert.equal(snapshot(st),before);}finally{await h.close();}
});
test('fresh recovery actually wakes once with original time and permission-bound snapshot',async()=>{
  const h=await fixture();try{const st=h.getSocialV2State(key);h.importHistoryV2(key,[event(1,'你在吗')],selfId);clearTimeout(st.pendingWakeTimer);st.pendingWakeTimer=null;await h.sendWakePromptV2(key,'historyRecovery');
    assert.equal(h.calls.prompts.length,1);const text=h.calls.prompts[0].content.map(x=>x.text||'').join('\n');assert.match(text,/不是对方刚说的话/);assert.match(text,/你在吗/);assert.match(text,/recovered/);assert.equal(st.lastWakeReason,'historyRecovery');
  }finally{await h.close();}
});
test('paged sync is bounded and reports clipped coverage instead of claiming full history',async()=>{
  let pages=0;const h=await fixture({globals:{oneBotRequest:async(action,params)=>{if(action==='get_login_info')return {status:'ok',data:{user_id:987}};pages++;return {status:'ok',data:{messages:Array.from({length:50},(_,i)=>event(pages*100+i,'旧讨论',(4+pages)*60000+i*1000))}};}}});
  try{const r=await h.recoverConversationV2(key);assert.equal(pages,3);assert.equal(r.limited,true);assert.equal(r.imported,150);assert.equal(h.getSocialV2State(key).historyRecovery.limited,true);assert.equal(h.getSocialV2State(key).unread.length,0);}finally{await h.close();}
});
test('classic incoming path has a defined addressing object',async()=>{
  const h=await fixture();try{h.setMode('agent');await assert.doesNotReject(h.handleIncoming('private',123,event(1,'你好',0),h.cfg));}finally{await h.close();}
});
test('DSH deferred recovery is discarded after age-out rather than delivered hours later',async()=>{
  const h=await fixture();try{const st=h.getSocialV2State(key);h.importHistoryV2(key,[event(1,'你在吗')],selfId);clearTimeout(st.pendingWakeTimer);st.pendingWakeTimer=null;
    h.setReady(false);await h.sendWakePromptV2(key,'historyRecovery');assert.equal(h.calls.prompts.length,0);
    st.unread[0].time=now-10*60000;h.setReady(true);await h.flushQueue();assert.equal(h.calls.prompts.length,0);assert.equal(st.unread.length,0);
  }finally{await h.close();}
});
test('delayed owner command cannot change global role mode even on a new conversation',async()=>{
  const h=await fixture();try{h.socialV2.conversations.delete(key);await h.handleIncoming('private',123,event(1,'/silent',15*60000),h.cfg);
    assert.equal(h.getSocialV2State(key).unread.length,0);assert.ok(h.getSocialV2State(key).recentMessages.some(m=>m.recovered));
    assert.equal(fs.existsSync(path.join(h.temp,'state/current-role.json')),false);assert.equal(h.calls.sent.length,0);
  }finally{await h.close();}
});
test('wrong SDK history scope never advances the durable checkpoint',async()=>{
  const h=await fixture({globals:{oneBotRequest:async(action)=>({status:'ok',data:action==='get_login_info'?{user_id:987}:{messages:[event(1,'串会话',60000,{user_id:555})]}})}});
  try{await assert.rejects(h.recoverConversationV2(key));const st=h.getSocialV2State(key);assert.equal(st.historyRecovery.lastCheckedAt,0);assert.equal(st.recentMessages.length,1);assert.equal(st.lastUnreadSeq,0);}finally{await h.close();}
});
