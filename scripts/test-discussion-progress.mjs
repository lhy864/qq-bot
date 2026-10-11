import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {appendContinuity,updateContinuity,normalizeContinuity,discussionProgress,discussionPaused} from '../src/social-continuity.js';import {materialSelection,materialConversationHint} from '../src/material-conversation.js';import {bridgeHarness} from './audit-bridge-harness.mjs';
const now=Date.now(),messages=[{seq:1,userId:'123',sender:'甲',text:'Python 循环的条件我明白了，下次讲怎么更新变量',time:now},{seq:2,userId:'456',sender:'乙',text:'Python 我没听过',time:now}];
const notes=[{id:'n',itemId:'python',title:'Python · 教程',kind:'study',excerpt:'条件决定循环停止',summary:'循环条件改变',position:'喜欢追踪每步',reason:'能解释输出',at:now+1000},{id:'b',itemId:'book',title:'模拟小说',kind:'reading',excerpt:'有书',summary:'有书',at:now}];
const event=()=>appendContinuity({},'sharedEvent','Python：甲已理解循环条件，想继续聊更新变量；未解：什么时候改变条件',{participants:['123'],keywords:['Python','循环'],sourceSeqs:[1]},{messages,now}).journal;
test('actual stop evidence wins over a model summary that leaves a future discussion hanging; aliases resolve locally',()=>{
 const result=appendContinuity({},'sharedEvent','Python先搁置，但约定仍挂着有新材料再接着聊',{participants:['甲'],keywords:['Python'],sourceSeqs:[3]},{messages:[...messages,{seq:3,userId:'123',sender:'甲',time:now,text:'Python这个今天不聊了，先搁置'}],now}).journal;
 assert.deepEqual(result.sharedEvents[0].participants,['123']);assert.equal(discussionPaused(result.sharedEvents[0],'123'),true);
 assert.equal(materialSelection(notes,'',{share:true,target:'123',continuity:result,now:now+2000})[0].itemId,'book');
 const renewed=updateContinuity(result,'sharedEvent',result.sharedEvents[0].id,{text:'Python重新接着聊',sourceSeqs:[4]},{messages:[{seq:4,userId:'123',time:now+1000,text:'Python现在重新聊聊吧'}],now:now+1000}).journal;assert.equal(discussionPaused(renewed.sharedEvents[0],'123'),false);
});
test('persisted discussion retrieves current participant progress without leaking to a different peer',()=>{
 const saved=normalizeContinuity(JSON.parse(JSON.stringify(event())));assert.equal(saved.sharedEvents[0].evidence[0].userId,'123');
 assert.equal(discussionProgress(saved,{titles:['Python'],target:'123',now:now+1000}).length,1);assert.equal(discussionProgress(saved,{titles:['Python'],target:'456',now:now+1000}).length,0);
 const hint=materialConversationHint(notes,[],'Python 继续',{target:'123',continuity:saved,now:now+2000});assert.match(hint,/甲已理解/);assert.match(hint,/newMaterialAfterDiscussion":true/);assert.match(hint,/对方现在表示没懂/);
});
test('ending updates existing event, survives serialization, and blocks optional reopening only',()=>{
 const journal=event(),id=journal.sharedEvents[0].id;const updated=updateContinuity(journal,'sharedEvent',id,{text:'Python 讨论暂时搁置，不再接续',sourceSeqs:[1]},{messages,now:now+1000}).journal;
 assert.equal(updated.sharedEvents.length,1);assert.equal(updated.sharedEvents[0].id,id);
 assert.equal(materialSelection(notes,'',{share:true,target:'123',continuity:JSON.parse(JSON.stringify(updated)),now:now+2000})[0].itemId,'book');
 assert.equal(materialSelection(notes,'Python 重新聊聊',{target:'123',continuity:updated,now:now+2000})[0].itemId,'python');
 assert.match(materialConversationHint(notes,[],'不聊这个了',{target:'123',recentMessages:[{isSelf:true,text:'Python 教程',time:now},messages[0]],continuity:journal,now:now+2000}),/只保存对原话题的停止状态/);
});
test('real bridge writes and reloads discussion after a process-equivalent restart, preserving recall next day',async()=>{
 let disk;const h=await bridgeHarness();try{const st=h.getSocialV2State('private:123');st.recentMessages=messages;h.appendMemoryV2(st,'sharedEvent','Python 已懂循环条件；下次讨论变量更新',{participants:['123'],keywords:['Python'],sourceSeqs:[1]});disk=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8'));assert.equal(disk.conversations['private:123'].continuity.sharedEvents.length,1);}finally{await h.close();}
 const next=now+86400000;class Clock extends Date{constructor(...args){super(...(args.length?args:[next]));}static now(){return next;}}
 const reload=await bridgeHarness({savedSocialState:disk,globals:{Date:Clock}});try{reload.setMode('reserved2');fs.writeFileSync(reload.temp+'/state/leisure.json',JSON.stringify({notes,items:[]}));const st=reload.getSocialV2State('private:123');st.recentMessages=[{seq:3,userId:'123',plain:'Python 变量更新怎么想',text:'Python 变量更新怎么想',time:next,directToAi:true}];st.unread=st.recentMessages;st.modelSeenSeqs=new Set([3]);assert.match(reload.livedContextV2('private:123',st),/已懂循环条件/);assert.match(reload.currentConversationV2('private:123',st,st.unread).hint,/已保存的讨论进展/);assert.equal(reload.calls.sent.length,0);}finally{await reload.close();}
});
test('durable write failure rolls memory back instead of returning apparent success',async()=>{
 const broken={...fs,renameSync:(from,to)=>{if(String(to).endsWith('social-v2.json'))throw Error('fixture write failure');return fs.renameSync(from,to);}};
 const h=await bridgeHarness({globals:{fs:broken}});try{const st=h.getSocialV2State('private:123');st.recentMessages=messages;const before=JSON.stringify(st.continuity);assert.throws(()=>h.appendMemoryV2(st,'sharedEvent','Python 已解释循环',{participants:['123'],keywords:['Python'],sourceSeqs:[1]}),/fixture write failure/);assert.equal(JSON.stringify(st.continuity),before);}finally{await h.close();}
});
test('discussion survives closing a separate Node writer process and loading in another Node process',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-discussion-restart-')),saved=path.join(dir,'saved.json'),url=new URL('./audit-bridge-harness.mjs',import.meta.url).href;
 try{execFileSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import {bridgeHarness} from ${JSON.stringify(url)};const h=await bridgeHarness();try{const s=h.getSocialV2State('private:123');s.recentMessages=[{seq:1,userId:'123',text:'Python 条件懂了',time:Date.now()}];h.appendMemoryV2(s,'sharedEvent','Python 条件已理解，下次聊变量更新',{participants:['123'],keywords:['Python'],sourceSeqs:[1]});fs.copyFileSync(h.temp+'/state/social-v2.json',process.env.DISCUSSION_FIXTURE);}finally{await h.close();}`],{env:{...process.env,DISCUSSION_FIXTURE:saved},timeout:20000,stdio:'pipe'});
 const output=execFileSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import {bridgeHarness} from ${JSON.stringify(url)};import {discussionProgress} from ${JSON.stringify(new URL('../src/social-continuity.js',import.meta.url).href)};const h=await bridgeHarness({savedSocialState:JSON.parse(fs.readFileSync(process.env.DISCUSSION_FIXTURE,'utf8'))});try{const s=h.getSocialV2State('private:123');const records=discussionProgress(s.continuity,{titles:['Python'],target:'123'});console.log(JSON.stringify({count:records.length,text:records[0]?.text}));}finally{await h.close();}`],{env:{...process.env,DISCUSSION_FIXTURE:saved},timeout:20000,encoding:'utf8'});assert.deepEqual(JSON.parse(output),{count:1,text:'Python 条件已理解，下次聊变量更新'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
