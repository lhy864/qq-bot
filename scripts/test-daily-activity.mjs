import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {dailyActivityWindow,dailyActivityQuery,dailyActivityContextNeeded,chooseLeisureItem,activityNotes,dailyActivityHint} from '../src/daily-activity.js';
import {createLeisure,leisureHint} from '../src/leisure.js';import {renameRoleReferences} from '../src/role-card.js';
import {materialSelection} from '../src/material-conversation.js';import {bridgeHarness} from './audit-bridge-harness.mjs';
const at=h=>Date.parse('2026-10-10T'+String(h).padStart(2,'0')+':00:00+08:00');
const items=[{id:'novel',kind:'reading',title:'模拟小说',url:'https://ncode.syosetu.com/n12345/1/',enabled:true,cursor:0,coverage:'原作片段'},
 {id:'study',kind:'study',title:'模拟计算机课',url:'https://cs50.harvard.edu/x/2026/notes/0/',enabled:true,cursor:0,coverage:'讲义片段'}];
const note=(item,time,extra={})=>({...item,id:'leisure-'+(item.kind==='study'?'a':'b').repeat(20),itemId:item.id,at:time,excerpt:'模拟实际读取片段'.repeat(150),summary:'模拟摘要',position:'在意具体例子',reason:'理由来自片段',question:'',...extra});
const notes=[note(items[1],at(9)),note(items[0],at(10))];
test('Shanghai windows favor daytime study and lunch/evening reading without making sleep a fact',()=>{
 for(const h of [9,11,14,17])assert.equal(dailyActivityWindow(at(h)).preferredKind,'study');
 for(const h of [12,13,18,23,0,2])assert.equal(dailyActivityWindow(at(h)).preferredKind,'reading');
 assert.equal(dailyActivityWindow(at(4)).preferredKind,'');assert.match(dailyActivityWindow(at(4)).description,/不由钟点推断/);
 assert.equal(dailyActivityWindow(at(23)).day,'2026-10-10');
});
test('automatic selection follows windows, rotates within a category, and respects explicit manual selection',()=>{
 assert.equal(chooseLeisureItem(items,{now:at(10)}).id,'study');assert.equal(chooseLeisureItem(items,{now:at(20)}).id,'novel');
 assert.equal(chooseLeisureItem([{...items[1],lastReadAt:1},{...items[1],id:'other',lastReadAt:0}],{now:at(10)}).id,'other');
 assert.equal(chooseLeisureItem(items,{now:at(10),manual:true,lastKind:'study'}).id,'novel');
 assert.equal(chooseLeisureItem([items[0]],{now:at(10)}).id,'novel');assert.equal(chooseLeisureItem([]),undefined);
});
test('generic activity questions prefer relevant actual records, but explicit work/category questions keep priority',()=>{
 assert(dailyActivityQuery('你最近在干嘛？'));assert(dailyActivityQuery('在干嘛'));assert(dailyActivityQuery('你现在忙什么'));assert(!dailyActivityQuery('我今天在干嘛'));assert(!dailyActivityQuery('你最近学习了什么'));
 const st={items,notes};assert.equal(materialSelection(notes,'你最近在干嘛',{now:at(11)})[0].kind,'study');
 assert.equal(materialSelection(notes,'你最近在干嘛',{now:at(20)})[0].kind,'reading');
 assert.equal(materialSelection(notes,'模拟小说讲什么',{now:at(11)})[0].kind,'reading');
 assert.equal(materialSelection(notes,'最近学计算机了吗',{now:at(20)})[0].kind,'study');
 assert.match(leisureHint(st,'你最近在干嘛',{now:at(11)}),/白天学习/);
 assert(dailyActivityContextNeeded('你一般白天跟晚上会做不一样的事吗？'));assert(dailyActivityContextNeeded('你平时也会学计算机吗？'));
 assert.match(leisureHint(st,'你一般白天跟晚上会做不一样的事吗？',{now:at(20)}),/可调整的打算/);
 assert.match(leisureHint(st,'你今天已经写代码练习过了？',{now:at(20)}),/没有保存的实际代码执行记录/);
 assert.match(leisureHint(st,'你平时也会学计算机吗？',{now:at(20)}),/自己的惯常行为也需要记录/);
});
test('actual activity overrides the preference when no matching record exists; stale and future notes are excluded',()=>{
 assert.equal(activityNotes([notes[1]],{now:at(11)})[0].kind,'reading');
 assert.equal(activityNotes([{...notes[0],at:at(12)},{...notes[1],at:at(11)-8*86400000}],{now:at(11)}).length,0);
 const h=dailyActivityHint([],{now:at(11)});assert.match(h,/没有可用的实际笔记/);assert.match(h,/倾向，不证明已经执行/);
 assert.match(dailyActivityHint(notes,{now:at(11),phase:'thinking',activeTitle:'实际小说'}),/正在处理的真实材料：实际小说/);
 assert.match(dailyActivityHint(notes,{now:at(23)}),/晚间放松/);assert.doesNotMatch(dailyActivityHint(notes,{now:at(23)}),/你已经睡了|该睡了/);
});
test('actual automatic runs change type by window and preserve settings, bookmarks, manual overrides and caps',async()=>{
 let saved={settings:{dailyLimit:3,minIntervalMinutes:60},items:structuredClone(items)},now=at(10),cost=0;
 const service=createLeisure({load:()=>saved,save:s=>{saved=structuredClone(s);},clock:()=>now,eligibility:()=>({ok:true,foregroundAt:0}),fetchArticle:async i=>({text:'模拟读取有效片段'.repeat(1000),url:i.url}),fetchContext:async()=>null,
 processExcerpt:async({excerpt})=>{cost++;return JSON.stringify({summary:'摘要',position:'倾向',reason:'理由',anchor:excerpt.slice(0,12),next:'continue'});}});
 assert.equal((await service.run()).itemId,'study');now=at(20);assert.equal((await service.run()).itemId,'novel');
 assert.equal(saved.items.find(i=>i.id==='study').cursor,1600);assert.equal(saved.items.find(i=>i.id==='novel').cursor,1600);
 assert.equal((await service.run({manual:true,itemId:'study'})).itemId,'study');assert.equal(saved.items.find(i=>i.id==='study').cursor,3200);
 assert.match((await service.run({manual:true})).reason,/上限/);const before=JSON.stringify(saved),calls=cost;
 assert.equal(service.status().activityWindow.label,'晚间放松');service.hint('你在干嘛');assert.equal(JSON.stringify(saved),before);assert.equal(cost,calls);
 service.edit({settings:{enabled:false}});assert.match((await service.run()).reason,/暂停/);assert.match(service.hint('你在干嘛'),/已暂停/);
});
test('service hints report live in-flight material instead of inventing current work from the hour',async()=>{
 let saved={items:[{...items[0]}]},release;const pending=new Promise(r=>{release=r;});
 const service=createLeisure({load:()=>saved,save:s=>{saved=structuredClone(s);},clock:()=>at(10),eligibility:()=>({ok:true,foregroundAt:0}),fetchContext:async()=>null,fetchArticle:async()=>pending,processExcerpt:async({excerpt})=>JSON.stringify({summary:'摘要',position:'观点',reason:'理由',anchor:excerpt.slice(0,12),next:'continue'})});
 const job=service.run();await new Promise(r=>setTimeout(r,0));assert.match(service.hint('你在干嘛'),/正在处理的真实材料：模拟小说/);
 release({text:'模拟真实片段'.repeat(600),url:items[0].url});await job;assert.match(service.hint('你在干嘛'),/当前没有后台阅读任务进行/);
});
test('role reference rename preserves mode, scoped cards and unrelated metadata',()=>{
 const before={role:'旧名字',mode:'silent',custom:{keep:true},perKey:{a:'旧名字',b:'另一张卡',c:null}},copy=structuredClone(before);
 assert.deepEqual(renameRoleReferences(before,'旧名字','新名字'),{...before,role:'新名字',perKey:{a:'新名字',b:'另一张卡',c:null}});assert.deepEqual(before,copy);
});
test('real role rename endpoint follows global and per-chat references and rejects damaged state before moving',async()=>{
 const h=await bridgeHarness();fs.mkdirSync(h.temp+'/roles');fs.writeFileSync(h.temp+'/roles/旧名字.md','## 性格主轴：爱玩、愿意陪聊、嘴硬心软\n测试角色');
 const state={role:'旧名字',mode:'active',other:'保留',perKey:{'private:123':'旧名字','private:456':'别的卡'}};fs.writeFileSync(h.temp+'/state/current-role.json',JSON.stringify(state));
 const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const rename=(from,to)=>fetch(base+'/api/roles/rename',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({from,to})});
 try{const res=await rename('旧名字','新名字');assert.equal(res.status,200);assert.equal((await res.json()).perKeyFollowed,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(h.temp+'/state/current-role.json','utf8')),renameRoleReferences(state,'旧名字','新名字'));
 assert.match(h.currentRoleHintV2('private:123'),/测试角色/);assert(!fs.existsSync(h.temp+'/roles/旧名字.md'));
 fs.writeFileSync(h.temp+'/state/current-role.json','{damaged');const failed=await rename('新名字','第三个名字');assert.notEqual(failed.status,200);assert(fs.existsSync(h.temp+'/roles/新名字.md'));assert(!fs.existsSync(h.temp+'/roles/第三个名字.md'));
 }finally{server.close();await h.close();}
});
test('real wake/current tool paths expose actual daytime activities while removing unrelated anime defaults',async()=>{
 const now=at(11);class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const h=await bridgeHarness({globals:{Date:Clock},config:{socialV2:{rhythm:{enabled:false},anime:{enabled:true}}}});h.setMode('reserved2');h.setReady(true);
 try{fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify({items,notes}));
 const st=h.getSocialV2State('private:123');st.recentMessages=[{seq:1,userId:'123',text:'你最近在干嘛',plain:'你最近在干嘛',time:now,directToAi:true}];st.unread=[st.recentMessages[0]];
 const before=JSON.stringify(st.recentMessages);assert.match(h.currentConversationV2('private:123',st,st.unread).hint,/白天学习/);
 assert.match(h.livedContextV2('private:123',st),/模拟计算机课/);assert.doesNotMatch(h.buildWakePromptV2('private:123','message'),/【番剧兴趣与模拟进度】/);
 assert.match(h.buildWakePromptV2('private:123','proactiveCheck'),/白天学习/);assert.equal(JSON.stringify(st.recentMessages),before);assert.equal(h.calls.sent.length,0);assert.equal(h.calls.prompts.length,0);
 }finally{await h.close();}
});
