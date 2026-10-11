import test from 'node:test';import assert from 'node:assert/strict';
import {participationQuestion,conversationParticipation} from '../src/conversation-style.js';import {appendContinuity,updateContinuity} from '../src/social-continuity.js';import {materialConversationHint} from '../src/material-conversation.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const now=Date.now(),m=(text,extra={})=>({text,userId:'123',sender:'甲',time:now,...extra});
test('question remains usable after own continuation and face bubbles, then disappears after responding',()=>{
 const base=[m('聊聊这本书'),m('我倾向保留一点，你觉得呢？',{isSelf:true}),m('主要是身体和记忆的错位',{isSelf:true}),m('[笑哭]',{isSelf:true})];
 const st={recentMessages:[...base,m('我觉得这两个原因可以同时成立')]};assert.match(participationQuestion(st).text,/你觉得呢/);assert.equal(conversationParticipation(st,{key:'private:123'}).kind,'answer');
 assert.equal(participationQuestion({recentMessages:[...st.recentMessages,m('这点我接受，另一个判断仍保留',{isSelf:true})]}),null);
 assert.equal(participationQuestion({recentMessages:[...base,m('先不聊了',{isSelf:true})]}),null);
});
test('multi-bubble invitations respect declines, short responses, topic changes and the current speaker',()=>{
 const base=[m('小说呢'),m('我比较喜欢这个解释，你会怎么理解？',{isSelf:true}),m('不急着得出一个结论',{isSelf:true})];const cue=(text,extra={},key='private:123')=>conversationParticipation({recentMessages:[...base,m(text,extra)]},{key});
 assert.equal(cue('不知道，你自己想吧').kind,'declined');assert.equal(cue('对了，楼下猫翻垃圾桶了').kind,'skipped');assert.equal(cue('我也赞成').kind,'answer');assert.match(cue('先请我喝奶茶再说哈哈').text,/玩笑愿意时接住/);
 assert.equal(cue('天气不错',{userId:'456',sender:'乙'},'group:fixture').kind,null);
 assert.equal(cue('我也能这么理解',{userId:'456',sender:'乙',quoteTargetIsSelf:true},'group:fixture').kind,'answer');
 assert.match(cue('我觉得都能成立').text,/后台队列没有操作成功/);assert.match(cue('我觉得都能成立').text,/已经回应后不自动追加/);
});
test('actual contribution survives a result update and reaches only its participant with the saved reasons',()=>{
 const msgs=[{seq:1,...m('Python循环先画每一步，比背答案更好懂')},{seq:2,...m('我只看小说',{userId:'456',sender:'乙'})}];
 const first=appendContinuity({},'sharedEvent','Python讨论：甲建议先画循环每一步，我采纳逐步解释方式但仍保留用小程序验证的打算',{participants:['123'],keywords:['Python'],sourceSeqs:[1]},{messages:msgs,now});
 const saved=updateContinuity(first.journal,'sharedEvent',first.entry.id,{text:'Python讨论结果：先画每一步，确认边界后再运行；保留实际验证的理由，不宣称已经运行',sourceSeqs:[1]},{messages:msgs,now}).journal;
 const note={id:'n',itemId:'python',title:'Python · 基础',kind:'study',summary:'循环',position:'重视实际结果',reason:'判断条件',at:now};
 const hint=materialConversationHint([note],[],'Python上次我们怎么讨论的',{target:'123',continuity:JSON.parse(JSON.stringify(saved)),now});assert.match(hint,/Python循环先画每一步/);assert.match(hint,/先画每一步，确认边界后再运行/);assert.match(hint,/不把没主意/);
 assert.doesNotMatch(materialConversationHint([note],[],'Python呢',{target:'456',continuity:saved,now}),/Python循环先画每一步/);assert.equal(saved.commitments.length,0);
});
test('isolated reactions are captured once, reject unknown messages and never call the real gateway',async()=>{
 const h=await bridgeHarness({config:{socialV2:{tools:{react:true}}}});let server;try{h.setMode('reserved2');server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const req=async(route,body,token)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token',...(token?{'x-agent-call':'1','x-agent-token':token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const start=await req('/api/debug/group-rehearsal',{action:'start',groupId:'456',styleFixtures:true,continuous:true});assert.equal(start.status,200);const key=start.body.key,st=h.getSocialV2State(key);st.recentMessages=[{seq:1,messageId:'-101',userId:'123',text:'我也赞成',time:now}];st.modelSeenSeqs=new Set([1]);
 const before=h.calls.http.length,body={key,messageId:'-101',emoji:'76'};for(let i=0;i<2;i++){const r=await req('/api/socialV2/react',body,st.agentToken);assert.equal(r.status,200);assert.equal(r.body.capturedOnly,true);}assert.equal(h.calls.http.length,before);assert.equal(h.calls.sent.length,0);
 const result=await req('/api/debug/group-rehearsal',{action:'results',key});assert.equal(result.body.reactions.length,1);assert.equal(result.body.offeredThroughSeq,1);
 assert.equal((await req('/api/socialV2/react',{...body,messageId:'9999'},st.agentToken)).status,400);assert.equal((await req('/api/socialV2/react',{...body,key:'group:456'},st.agentToken)).status,403);await req('/api/debug/group-rehearsal',{action:'finish',key});
 }finally{if(server)await new Promise(r=>server.close(r));await h.close();}
});
