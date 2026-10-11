// First-reply quiet-window regressions. Real bridge handlers, fixture peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run, cfg = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    proactive: { enabled: false }, sticker: { enabled: false },
    ...cfg,
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  // GET routes carry their options in the query string, not the body.
  const get = (route, query = '') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}${query}`,
      method: 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end();
  });
  const append = text => h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  const pause=async()=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/activity',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({paused:true})});assert.equal(r.status,200);};
  try { await run({ h, key, st, request, get, append, pause }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

for(const purpose of ['messages','reply'])test('console pause promptly cancels in-flight '+purpose+' without marking unread or granting sleep',()=>fixture(async({st,request,append,pause})=>{
 append('keep this unread');const count=st.unread.length,before=st.lastReadThroughSeq;
 const pending=request('wait',{purpose,timeoutMs:600000,quietMs:120000});await new Promise(r=>setTimeout(r,100));const started=Date.now();await pause();const result=await pending;
 assert.equal(result.status,403);assert.ok(Date.now()-started<1500,'paused wait should not wait the old ten-minute timeout');assert.equal(st.unread.length,count);assert.equal(st.lastReadThroughSeq,before);assert.ok(!st.preSleepWaitSatisfiedAt);
}));

test('token revocation during long wait rejects promptly and does not return captured messages',()=>fixture(async({st,request,append})=>{
 append('private fixture text');const pending=request('wait',{timeoutMs:600000});await new Promise(r=>setTimeout(r,100));st.agentToken='replacement-fixture-token';const result=await pending;assert.equal(result.status,403);assert.equal(result.data.newMessages,undefined);assert.equal(st.unread.length,1);
}));
test('continuous reads refresh participation after own invitation, refusal and topic change',()=>fixture(async({h,key,st,request,append})=>{
 append('现在休息，陪我聊会儿');let r=await request('unread');assert.equal(r.data.conversation.participation,'invite');
 h.recordSentMessagesV2(key,['你觉得这个表情怎么用？']);append('我觉得它在开玩笑时装乖');r=await request('unread');assert.equal(r.data.conversation.participation,'answer');assert.match(r.data.conversation.hint,/哪一点影响/);
 h.recordSentMessagesV2(key,['帮我举个具体例子？']);append('不想回答，你自己想');r=await request('unread');assert.equal(r.data.conversation.participation,'declined');assert.match(r.data.conversation.hint,/不催/);
 append('对了，今天猫把花盆推倒了');st.lastIncomingAt=Date.now()-1000;r=await request('wait',{purpose:'reply',timeoutMs:1200,quietMs:100});assert.equal(r.data.conversation.participation,'skipped');assert.match(r.data.conversation.hint,/先接新内容/);
}));
test('ordinary read invitations expose only actual public reading questions without scheduling new reading',()=>fixture(async({h,st,request,append})=>{
 fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify({notes:[{id:'leisure-01234567890123456789',kind:'study',title:'模拟公开课程',excerpt:'实际读过的编码片段',summary:'编码含义取决于约定',position:'更在意约定',reason:'同样的位可以有不同意义',question:'你们更习惯哪种编码例子？',coverage:'本段文字'}]}));
 const prompts=h.calls.prompts.length;append('休息一下，陪我聊聊');const r=await request('unread');assert.match(r.data.conversation.hint,/待想：你们更习惯/);assert.equal(h.calls.prompts.length,prompts);assert.equal(h.leisureOf().status().todayAttempts,0);
 h.recordSentMessagesV2('group:456',['这个例子很有意思']);append('今天吃面');const ordinary=await request('unread');assert.doesNotMatch(ordinary.data.conversation.hint,/模拟公开课程/);
}));

test('first reply does not wait out timeout when the snapshot message is already quiet', () => fixture(async ({ h, key, st, request, append }) => {
  append('a complete first message');
  st.lastIncomingAt = Date.now() - 10000; // batching and model reading already consumed the quiet window
  await h.sendWakePromptV2(key, 'question');
  const started = Date.now();
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.equal(result.status, 200);
  assert.ok(Date.now() - started < 600, `already-quiet message waited ${result.data.waitedMs}ms`);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal('preSleepWaitRemainingMs' in result.data, false, 'first reply must not be presented as an unfinished sleep countdown');
}));

test('reply waits only for the remaining quiet time after model reading', () => fixture(async ({ h, key, st, request, append }) => {
  append('complete message');
  await h.sendWakePromptV2(key, 'question');
  st.lastIncomingAt = Date.now() - 600;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 800 });
  assert.equal(result.data.quiet, true);
  assert.ok(result.data.waitedMs >= 100 && result.data.waitedMs < 600, `remaining wait was ${result.data.waitedMs}ms`);
}));

test('a message between snapshot and wait is returned without duplicate snapshot content', () => fixture(async ({ h, key, st, request, append }) => {
  append('in snapshot');
  await h.sendWakePromptV2(key, 'question');
  append('arrived while model was thinking');
  st.lastIncomingAt = Date.now() - 1000;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100, minNewMessages: 20 });
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, true);
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
  assert.equal(result.data.readThroughSeq, 2);
  assert.equal(st.unread.length, 2, 'visibility never acknowledges messages');
}));

test('each supplement restarts quiet from its actual arrival, and appears exactly once', () => fixture(async ({ st, request, append }) => {
  append('first');
  await request('unread');
  st.lastIncomingAt = Date.now();
  const timers = [setTimeout(() => append('second'), 120), setTimeout(() => append('third'), 240)];
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 300 });
    assert.equal(result.data.quiet, true);
    assert.ok(result.data.waitedMs >= 500 && result.data.waitedMs < 1200);
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [2, 3]);
    assert.equal(result.data.readThroughSeq, 3);
  } finally { timers.forEach(clearTimeout); }
}));

test('reply timeout is a hard budget and cannot grant sleep observation, even with a long requested budget', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.wake.preSleepWaitMs = 200;
  append('first');
  await request('unread');
  const timer = setTimeout(() => append('supplement near deadline'), 220);
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 300, quietMs: 600 });
    assert.equal(result.data.timeout, true);
    assert.equal(result.data.quiet, false);
    assert.equal(result.data.speakerLikelyDone, false);
    assert.ok(result.data.waitedMs >= 300 && result.data.waitedMs < 900);
    assert.equal(result.data.preSleepWaitObserved, false);
    assert.equal(result.data.preSleepWaitSatisfied, false);
    assert.equal(st.preSleepWaitObservedAt, 0);
    assert.equal(st.preSleepWaitSatisfiedAt, 0);
  } finally { clearTimeout(timer); }
}));

test('ordinary and omitted purpose keep waiting for future messages', () => fixture(async ({ st, request, append }) => {
  append('already known');
  await request('unread');
  st.lastIncomingAt = Date.now() - 10000;
  for (const purpose of [undefined, 'messages']) {
    const result = await request('wait', { purpose, timeoutMs: 600, quietMs: 100 });
    assert.ok(result.data.waitedMs >= 600);
    assert.equal(result.data.timeout, true);
    assert.equal(result.data.quiet, false);
    assert.deepEqual(result.data.newMessages, []);
  }
}));

test('reply mode rejects a session permission change during its remaining quiet window', () => fixture(async ({ h, st, request, append }) => {
  append('still fresh');
  const timer = setTimeout(() => h.setMode('chat'), 100);
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 1000, quietMs: 300 });
    assert.equal(result.status, 403);
    assert.equal(st.modelSeenSeqs.size, 0);
    assert.equal(st.preSleepWaitObservedAt, 0);
  } finally { clearTimeout(timer); }
}));

test('reply mode cannot expose historical messages when both history tools are disabled', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.tools.getRecent = false;
  append('hidden historical message');
  st.lastIncomingAt = Date.now() - 10000;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1000, quietMs: 100 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.readThroughSeq, 0);
}));

test('ordinary wait returns the unseen message between thinking and wait, without replaying already offered backlog',()=>fixture(async({st,request,append})=>{
 append('数学真有点难');await request('unread');
 append('别啊，现在是休息');st.lastIncomingAt=Date.now()-1000;
 const result=await request('wait',{timeoutMs:1200,quietMs:100});
 assert.equal(result.status,200);assert.equal(result.data.arrived,true);assert.ok(result.data.waitedMs<600);
 assert.deepEqual(result.data.newMessages.map(m=>m.seq),[2]);assert.equal(result.data.readThroughSeq,2);
 assert.equal(st.lastReadThroughSeq,0);assert.equal(st.unread.length,2);assert.match(result.data.conversation.hint,/休息|陪聊/);
 const second=await request('wait',{timeoutMs:100,quietMs:100});assert.equal(second.data.arrived,false);assert.deepEqual(second.data.newMessages,[]);
}));
test('wait refresh carries rest intent into later expressions and paged reads never expose unseen later text',()=>fixture(async({h,key,st,request,get,append})=>{
 append('现在是休息');await request('unread');await h.sendMessagesV2(key,['在呢'],[]);
 append('好耶[表情 汪汪]');st.lastIncomingAt=Date.now()-1000;
 const reaction=await request('wait',{timeoutMs:1200,quietMs:100});assert.match(reaction.data.conversation.hint,/不反复催/);assert.equal(reaction.data.conversation.focusSeq,2);
 await request('wake-config',{config:{mode:'active'},throughSeq:2});assert.equal(st.unread.length,0);
 append('这个怎么说');append('UNSEEN-FUTURE-PRIVATE-FIXTURE');
 const page=await get('unread','&afterSeq=2&limit=1');assert.equal(page.data.conversation.focusSeq,3);assert.doesNotMatch(JSON.stringify(page.data.conversation),/UNSEEN-FUTURE/);
 assert.match(page.data.conversation.hint,/不反复催/,'acknowledging messages does not erase the recent rest invitation');
}));
test('ordinary wait surfaces a pre-request gap from the enabled recent buffer when unread reading is off',()=>fixture(async({h,st,request,append})=>{
 append('offered');await request('unread');h.cfg.socialV2.tools.getUnread=false;
 append('a supplement while thinking');st.lastIncomingAt=Date.now()-1000;
 const result=await request('wait',{timeoutMs:1000,quietMs:100});assert.deepEqual(result.data.newMessages.map(m=>m.seq),[2]);assert.equal(result.data.readThroughSeq,2);
}));
test('ordinary wait cannot expose new hidden arrivals through messages or refresh hints',()=>fixture(async({h,st,request,append})=>{
 h.cfg.socialV2.tools.getUnread=false;h.cfg.socialV2.tools.getRecent=false;
 const timer=setTimeout(()=>append('HIDDEN-NEW-PRIVATE-FIXTURE'),50);
 try {const result=await request('wait',{timeoutMs:100,quietMs:100});assert.equal(result.data.arrived,false);assert.equal(result.data.readThroughSeq,0);assert.doesNotMatch(JSON.stringify(result.data),/HIDDEN-NEW/);}finally{clearTimeout(timer);}
}));
test('invalid purpose is rejected without authorizing history or observation', () => fixture(async ({ st, request, append }) => {
  append('pending message');
  for (const purpose of ['quiet', '', null, 1]) {
    const result = await request('wait', { purpose, timeoutMs: 1000, quietMs: 100 });
    assert.equal(result.status, 400);
  }
  assert.equal(st.modelSeenSeqs.size, 0);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal(st.unread.length, 1);
}));

test('each reply-wait buffer obeys its own tool switch, never the other one', () => fixture(async ({ h, st, request, get, append }) => {
  h.cfg.socialV2.context.recentLimit = 5;
  h.cfg.socialV2.context.unreadLimit = 30;
  for (let i = 1; i <= 3; i++) append(`m${i}`);
  const read = await get('unread', '&limit=30');
  assert.equal(read.data.readThroughSeq, 3);

  // getRecent off. Only getUnread may feed the reply path. A message that arrived
  // after the model's last read is exactly what this purpose exists to surface, but
  // the buffer the closed switch governs must stay out of it.
  h.cfg.socialV2.tools.getRecent = false;
  append('arrived after the last read');
  st.lastIncomingAt = Date.now() - 10000;
  const r1 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r1.data.newMessages.map((m) => m.seq), [4], 'the enabled getUnread still reports the arrival');
  assert.equal(r1.data.readThroughSeq, 4);
  assert.equal(JSON.stringify(st.unread.map((m) => m.seq)), '[1,2,3,4]', `a reply wait never consumes unread; got ${JSON.stringify(st.unread.map((m) => m.seq))}`);

  // getUnread off: the enabled getRecent still carries arrivals, and the unread
  // buffer must not be the one answering.
  h.cfg.socialV2.tools.getRecent = true;
  h.cfg.socialV2.tools.getUnread = false;
  append('while getUnread is closed');
  st.lastIncomingAt = Date.now() - 10000;
  const r2 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r2.data.newMessages.map((m) => m.seq), [5]);

  // Both switches off: nothing may be exposed or authorised, whatever is buffered.
  h.cfg.socialV2.tools.getRecent = false;
  append('while everything is closed');
  st.lastIncomingAt = Date.now() - 10000;
  const r3 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r3.data.newMessages, []);
  assert.equal(r3.data.readThroughSeq, 5, 'a message nobody was allowed to see may not advance the watermark');
}));
