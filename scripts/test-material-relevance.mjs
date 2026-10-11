import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {materialChoice,materialSelection,materialConversationHint} from '../src/material-conversation.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const now=Date.now(),notes=[
 {id:'old',itemId:'python',kind:'study',title:'Python · 循环',excerpt:'循环条件决定什么时候停止重复',summary:'循环条件决定什么时候停止重复',position:'先追踪循环条件再理解输出',reason:'重复工作要有结束条件',question:'你怎么理解循环停止？',at:now-86400000},
 {id:'new',itemId:'novel',kind:'reading',title:'模拟书虫 · 开头',excerpt:'想在没有书的地方做书',summary:'想在没有书的地方做书',position:'爱书竟然变成解决问题的动力',reason:'目标与环境形成矛盾',question:'你会先找书还是做书？',at:now}
];
const pref=(target,topic)=>({records:[{id:target,kind:'relationship',topic,position:'想一起讨论'+topic,reason:'明确说过想了解',target,updatedAt:now-60000,evidence:[{type:'message',userId:target,isSelf:false,text:topic}]}]});
test('older relevant material outranks newer notes for two scoped friends, and explicit questions win',()=>{
 const a={target:'123',now,share:true,experiences:pref('123','Python 循环条件')},b={...a,target:'456',experiences:pref('456','模拟书虫')};
 assert.equal(materialChoice(notes,'',a).notes[0].itemId,'python');assert.equal(materialChoice(notes,'',b).notes[0].itemId,'novel');
 assert.equal(materialChoice(notes,'模拟书虫讲什么',a).notes[0].itemId,'novel');
 assert.match(materialConversationHint(notes,[],'',a),/有依据经历/);
 assert.equal(materialSelection(notes,'今天午饭吃什么',{...a,share:false}).length,0);
});
test('current topic and category constrain preferences; evidence and exact addressee are required',()=>{
 const opt={target:'123',now,share:true,experiences:pref('123','Python 循环条件')};
 assert.equal(materialSelection(notes,'有什么小说可以聊',opt)[0].itemId,'novel');
 assert.equal(materialSelection(notes,'',{...opt,recentMessages:[{userId:'123',text:'模拟书虫那个目标很有意思',time:now}]})[0].itemId,'novel');
 for(const experiences of [pref('456','Python'),{records:[{...pref('123','Python').records[0],evidence:[]}]}])assert.equal(materialSelection(notes,'',{...opt,experiences})[0].itemId,'novel');
 assert.equal(materialSelection(notes,'循环条件到底怎么决定停止',{})[0].itemId,'python');
});
test('temporary declines stop optional reopening but explicit reopening works; silence is not rejection',()=>{
 const opt={target:'123',now,share:true,experiences:pref('123','Python 循环条件')};
 assert.equal(materialSelection(notes,'',{...opt,recentMessages:[{userId:'123',text:'Python 先不聊了',time:now}]})[0].itemId,'novel');
 assert.equal(materialSelection(notes,'Python 循环呢',{...opt,recentMessages:[{userId:'123',text:'Python 先不聊了',time:now}]})[0].itemId,'python');
 assert.equal(materialSelection(notes,'',opt)[0].itemId,'python');
 assert.equal(materialSelection(notes,'不聊这个了',opt).length,0);
});
test('shared discussion is scoped and bounded; peers/history/future messages cannot supply a topic',()=>{
 const event={text:'讨论 Python 循环条件',participants:['123'],keywords:['Python'],updatedAt:now,evidence:[{seq:1,text:'想聊循环'}]};
 assert.equal(materialSelection(notes,'',{target:'123',now,share:true,continuity:{sharedEvents:[event]}})[0].itemId,'python');
 assert.equal(materialSelection(notes,'',{target:'456',now,share:true,continuity:{sharedEvents:[event]}})[0].itemId,'novel');
 for(const m of [{userId:'456',text:'Python',time:now},{userId:'123',text:'Python',time:now,historyOnly:true},{userId:'123',text:'Python',time:now+1000}])assert.equal(materialSelection(notes,'',{target:'123',now,share:true,recentMessages:[m]})[0].itemId,'novel');
});
test('actual bridge passes only this conversation experience to the read-only material selector',async()=>{
 const h=await bridgeHarness({config:{socialV2:{rhythm:{enabled:false}}}});try{
 h.setMode('reserved2');fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify({notes,items:[]}));
 const st=h.getSocialV2State('private:123');st.experience=pref('123','Python 循环条件');st.recentMessages=[{seq:1,userId:'123',plain:'随便聊点',text:'随便聊点',time:now,directToAi:true}];st.unread=[st.recentMessages[0]];st.modelSeenSeqs=new Set([1]);
 const before=JSON.stringify([st.experience,st.recentMessages]);const hint=h.buildWakePromptV2('private:123','proactiveCheck');assert.match(hint,/当前对象的有依据经历/);assert.match(hint,/Python/);assert.equal(JSON.stringify([st.experience,st.recentMessages]),before);assert.equal(h.calls.sent.length,0);assert.equal(h.calls.prompts.length,0);
 const other=h.getSocialV2State('group:456');other.recentMessages=[{seq:1,userId:'456',text:'随便聊点',time:now,directToAi:true}];other.unread=other.recentMessages;other.modelSeenSeqs=new Set([1]);assert.doesNotMatch(h.livedContextV2('group:456',other),/当前对象的有依据经历/);
 }finally{await h.close();}
});
