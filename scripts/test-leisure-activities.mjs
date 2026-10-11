import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createLeisure,leisureHint,leisureJournal} from '../src/leisure.js';
import {runLearningPractice,practiceEvidence} from '../src/learning-practice.js';
import {readingQuestions} from '../src/reading-questions.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const python=process.env.QQ_BRIDGE_PYTHON||'python';
const item={id:'practice-fixture',kind:'study',title:'Python 官方教程 · 隔离资料',url:'https://docs.python.org/zh-cn/3/tutorial/introduction.html',coverage:'模拟取得的教程片段',enabled:true,cursor:0};
const text='这是隔离教程。for 循环使用 range，结束值不会包含在结果里。'.repeat(180);
const json=excerpt=>JSON.stringify({summary:'循环与结束边界',position:'想试一试边界差异',reason:'例子可以对照',question:'多取一个数会差多少？',anchor:excerpt.slice(0,18)});
function fixture(extra={}){let saved={settings:{dailyLimit:6},items:[{...item}]},now=Date.now();const calls={model:0,practice:0};const deps={load:()=>saved,save:s=>saved=structuredClone(s),eligibility:()=>({ok:true,foregroundAt:0}),clock:()=>now,fetchArticle:async()=>({text,url:item.url}),fetchContext:async()=>null,processExcerpt:async({excerpt})=>{calls.model++;return json(excerpt);},runPractice:async(input,opts)=>{calls.practice++;return runLearningPractice(input,{...opts,python});},...extra};return {service:createLeisure(deps),calls,get saved(){return saved;},set saved(s){saved=s;},later(ms){now+=ms;}};}
test('real fixed execution commits beside reading, survives reload and appears in prompt without new foreground work',async()=>{
 const f=fixture();assert.equal((await f.service.run({manual:true})).ok,true);const n=f.saved.notes[0];assert.equal(practiceEvidence(n).stdout,'45\n55');assert.equal(f.saved.items[0].cursor,1600);assert.equal(f.service.status().notes[0].practice.status,'succeeded');
 const g=fixture();g.saved=JSON.parse(JSON.stringify(f.saved));const before=JSON.stringify(g.saved);assert.match(g.service.hint('你实际跑过什么练习？'),/成功 1 次/);assert.match(leisureHint(g.saved,'Python 循环'),/45\\n55/);assert.equal(g.calls.practice,0);assert.equal(JSON.stringify(g.saved),before);assert.equal(leisureJournal(g.saved).sources[0].parts.length,2);
 assert.equal((await g.service.run({manual:true})).ok,true);assert.equal(g.calls.practice,0);assert.equal(g.saved.notes.length,2);
 const h=await bridgeHarness({});try{fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify(f.saved));const st=h.getSocialV2State('private:123');st.recentMessages=[{seq:1,userId:'123',text:'你实际跑过什么练习？',plain:'你实际跑过什么练习？'}];assert.match(h.livedContextV2('private:123',st),/成功 1 次/);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);}finally{await h.close();}
});
test('practice disabled, unrelated source and model failure never execute',async()=>{
 const f=fixture();f.service.edit({settings:{practiceEnabled:false}});await f.service.run({manual:true});assert.equal(f.calls.practice,0);assert.equal(f.saved.notes[0].practice,undefined);
 const g=fixture({processExcerpt:async()=>{throw Error('模型失败');}});assert.equal((await g.service.run({manual:true})).ok,false);assert.equal(g.calls.practice,0);assert.equal(g.saved.items[0].cursor,0);
 const a=fixture({fetchArticle:async()=>({text,url:'https://csdiy.wiki/'})});a.saved.items[0].url='https://csdiy.wiki/';await a.service.run({manual:true});assert.equal(a.calls.practice,0);
});
test('failed execution is an honest attempt; reading may advance, bounded later retry can succeed',async()=>{
 const f=fixture({runPractice:async(input,opts)=>runLearningPractice(input,{...opts,python:'missing-qq-python-executable'})});assert.equal((await f.service.run({manual:true})).ok,true);assert.equal(f.saved.notes[0].practice.status,'failed');assert.match(f.service.hint('你实际跑过什么？'),/成功 0 次/);assert.equal(f.service.status().notes[0].practice.error,'未找到 Python 解释器');
 const g=fixture();g.saved=structuredClone(f.saved);await g.service.run({manual:true});assert.equal(g.saved.notes.at(-1).practice.status,'succeeded');
});
test('pause or new foreground input during real execution discards result and does not advance',async()=>{
 for(const kind of ['pause','foreground']){let f,foregroundAt=0;f=fixture({eligibility:()=>({ok:true,foregroundAt}),runPractice:async(input,opts)=>{assert.equal(f.service.status().phase,'practicing');const p=await runLearningPractice(input,{...opts,python});if(kind==='pause')f.service.edit({settings:{enabled:false}});else foregroundAt=1;return p;}});assert.equal((await f.service.run({manual:true})).ok,false);assert.equal(f.saved.notes.length,0);assert.equal(f.saved.items[0].cursor,0);}
});
test('single flight prevents duplicate attempts and failed durable save cannot expose completion',async()=>{
 let release;const barrier=new Promise(r=>release=r);const f=fixture({runPractice:async(input,opts)=>{await barrier;return runLearningPractice(input,{...opts,python});}});const pending=f.service.run({manual:true});await new Promise(r=>setTimeout(r,10));assert.equal((await f.service.run({manual:true})).skipped,true);release();await pending;assert.equal(f.saved.notes.length,1);assert.equal(f.saved.attempts.length,1);
 let disk={items:[{...item}]};const g=fixture({load:()=>disk,save:s=>{if(s.notes.length)throw Error('磁盘失败');disk=structuredClone(s);}});assert.equal((await g.service.run({manual:true})).ok,false);assert.equal(disk.notes.length,0);assert.equal(disk.items[0].cursor,0);assert.equal(g.service.status().notes.length,0);
});
test('cap, idle and Shanghai midnight keep attempts bounded without resetting progress',async()=>{
 let now=Date.parse('2026-10-10T23:59:30+08:00');const f=fixture({clock:()=>now});f.service.edit({settings:{dailyLimit:1}});await f.service.run({manual:true});assert.match((await f.service.run({manual:true})).reason,/上限/);now+=60000;assert.equal(f.service.status().todayAttempts,0);assert.equal((await f.service.run({manual:true})).ok,true);assert.equal(f.saved.items[0].cursor,3200);
 const g=fixture({eligibility:()=>({ok:false,reason:'还没空闲'})});assert.equal((await g.service.run()).skipped,true);assert.equal(g.calls.model,0);assert.equal(g.calls.practice,0);
});
test('later acquired excerpt updates original doubt, reload retains explanation, invalid anchor cannot advance',async()=>{
 const f=fixture();await f.service.run({manual:true});const original=f.saved.notes[0];const g=fixture({processExcerpt:async({excerpt,previous})=>JSON.stringify({...JSON.parse(json(excerpt)),question:'',questionUpdate:{previousNoteId:previous[0].id,status:'answered',explanation:'结束值不包含，1至9和1至10相差10',anchor:excerpt.slice(0,18)}})});g.saved=JSON.parse(JSON.stringify(f.saved));assert.equal((await g.service.run({manual:true})).ok,true);const q=readingQuestions(g.saved.notes,item.id)[0];assert.equal(q.id,original.id);assert.equal(q.status,'answered');assert.equal(g.service.status().notes[0].questionState.status,'answered');assert.match(g.service.hint('Python'),/原问题的实际进展/);
 const bad=fixture({processExcerpt:async({excerpt})=>JSON.stringify({...JSON.parse(json(excerpt)),questionUpdate:{previousNoteId:original.id,status:'answered',explanation:'没依据',anchor:'不在资料中的答案'}})});bad.saved=structuredClone(f.saved);assert.equal((await bad.service.run({manual:true})).ok,false);assert.equal(bad.saved.notes.length,1);assert.equal(bad.saved.items[0].cursor,1600);
});
test('invalid stored execution cannot leak fake success into UI or chat evidence',async()=>{
 const f=fixture();await f.service.run({manual:true});f.saved.notes[0].practice.stdout='999';assert.equal(f.service.status().notes[0].practice,undefined);assert.doesNotMatch(f.service.hint('Python'),/实际固定小练习与结果/);assert.match(f.service.hint('你实际跑过什么？'),/没有保存的实际代码执行记录/);
});
