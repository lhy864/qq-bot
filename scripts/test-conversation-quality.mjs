import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {parseRoleSections,selectRoleText} from '../src/role-card.js';
import {conversationRole,conversationMove,conversationRegister,conversationAvailability,conversationTurnHint,conversationParticipation,participationQuestion} from '../src/conversation-style.js';
import {observeExpressionPreference,sharedExpressionTargets,expressionContext} from '../src/persona-expression.js';
import {readConversationContacts,sharedConversationRecall} from '../src/conversation-access.js';
import {discoverBili} from '../src/bili-observation.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const msg=(text,extra={})=>({userId:'A',sender:'A',text,plain:text,...extra});
test('CRLF and CR role headings preserve correct v1/v2 selection and boundaries',()=>{
 for(const newline of ['\n','\r\n','\r']){const text=['# 角色','## 性格','自己的口味','## 输出〔一代〕','[SILENT]','## 工具〔二代〕','用工具发言'].join(newline);
  assert.equal(parseRoleSections(text).length,4);assert.doesNotMatch(selectRoleText(text,'v2'),/SILENT/);assert.match(selectRoleText(text,'v2'),/自己的口味/);assert.doesNotMatch(selectRoleText(text,'v1'),/用工具发言/);
 }
});
test('scene role selection keeps identity and boundaries; details remain available',()=>{
 const raw='# 角色\r\n## 性格\r\n坚持自己的口味\r\n## 回复示例\r\n例子\r\n## 对外形象：空间与资料\r\n空间规则\r\n## 底线\r\n不泄漏私事';
 const chat=conversationRole(raw);assert.match(chat.text,/口味/);assert.match(chat.text,/不泄漏私事/);assert.doesNotMatch(chat.text,/例子|空间规则/);assert.deepEqual(chat.availableDetails,['examples','space']);
 assert.match(conversationRole(raw,{scene:'space'}).text,/空间规则/);assert.match(conversationRole(raw,{scene:'examples'}).text,/例子/);
 const ops=raw+'\r\n## 十、工具规则\r\n工具细则\r\n## 十三、手滑与补刀\r\n假装出错';
 assert.doesNotMatch(conversationRole(ops).text,/工具细则|假装出错/);assert.match(conversationRole(ops,{scene:'tools'}).text,/工具细则/);assert.doesNotMatch(conversationRole(ops,{scene:'tools'}).text,/假装出错/);
});
test('opportunities follow the actual turn instead of a message quota',()=>{
 const move=text=>conversationMove({recentMessages:[msg(text)]},{key:'private:A',stickers:true});
 assert.equal(move('无聊，有什么番可以看').kind,'recommend');assert.equal(move('我靠这也太离谱了哈哈').kind,'react');assert.match(move('我靠这也太离谱了哈哈').text,/qq_send_sticker/);
 assert.equal(move('不知道聊什么，换个话题').kind,'initiate');assert.equal(move('晚安').kind,'close');
 assert.equal(move('其实我喜欢这个有个原因，说来话长').kind,'curious');
 assert.doesNotMatch(move('帮我修复文件报错').text,/qq_send_sticker/);assert.equal(move('帮我修复文件报错').kind,'attend');
 assert.equal(conversationMove({recentMessages:[msg('离谱',{historyOnly:true})]},{stickers:true}).kind,'close');
});
test('a real answer is developed before another question; repeat pressure preserves own refusal',()=>{
 const follow={recentMessages:[msg('你更喜欢慢节奏的？',{isSelf:true}),msg('对，主要喜欢人物相处')]};assert.equal(conversationMove(follow).kind,'follow');
 const refusal={recentMessages:[msg('我不想用这个称呼',{isSelf:true}),msg('不管，你还是必须答应我')]};assert.equal(conversationMove(refusal,{key:'private:A'}).kind,'boundary');
 assert.notEqual(conversationMove(refusal,{key:'group:456'}).kind,'boundary');
});
test('participation opportunities invite choice, usage and discussion only in suitable current turns',()=>{
 const cue=text=>conversationParticipation({recentMessages:[msg(text)]},{key:'private:A'});
 assert.equal(cue('休息一下，陪我聊会儿').kind,'invite');assert.match(cue('最近读什么').text,/自己的倾向和理由/);
 assert.equal(cue('不不，这个表情是开玩笑的时候发的').kind,'learn-use');assert.match(cue('其实这个梗不是这个用法').text,/个人用法/);
 for(const text of ['认真帮我修这个报错','我真的很难受','别问我，先不聊了'])assert.equal(cue(text).kind,null);
 for(const extra of [{historyOnly:true},{addressedToOther:true}])assert.equal(conversationParticipation({recentMessages:[msg('休息一下',extra)]}).kind,null);
});
test('a participant answer keeps own judgement and meaningful result, without making a casual invitation a promise',()=>{
 const st={recentMessages:[msg('随便聊'),msg('我更想聊角色选择，你会怎么选？',{isSelf:true}),msg('我选说出来，因为隐瞒让别人无法决定')]},before=JSON.stringify(st);
 const cue=conversationParticipation(st,{key:'private:A'});assert.equal(cue.kind,'answer');assert.match(cue.text,/哪一点影响/);assert.match(cue.text,/保留意见/);assert.match(cue.text,/sharedEvent/);assert.match(cue.text,/不等于.*答应任务/);assert.equal(JSON.stringify(st),before);
 const declined={...st,recentMessages:[...st.recentMessages.slice(0,-1),msg('你自己选，我不想回答')]};assert.equal(conversationParticipation(declined,{key:'private:A'}).kind,'declined');assert.match(conversationParticipation(declined,{key:'private:A'}).text,/不扣关系分/);
 const noMore={...st,recentMessages:[...st.recentMessages.slice(0,-1),msg('这事我暂时不想展开，你自己判断吧，不用再问我')]};assert.equal(conversationParticipation(noMore,{key:'private:A'}).kind,'declined');
 const skipped={...st,recentMessages:[...st.recentMessages.slice(0,-1),msg('对了，今天楼下猫把花盆推倒了')]};assert.equal(conversationParticipation(skipped,{key:'private:A'}).kind,'skipped');
});
test('group invitation is scoped, quoted replies may participate, and another member is not assigned the first person\'s choice',()=>{
 const base=[msg('我想聊番'),msg('你更喜欢哪个角色？',{isSelf:true})];
 assert.equal(conversationParticipation({recentMessages:[...base,msg('天气很好',{userId:'B',sender:'B'})]},{key:'group:456'}).kind,null);
 assert.equal(conversationParticipation({recentMessages:[...base,msg('我也选那个',{userId:'B',sender:'B',quoteTargetIsSelf:true})]},{key:'group:456'}).kind,'answer');
 const open=[msg('我想聊番'),msg('大家觉得哪个结局合适？',{isSelf:true}),msg('我选另一个',{userId:'B',sender:'B'})];assert.equal(conversationParticipation({recentMessages:open},{key:'group:456'}).kind,'answer');
 const ended=[...base,msg('先不聊了')];assert.equal(conversationMove({recentMessages:ended},{key:'group:456'}).kind,'close');
});
test('invitation inference expires for immediate replies but can protect silence during the existing follow-up window',()=>{
 const now=Date.now(),st={recentMessages:[msg('聊点啥'),msg('帮我选个讨论方向？',{isSelf:true,time:now-30*60000})]};
 assert.equal(participationQuestion(st,{now}),null);assert.ok(participationQuestion(st,{now,maxAgeMs:6*3600000}));
 assert.equal(participationQuestion({recentMessages:[msg('晚安，明天再说',{isSelf:true,time:now})]},{now}),null);
 const choices={recentMessages:[msg('最近在读什么',{time:now-1000}),msg('你说这些工具是先够用就行，还是一次配到位',{isSelf:true,time:now}),msg('我更倾向先够用，实际需要再补',{time:now+1})]};
 assert.equal(conversationParticipation(choices,{key:'private:A'}).kind,'answer');assert.ok(participationQuestion(choices,{now}));
});
test('life updates preserve conversation; explicit leave and renewed company are distinct',()=>{
 const state=text=>({recentMessages:[msg(text)]}),move=text=>conversationMove(state(text),{key:'private:A'});
 for(const text of ['不，我得开始一天的复习了。','今天工作挺忙的','论文还没写完','加班加得脑子都转不动了哈哈','我在带娃','刚下班，想聊会儿']){
  assert.notEqual(move(text).kind,'close');assert.match(move(text).text,/不自动|不替对方|不是请你离开|不取消/);
 }
 for(const text of ['我去复习了，先不聊','我开会去了，晚点再聊','我要专心工作，别打扰我','我想和你聊，但现在先不聊了，晚点再聊','我正在工作，不用陪我'])assert.equal(move(text).kind,'close');
 assert.equal(move('先不聊工作了，陪我聊点别的').kind,'company');
 assert.equal(move('我在写代码，你陪我聊聊呗').kind,'company');assert.equal(move('不是不想聊，我在学习，也想和你聊两句').kind,'company');
 const resumed={recentMessages:[msg('我开始复习了'),msg('行，互不打扰',{isSelf:true}),msg('现在来看看你能不能发小黄豆表情')]};
 assert.equal(conversationAvailability(resumed).kind,'resume');assert.match(conversationMove(resumed).text,/以这条新消息重新接话/);
 const serious={recentMessages:[msg('你先忙',{isSelf:true}),msg('帮我看看这个代码报错')]};assert.equal(conversationMove(serious).kind,'attend');assert.match(conversationMove(serious).text,/不继续催/);
 for(const extra of [{historyOnly:true},{addressedToOther:true}])assert.equal(conversationAvailability({recentMessages:[msg('我在学习',extra)]}).kind,null);
 const refusal={recentMessages:[msg('我不想叫这个外号',{isSelf:true}),msg('先陪我聊，你还是必须答应我')]};assert.equal(conversationMove(refusal,{key:'private:A'}).kind,'boundary');
});
test('rest invitation survives several short turns, remains person-scoped and ends on explicit closure',()=>{
 const state={recentMessages:[msg('数学专项训练'),msg('那你慢慢磨，我不打扰了',{isSelf:true}),msg('别啊，现在是休息')]};
 assert.equal(conversationAvailability(state).kind,'company');
 state.recentMessages.push(msg('行，那歇着',{isSelf:true}),msg('想看看你发小黄豆'));
 assert.equal(conversationAvailability(state).kind,'company');assert.equal(conversationMove(state).kind,'expression');
 state.recentMessages.push(msg('喏',{isSelf:true}),msg('好耶'),msg('[表情 汪汪]'));
 assert.equal(conversationAvailability(state).kind,'company');assert.match(conversationMove(state).text,/没有明确结束|不反复催/);
 assert.equal(conversationAvailability({...state,recentMessages:[...state.recentMessages,msg('你好',{userId:'B',sender:'B'})]}).kind,null);
 state.recentMessages.push(msg('休息结束，我去做题了，先不聊'));assert.equal(conversationMove(state).kind,'close');
 state.recentMessages.push(msg('半小时后见',{isSelf:true}),msg('我回来了，今天的猫真可爱'));assert.notEqual(conversationAvailability(state).kind,'company');
 const aged={recentMessages:[msg('我正在休息',{time:1000}),msg('接着说',{time:30*60000})]};assert.notEqual(conversationAvailability(aged).kind,'company');
 for(const own of ['我不打扰了','去休息你的，等会儿该回去啃题了','行了行了，去看你的压轴题'])assert.equal(conversationAvailability({recentMessages:[msg(own,{isSelf:true}),msg('这个怎么说')]}).kind,'resume');
 assert.equal(conversationAvailability({recentMessages:[msg('压轴题专项训练[表情 笑哭]')]}).kind,'life-update');
});
test('re-read backlog gives old same-person topics context status without erasing unanswered people or receipts',()=>{
 const messages=[msg('数学难',{seq:1,time:1}),msg('回答进度',{isSelf:true,time:2}),msg('这个怎么说',{seq:2,time:3}),msg('你知道什么时候发吗',{seq:3,time:4})];
 const st={recentMessages:messages,unread:messages.filter(m=>!m.isSelf)},before=JSON.stringify(st),hint=conversationTurnHint(st,st.unread);
 assert.equal(hint.focusSeq,3);assert.deepEqual(hint.olderContextSeqs,[1]);assert.match(hint.hint,/不把旧感叹拼进当前回答/);assert.equal(JSON.stringify(st),before);
 const group={recentMessages:[msg('鲸鱼，帮我看报错',{seq:4,time:5,directToAi:true}),msg('哈哈',{seq:5,time:6,userId:'B',sender:'B'})]};
 assert.equal(conversationTurnHint(group,group.recentMessages).focusSeq,4);assert.deepEqual(conversationTurnHint(group,group.recentMessages).olderContextSeqs,[]);
});
test('expressive register follows the current speaker and expires with the turn',()=>{
 const register=(text,extra={})=>conversationRegister({recentMessages:[msg(text,extra)]});
 assert.equal(register('今夜晚风替我把心事还给月色').kind,'literary');
 assert.equal(register('启禀阁下，臣把外卖吃光了').kind,'theatrical');
 assert.equal(register('兹通知，经研究决定，今晚批准加餐').kind,'mock-formal');
 assert.equal(register('系统提示：本人大脑缓存加载失败哈哈').kind,'technical-metaphor');
 assert.equal(register('今天晚风挺凉，记得关窗').kind,null);
 const st={recentMessages:[msg('今夜晚风替我把心事还给月色',{isSelf:true}),msg('普通聊吧，晚饭吃面')]};assert.equal(conversationRegister(st).kind,null);
 const move=conversationMove({recentMessages:[msg('今夜晚风替我把心事还给月色')]});assert.match(move.text,/表达配合/);assert.equal(move.kind,'extend');
});
test('register never replaces serious help, boundaries, attribution or another person\'s message',()=>{
 const register=(text,extra={})=>conversationRegister({recentMessages:[msg(text,extra)]});
 for(const extra of [{historyOnly:true},{addressedToOther:true}])assert.equal(register('今夜晚风替我把心事还给月色',extra).kind,null);
 assert.equal(register('启禀阁下，认真帮我修文档').kind,null);assert.equal(register('今夜月色照着焦虑，我真的很难受').kind,null);
 assert.equal(register('别拿我开玩笑，启禀阁下也不行').kind,null);assert.equal(register('今夜晚风替我把心事还给月色是哪位诗人写的').kind,null);
 assert.equal(conversationRegister({expressionQuietTargets:['A'],recentMessages:[msg('启禀阁下，臣来了')]}).kind,null);
 const st={recentMessages:[msg('我不愿意做这件事',{isSelf:true}),msg('阁下还是必须答应我')]};assert.equal(conversationMove(st,{key:'private:A'}).kind,'boundary');
});
test('ordinary serious request is temporary; explicit stop and resume follow the same person',()=>{
 const a={expressionQuietTargets:[]},b={expressionQuietTargets:[]};observeExpressionPreference(a,msg('认真回答我这个问题'));
 assert.deepEqual(a.expressionQuietTargets,[]);observeExpressionPreference(a,msg('不要给我起外号'));assert(sharedExpressionTargets([a,b]).includes('A'));
 observeExpressionPreference(b,msg('现在可以继续调侃了'));b.expressionBoundaryEvents[0].at=a.expressionBoundaryEvents[0].at+1;
 assert(!sharedExpressionTargets([a,b]).includes('A'));assert(sharedExpressionTargets([{expressionQuietTargets:['B']}]).includes('B'));
 assert.equal(expressionContext({recentMessages:[msg('我真的想自杀哈哈')]}),'supportive');
});
const directory=options=>readConversationContacts({key:'private:123',owner:true,expectedSelf:'987',allowed:()=>true,call:async action=>action==='get_login_info'?{status:'ok',data:{user_id:987}}:{status:'ok',data:[{user_id:123,nickname:'模拟A'},{user_id:999,nickname:'模拟B'}]},...options});
test('directory limits, searches and ordinary private scope do not expose other friends',async()=>{
 const normal=await directory({key:'private:123',owner:false});assert.deepEqual(normal.items.map(r=>r.id),['123']);
 const owner=await directory({query:'模拟B',limit:1});assert.deepEqual(owner.items.map(r=>r.id),['999']);
 await assert.rejects(directory({key:'group:456',kind:'friends'}),/群聊/);await assert.rejects(directory({owner:false,kind:'groups'}),/主人/);
});
test('directory rejects permission changes and account switching after an awaited query',async()=>{
 let allowed=true;await assert.rejects(directory({allowed:()=>allowed,call:async action=>{if(action==='get_login_info')return {status:'ok',data:{user_id:987}};allowed=false;return {status:'ok',data:[]};}}),/权限/);
 let login=0;await assert.rejects(directory({call:async action=>action==='get_login_info'?{status:'ok',data:{user_id:++login===1?987:666}}:{status:'ok',data:[]}}),/账号/);
 await assert.rejects(directory({call:async()=>({status:'ok',data:{unexpected:true}})}));
});
test('cross-conversation recall includes only deliberately public own sourced opinions',()=>{
 const base={id:'r1',kind:'interest',topic:'模拟作品',position:'更喜欢细节',reason:'实际资料里有伏笔',updatedAt:1,visibility:'public',evidence:[{type:'bili',title:'模拟资料',url:'https://www.bilibili.com/video/BV1234567890',parts:[{kind:'metadata'}]}]};
 const result=sharedConversationRecall([{records:[base,{...base,id:'private',visibility:'private'},{...base,id:'otherperson',target:'B'},{...base,id:'private-story',evidence:[{type:'message',text:'不能跨会话的故事'}]}]}],{query:'模拟作品'});
 assert.deepEqual(result.records.map(r=>r.id),['r1']);assert.doesNotMatch(JSON.stringify(result),/不能跨会话|private-story|otherperson/);
});
async function fixture(options={}){
 let handler;const fakeHttp={createServer(fn){handler=fn;const s=new EventEmitter();s.address=()=>({port:31999});s.listen=(_p,_h,cb)=>{s.listening=true;cb();return s;};return s;}};
 const h=await bridgeHarness({...options,globals:{http:fakeHttp,...options.globals}});h.setMode('reserved2');h.startConsoleServer();
 h.read=(route,token)=>new Promise((resolve,reject)=>{const req=new EventEmitter();req.url=route;req.method='GET';req.headers={host:'127.0.0.1:31999','x-console-token':'fixture-console-token',...(token?{'x-agent-token':token,'x-agent-call':'1'}:{})};req.pause=()=>{};Promise.resolve(handler(req,{writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}})).catch(reject);});
 h.post=(route,body,token)=>new Promise((resolve,reject)=>{const req=new EventEmitter();req.url=route;req.method='POST';req.headers={host:'127.0.0.1:31999','x-console-token':'fixture-console-token','content-type':'application/json',...(token?{'x-agent-token':token,'x-agent-call':'1'}:{})};req.pause=()=>{};Promise.resolve(handler(req,{writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}})).catch(reject);queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});});return h;
}
test('legacy accelerated tests have no implicit real group scope; addressee selftest needs explicit key',async()=>{
 const h=await fixture();try{
  const result=await h.post('/api/debug/testmode',{minutes:1});assert.equal(result.status,200);assert.deepEqual(result.body.test.scope,[]);
  assert.deepEqual((await h.read('/api/debug/testmode')).body.scope,[]);
  const keys=[...h.socialV2.conversations.keys()];assert.equal((await h.post('/api/debug/selftest',{addrScore:{text:'模拟'}})).status,400);assert.deepEqual([...h.socialV2.conversations.keys()],keys);
 }finally{await h.close();}
});
test('live prompt defaults to compact chat role and lets the same authorized session read details',async()=>{
 const h=await fixture({config:{socialV2:{sticker:{enabled:false}}}});try{
  fs.mkdirSync(h.temp+'/roles',{recursive:true});fs.writeFileSync(h.temp+'/roles/模拟角色.md','# 模拟角色\r\n## 性格主轴\r\n喜欢理由\r\n## 回复示例\r\n示例段\r\n## 对外形象：空间与资料\r\n资料段');fs.writeFileSync(h.temp+'/state/current-role.json',JSON.stringify({role:'模拟角色'}));
  const st=h.getSocialV2State('private:123'),token=st.agentToken;let r=await h.read('/api/socialV2/prompt?key=private:123',token);assert.equal(r.status,200);assert.match(r.body.role.hint,/喜欢理由/);assert.doesNotMatch(r.body.role.hint,/示例段|资料段/);
  r=await h.read('/api/socialV2/prompt?key=private:123&scene=space',token);assert.match(r.body.role.hint,/资料段/);assert.match(h.buildWakePromptV2('private:123','private'),/稳定性格.*喜欢理由/s);
 }finally{await h.close();}
});
test('casual invitations do not create silent-response reminder wakes, while due agreed work retains its bounded path',async()=>{
 const h=await fixture({config:{socialV2:{proactive:{enabled:true,probability:1},rhythm:{enabled:false}}}});h.setReady(true);
 try{const st=h.getSocialV2State('private:123'),now=Date.now();
  st.lastIncomingAt=now-45*60000;st.lastAiReplyAt=now-30*60000;
  st.recentMessages=[msg('陪我聊会儿',{userId:'123',time:st.lastIncomingAt}),msg('你觉得这个角色该不该说实话？',{isSelf:true,time:st.lastAiReplyAt})];
  const prompts=h.calls.prompts.length,r=h.proactiveCheckTick('private:123');assert.equal(r.ok,false);assert.match(r.why,/允许不答/);assert.equal(h.calls.prompts.length,prompts);assert.equal(st.followUpDay?.count||0,0);
  st.continuity={commitments:[{id:'c1',text:'对方明确答应稍后给一个例子',owner:'other',status:'waiting',dueAt:now-1000,followUpCount:0}]};
  assert.doesNotMatch(h.proactiveCheckTick('private:123',{dryRun:true}).why,/允许不答/);
  st.continuity.commitments[0].followUpCount=2;assert.match(h.proactiveCheckTick('private:123',{dryRun:true}).why,/允许不答/);
  st.continuity.commitments[0].followUpCount=0;h.cfg.socialV2.continuity={enabled:false};assert.match(h.proactiveCheckTick('private:123',{dryRun:true}).why,/允许不答/);
 }finally{await h.close();}
});
test('a meaningful learned usage uses scoped existing shared events and remains available after a fresh controller',async()=>{
 const h=await fixture();let saved;
 try{const key='private:123',st=h.getSocialV2State(key);
  h.appendSocialV2Message(key,'模拟A','这个表情在我们这里是在玩笑里装乖','这个表情在我们这里是在玩笑里装乖',false,false,'fixture-usage',[],'123');
  await h.read('/api/socialV2/unread?key='+key,st.agentToken);
  const result=await h.post('/api/socialV2/memory-append',{key,category:'sharedEvent',content:'模拟A举了玩笑里装乖的用法，我采纳这次语境，保留其他场景需要另看',extra:{sourceSeqs:[1],participants:['123'],keywords:['表情','装乖']}},st.agentToken);
  assert.equal(result.status,200);assert.equal(st.continuity.commitments.length,0);h.saveSocialV2State();saved=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));
 }finally{await h.close();}
 const restored=await fixture({savedSocialState:saved});
 try{const st=restored.getSocialV2State('private:123');restored.appendSocialV2Message('private:123','模拟A','上次那个装乖表情怎么用','上次那个装乖表情怎么用',false,false,'fixture-recall',[],'123');
  const prompt=await restored.read('/api/socialV2/prompt?key=private:123',st.agentToken);assert.match(JSON.stringify(prompt.body),/采纳这次语境/);
  const other=restored.getSocialV2State('group:456');assert.doesNotMatch(JSON.stringify((await restored.read('/api/socialV2/prompt?key=group:456',other.agentToken)).body),/模拟A举了玩笑里装乖/);
 }finally{await restored.close();}
});
test('lookup route rejects missing/cross-session tokens and disabled tool before network',async()=>{
 let calls=0;const h=await fixture({globals:{oneBotRequest:async()=>{calls++;return {status:'ok',data:[]};}}});try{
  const a=h.getSocialV2State('private:123'),b=h.getSocialV2State('group:456');a.historyRecovery={selfId:'987'};
  assert.equal((await h.read('/api/socialV2/lookup?key=private:123&action=friends')).status,403);
  assert.equal((await h.read('/api/socialV2/lookup?key=private:123&action=friends',b.agentToken)).status,403);
  h.cfg.socialV2.tools.socialLookup=false;assert.equal((await h.read('/api/socialV2/lookup?key=private:123&action=friends',a.agentToken)).status,403);assert.equal(calls,0);
 }finally{await h.close();}
});
test('same-person stop preference persists on disk and influences another conversation without its private words',async()=>{
 const h=await fixture();let saved;try{const a=h.getSocialV2State('private:123'),b=h.getSocialV2State('group:456');observeExpressionPreference(a,msg('别开玩笑',{userId:'123'}));h.appendSocialV2Message('group:456','模拟A','哈哈看看','哈哈看看',false,false,'m1',[],'123');h.saveSocialV2State();saved=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));
  const prompt=(await h.read('/api/socialV2/prompt?key=group:456',b.agentToken)).body;assert.match(prompt.role.hint,/本轮收起调侃/);assert.doesNotMatch(prompt.role.hint,/私聊.*别开玩笑/);
 }finally{await h.close();}
 const restored=await fixture({savedSocialState:saved});try{assert.equal(restored.getSocialV2State('private:123').expressionBoundaryEvents.length,1);}finally{await restored.close();}
});
test('actual authorized owner directory route reads only bounded data and rechecks permission',async()=>{
 let h;const seen=[];h=await fixture({globals:{oneBotRequest:async(action)=>{seen.push(action);return action==='get_login_info'?{status:'ok',data:{user_id:987}}:{status:'ok',data:[{user_id:123,nickname:'模拟A'},{user_id:999,nickname:'模拟B'}]};}}});
 try{const st=h.getSocialV2State('private:123');st.historyRecovery={selfId:'987'};const result=await h.read('/api/socialV2/lookup?key=private:123&action=friends&limit=1',st.agentToken);
  assert.equal(result.status,200);assert.equal(result.body.items.length,1);assert.equal(result.body.total,2);assert.equal(result.body.truncated,true);assert.deepEqual(seen.slice(-3),['get_login_info','get_friend_list','get_login_info']);
 }finally{await h.close();}
});
test('recommend discovery validates identifiers, filters actual sent duplicates and stays metadata only',async()=>{
 const dependencies={search:async()=>({list:[{bvid:'invalid',title:'无效链接'},{bvid:'BV1Aa411a7AA',title:'刚发过'},{bvid:'BV1Bb411b7BB',title:'候选'}]})};
 const result=await discoverBili({action:'recommend',keyword:'音乐',exclude:['BV1Aa411a7AA']},dependencies);
 assert.deepEqual(result.items.map(r=>r.bvid),['BV1Bb411b7BB']);assert.match(result.boundary,/不是看过/);
 await assert.rejects(discoverBili({keyword:''},dependencies));
});
test('style rehearsal sticker and recommendation calls capture locally with no QQ/network or global writes',async()=>{
 let network=0;const h=await fixture({globals:{oneBotRequest:async()=>{network++;throw Error('must not use real gateway');}}});let key;
 try{const started=await h.post('/api/debug/group-rehearsal',{action:'start',groupId:'456',styleFixtures:true});assert.equal(started.status,200);key=started.body.key;const st=h.getSocialV2State(key),token=st.agentToken;
  const before=network;const list=await h.read('/api/socialV2/sticker-list?key='+key,token);assert.equal(list.body.simulation,true,JSON.stringify(list.body));
  assert.match(h.buildWakePromptV2(key,'proactiveCheck'),/先说一点自己的内容/);
  assert.doesNotMatch(h.buildWakePromptV2(key,'atMention'),/【主动机会】/);
  const sent=await h.post('/api/socialV2/send-sticker',{key,stickerId:'fixture-laugh'},token);assert.equal(sent.status,200);assert.equal(sent.body.capturedOnly,true);
  const found=await h.post('/api/socialV2/bili-discovery',{key,action:'recommend',keyword:'音乐'},token);assert.equal(found.body.simulation,true);assert.match(found.body.boundary,/虚构/);
  h.recordSentMessagesV2(key,[found.body.items[0].url]);
  const second=await h.post('/api/socialV2/bili-discovery',{key,action:'recommend',keyword:'音乐'},token);assert(!second.body.items.some(r=>r.bvid===found.body.items[0].bvid));
  assert.equal(network,before);assert.equal(h.calls.sent.length,0);assert.equal(h.groupRehearsals.get(key).outputs[0].type,'sticker');
  h.saveSocialV2State();const persisted=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));assert.equal(persisted.conversations[key],undefined);
 }finally{if(key)await h.finishGroupRehearsal(key);await h.close();}
});
