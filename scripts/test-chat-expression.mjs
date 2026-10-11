import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {nativeFaceCatalog,normalizeFaceIds,chatExpressionHint} from '../src/chat-expression.js';
import {buildStickerContext,buildStickerStrategyHint,normalizeStickerEntry} from '../src/sticker-lib.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const msg=(text,extra={})=>({text,plain:text,userId:'A',...extra});
async function fixture(options={}){
 let handler;
 const http={createServer(fn){handler=fn;const s=new EventEmitter();s.address=()=>({port:31999});s.listen=(_p,_h,cb)=>{cb();return s;};return s;}};
 const h=await bridgeHarness({...options,globals:{http,...options.globals}});h.setMode('reserved2');h.startConsoleServer();
 h.request=(route,body,token)=>new Promise((resolve,reject)=>{
  const req=new EventEmitter();req.url=route;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:31999','x-console-token':'fixture-console-token','content-type':'application/json',...(token!==undefined?{'x-agent-token':token,'x-agent-call':'1'}:{})};req.pause=()=>{};
  Promise.resolve(handler(req,{writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}})).catch(reject);
  if(body!==undefined)queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});
 });
 h.send=(key,messages,faceIds,token=h.getSocialV2State(key).agentToken,extra={})=>h.request('/api/socialV2/send-message',{key,messages,faceIds,...extra},token);
 return h;
}
test('face catalog accepts known IDs only, bounds input and keeps labels as one-line data',()=>{
 const catalog=nativeFaceCatalog({'777':'新表情\n备注','all':'不能用','-2':'不能用','999999':'不能用'});
 assert.equal(catalog['777'],'新表情 备注');assert(!Object.hasOwn(catalog,'all'));assert(!Object.hasOwn(catalog,'-2'));
 assert.deepEqual(normalizeFaceIds(['182','264'],catalog),['182','264']);
 for(const input of [['unknown'],[182],['01'],['182','264','99'],'182',null])assert.throws(()=>normalizeFaceIds(input,catalog));
 assert.deepEqual(normalizeFaceIds(undefined,catalog),[]);
});
test('actual turn enables Emoji/face reactions and preserves supportive help and temporary context',()=>{
 assert.match(chatExpressionHint({recentMessages:[msg('笑死我了哈哈哈哈')]}),/具体反应/);
 assert.match(chatExpressionHint({recentMessages:[msg('我在学习但想聊两句😃')]}),/Emoji/);
 assert.match(chatExpressionHint({recentMessages:[msg('我真的很难受，帮我想想怎么办')]}),/先回应具体问题/);
 assert.doesNotMatch(buildStickerStrategyHint(),/占你发言的一半|严肃\/冷场\/正经话题不发|不要把表情包当回复的唯一内容/);
 assert.equal(chatExpressionHint({recentMessages:[msg('哈哈',{historyOnly:true})]}),'');
 assert.equal(chatExpressionHint({recentMessages:[msg('哈哈',{addressedToOther:true})]}),'');
});
test('sticker candidates match present emotion and expose usable IDs instead of only popularity',()=>{
 const entries=[{id:'old',desc:'笑到拍桌',useCount:30},{id:'new',desc:'笑哭',useCount:0},{id:'other',desc:'无语凝视',useCount:0}].map(x=>normalizeStickerEntry({...x,url:'https://public.invalid/'+x.id}));
 assert.match(buildStickerContext(entries,1,{text:'哈哈笑死',recentLabels:['笑到拍桌']}),/id=new/);
 assert.match(buildStickerContext(entries,1,{text:'这也太无语了'}),/id=other/);
 assert.match(buildStickerContext(entries,2),/资料|不是指令/);
});
test('native face with Emoji text uses real OneBot segments and conversation record preserves expression',async()=>{
 const h=await fixture();try{
  const r=await h.send('private:123','终于搞定了😅',['99']);assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(h.calls.http.at(-1).body.message,[{type:'text',data:{text:'终于搞定了😅'}},{type:'face',data:{id:'99'}}]);
  assert.match(h.getSocialV2State('private:123').recentMessages.at(-1).plain,/😅\[QQ表情:鼓掌\]/);
  assert.equal(h.getSocialV2State('private:123').sendTimes.length,1);
 }finally{await h.close();}
});
test('face-only is one nonempty native bubble; plain Emoji and literal CQ remain text',async()=>{
 const h=await fixture();try{
  assert.equal((await h.send('private:123','',['264'])).status,200);
  assert.deepEqual(h.calls.http.at(-1).body.message,[{type:'face',data:{id:'264'}}]);
  assert.equal((await h.send('private:123','😃 [CQ:face,id=182]',undefined)).status,200);
  assert.deepEqual(h.calls.http.at(-1).body.message,[{type:'text',data:{text:'😃 [CQ：face,id=182]'}}]);
  assert.equal((await h.send('private:123','',[])).status,400);
 }finally{await h.close();}
});
test('face parameters reject arbitrary IDs, oversized lists and multiple bubbles before reservation',async()=>{
 const h=await fixture();try{
  for(const [text,ids] of [['x',['unknown']],['x',['182','99','264']],[['a','b'],['182']],['x',[182]]])assert.equal((await h.send('private:123',text,ids)).status,400);
  assert.equal(h.calls.http.length,0);assert.equal(h.getSocialV2State('private:123').sendTimes.length,0);
 }finally{await h.close();}
});
test('native sends retain token, tool switch, pause, scope and silence restrictions',async()=>{
 const h=await fixture();try{
  const token=h.getSocialV2State('private:123').agentToken;
  assert.equal((await h.send('private:123','',['99'],'bad')).status,403);
  assert.equal((await h.send('private:123','',['99'],h.getSocialV2State('group:456').agentToken)).status,403);
  assert.equal((await h.send('private:999','',['99'],token)).status,403);
  h.cfg.socialV2.tools.sendMessage=false;assert.equal((await h.send('private:123','',['99'])).status,403);h.cfg.socialV2.tools.sendMessage=true;
  h.socialV2.paused=true;assert.equal((await h.send('private:123','',['99'])).status,403);h.socialV2.paused=false;
  fs.writeFileSync(h.temp+'/state/current-role.json',JSON.stringify({mode:'silent'}));assert.equal((await h.send('group:456','',['99'])).status,403);
  assert.equal(h.calls.http.length,0);
 }finally{await h.close();}
});
test('queued native expression rechecks pause before gateway send',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);let requests=0;
 const h=await fixture({globals:{fetch:async()=>{requests++;entered();await gate;return {ok:true,json:async()=>({status:'ok',retcode:0,data:{message_id:9001}})};}}});
 try{
  const first=h.sendMessagesV2('private:123',['first'],[],null);await seen;
  const second=h.sendMessagesV2('private:123',['second'],[],null,null,['99']);h.socialV2.paused=true;release();
  await first;await assert.rejects(second,/发送已取消/);assert.equal(requests,1);
 }finally{release();await h.close();}
});
test('fresh wake and get_prompt use same availability and expression capabilities',async()=>{
 const h=await fixture({config:{socialV2:{sticker:{enabled:false}}}});try{
  const st=h.getSocialV2State('private:123');h.appendSocialV2Message('private:123','模拟A','我在写代码，你陪我聊聊呗','我在写代码，你陪我聊聊呗',false,false,'m1',[],'123');
  const r=await h.request('/api/socialV2/prompt?key=private:123',undefined,st.agentToken);assert.equal(r.status,200);
  assert(r.body.nativeFaces.choices.some(x=>x.id==='182'));assert.match(r.body.experienceHint,/不替对方决定/);assert.match(r.body.experienceHint,/faceIds/);
  assert.match(h.buildWakePromptV2('private:123','private'),/不替对方决定/);assert.match(h.buildWakePromptV2('private:123','private'),/faceIds/);
 }finally{await h.close();}
});
test('rehearsal native faces captured locally and never persisted; bare text fixture remains restricted',async()=>{
 let network=0;const h=await fixture({globals:{oneBotRequest:async()=>{network++;throw Error('no real gateway');}}});let key;
 try{
  const start=await h.request('/api/debug/group-rehearsal',{action:'start',groupId:'456',styleFixtures:true});assert.equal(start.status,200);key=start.body.key;
  assert.equal((await h.send(key,'好耶',['99'])).status,200);assert.equal(h.groupRehearsals.get(key).outputs.at(-1).type,'face');assert.equal(network,0);assert.equal(h.calls.http.length,0);
  h.saveSocialV2State();assert.equal(JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8')).conversations[key],undefined);
  await h.finishGroupRehearsal(key);key=(await h.request('/api/debug/group-rehearsal',{action:'start',groupId:'456'})).body.key;
  assert.equal((await h.send(key,'',['182'])).status,500);assert.equal(h.calls.http.length,0);
 }finally{if(key)await h.finishGroupRehearsal(key);await h.close();}
});
