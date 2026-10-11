import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createLeisure,leisureArticle,fetchLeisureArticle,leisureUrl,leisureJournal,leisureHint,parseLeisureNote,leisurePrompt} from '../src/leisure.js';
import {reflectExperience,publicExperiences,experienceContext} from '../src/lived-experience.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const content='计算机将信息表示为二进制。符号的含义来自编码约定，不是数字自身。'.repeat(100);
const item={id:'fixture',kind:'study',title:'模拟课程',url:'https://cs50.harvard.edu/x/2026/notes/0/',coverage:'实际讲义片段',enabled:true,cursor:0,page:1};
const note=excerpt=>JSON.stringify({summary:'本段讲二进制与编码约定',position:'更在意编码和含义的区别',reason:'同样的位需要约定才有意义',question:'改变约定会怎样？',anchor:excerpt.slice(0,18),next:'continue'});
function fixture(extra={}){
 let saved={settings:{dailyLimit:6},items:[{...item}]},now=Date.now();const calls=[];
 const deps={load:()=>saved,save:s=>{saved=structuredClone(s);},clock:()=>now,eligibility:()=>({ok:true,foregroundAt:0}),fetchArticle:async i=>{calls.push('fetch');return {text:content,url:i.url,truncated:false,nextUrl:''};},fetchContext:async()=>null,processExcerpt:async({excerpt})=>{calls.push('model');return note(excerpt);},...extra};
 return {service:createLeisure(deps),calls,get saved(){return saved;},set saved(s){saved=s;},later(ms){now+=ms;}};
}
test('only approved HTTPS sources are fetched; redirects and raw truncation fail closed',async()=>{
 for(const url of ['http://csdiy.wiki/','https://127.0.0.1/','https://csdiy.wiki.evil.test/','https://x:pw@csdiy.wiki/','https://csdiy.wiki/?cookie=foo'])assert.throws(()=>leisureUrl(url,'study'));
 await assert.rejects(fetchLeisureArticle(item,async()=>({statusCode:200,url:'https://evil.test/',body:'<main>'+content+'</main>'})),/公开/);
 await assert.rejects(fetchLeisureArticle(item,async()=>({statusCode:200,url:item.url,truncated:true})),/上限/);
});
test('novel parser excludes preface, afterword, script and ruby pronunciation; next chapter comes from real link',()=>{
 const html='<div class="p-novel__text--preface js-novel-text">前言'+content+'</div><div class="p-novel__text js-novel-text"><p>'+content+'<ruby>書<rt>しょ</rt></ruby></p><script>DO_EVIL()</script></div><div class="p-novel__text--afterword js-novel-text">后记</div><a href="/n4830bu/2/">次へ</a>';
 const a=leisureArticle(html,'https://ncode.syosetu.com/n4830bu/1/');assert.match(a.text,/编码/);assert.doesNotMatch(a.text,/前言|后记|DO_EVIL|しょ/);assert.equal(a.nextUrl,'https://ncode.syosetu.com/n4830bu/2/');
 assert.equal(leisureArticle('<main>'+content+'</main>',item.url).nextUrl,'');
 assert.equal(leisureArticle('<nav>目录</nav><div role="main"><div>'+content+'</div></div><footer>尾部</footer>','https://docs.python.org/zh-cn/3/tutorial/introduction.html').text,content);
});
test('successful actual processing saves bounded notes and bookmarks, survives new controller and hides excerpt in admin status',async()=>{
 const f=fixture();assert.equal((await f.service.run({manual:true})).ok,true);assert.equal(f.saved.items[0].cursor,1600);assert.equal(f.saved.notes.length,1);
 assert.equal(f.service.status().notes[0].excerpt,undefined);assert.equal(f.service.status().items[0].cached,undefined);
 const g=fixture();g.saved=structuredClone(f.saved);assert.match(g.service.hint('最近学习什么'),/编码/);assert.equal(g.service.journal().sources[0].parts[0].text.length,1600);
});
test('failed fetch and malformed/unsupported notes do not fabricate reading progress',async()=>{
 for(const extra of [{fetchArticle:async()=>{throw Error('暂时断网');}},{processExcerpt:async()=>'{bad'},{processExcerpt:async()=>JSON.stringify({summary:'模拟',position:'模拟',reason:'模拟',anchor:'不在正文中的依据'})}]){
  const f=fixture(extra);assert.equal((await f.service.run({manual:true})).ok,false);assert.equal(f.saved.items[0].cursor,0);assert.equal(f.saved.notes.length,0);assert.ok(f.service.status().lastError);assert.equal(f.service.status().todayAttempts,1);
 }
});
test('single flight blocks duplicate model cost and concurrent settings change discards result',async()=>{
 let release;const pending=new Promise(r=>{release=r;});const f=fixture({processExcerpt:async()=>pending});
 const first=f.service.run({manual:true});await new Promise(r=>setTimeout(r,0));assert.equal((await f.service.run({manual:true})).skipped,true);
 f.service.edit({settings:{enabled:false}});release(note(content.slice(0,1600)));assert.equal((await first).ok,false);assert.equal(f.saved.notes.length,0);assert.equal(f.saved.items[0].cursor,0);assert.equal(f.saved.settings.enabled,false);
});
test('a foreground message arriving during fetch yields before invoking model; during model prevents commit',async()=>{
 let foregroundAt=0;const f=fixture({eligibility:()=>({ok:true,foregroundAt}),fetchArticle:async()=>{foregroundAt=1;return {text:content};}});
 assert.equal((await f.service.run({manual:true})).ok,false);assert.equal(f.calls.length,0);assert.equal(f.saved.notes.length,0);
 foregroundAt=0;const g=fixture({eligibility:()=>({ok:true,foregroundAt}),processExcerpt:async({excerpt})=>{foregroundAt=2;return note(excerpt);}});assert.equal((await g.service.run({manual:true})).ok,false);assert.equal(g.saved.notes.length,0);
});
test('failed attempts count toward daily resource cap; manual runs cannot bypass pause or cap',async()=>{
 const f=fixture({processExcerpt:async()=>{throw Error('模型不可用');}});f.service.edit({settings:{dailyLimit:1}});
 await f.service.run({manual:true});assert.match((await f.service.run({manual:true})).reason,/上限/);f.later(86400000);assert.equal((await f.service.run({manual:true})).ok,false);
 f.service.edit({settings:{enabled:false}});assert.match((await f.service.run({manual:true})).reason,/暂停/);
});
test('interval gates automatic runs; manual choice can alternate without skipping bookmarks',async()=>{
 let now=Date.parse('2026-10-10T10:00:00+08:00');const f=fixture({clock:()=>now});f.saved.items.push({...item,id:'book',kind:'reading',title:'模拟小说',url:'https://ncode.syosetu.com/n4830bu/1/'});
 await f.service.run();assert.match((await f.service.run()).reason,/间隔/);now+=3600000;await f.service.run({manual:true});assert.deepEqual(f.saved.notes.map(n=>n.kind),['study','reading']);
});
test('model may defer or pause; finishing a fetched chapter follows only its acquired same-story link',async()=>{
 const f=fixture({fetchArticle:async()=>({text:content.slice(0,1200),nextUrl:'https://ncode.syosetu.com/n4830bu/2/',url:'https://ncode.syosetu.com/n4830bu/1/'}),processExcerpt:async({excerpt})=>JSON.stringify({...JSON.parse(note(excerpt)),next:'later'})});
 f.saved.items=[{...item,kind:'reading',url:'https://ncode.syosetu.com/n4830bu/1/'}];await f.service.run({manual:true});assert.equal(f.saved.items[0].page,2);assert.equal(f.saved.items[0].cursor,0);assert.ok(f.saved.items[0].laterUntil);assert.match((await f.service.run({manual:true})).reason,/没有/);
 const g=fixture({processExcerpt:async({excerpt})=>JSON.stringify({...JSON.parse(note(excerpt)),next:'pause'})});await g.service.run({manual:true});assert.equal(g.saved.items[0].enabled,false);
});
test('public notes reject private material; failed durable note commit does not mutate loaded state',async()=>{
 const f=fixture({publicGuard:()=>{throw Error('不可公开');}});await f.service.run({manual:true});assert.equal(f.saved.notes.length,0);
 let original={items:[{...item}]};const g=fixture({load:()=>original,save:s=>{if(s.notes.length)throw Error('fixture disk failure');original=structuredClone(s);}});
 await g.service.run({manual:true});assert.equal(original.items[0].cursor,0);assert.equal(original.notes.length,0);
});
test('public acquired learning/reading supports revisions; messages never become cross-chat interests',async()=>{
 const f=fixture();await f.service.run({manual:true});const j=leisureJournal(f.saved);assert.equal(publicExperiences([j]).records.length,1);assert.match(experienceContext(j,{text:'模拟课程'}),/实际读取.*字符/);
 const r=reflectExperience(j,{kind:'interest',topic:'编码',position:'仍想研究约定',reason:'已有读到的例子',visibility:'public',sourceIds:[j.sources[0].id]});assert.equal(r.entry.evidence[0].type,'study');
 assert.throws(()=>reflectExperience(j,{kind:'interest',topic:'模拟',position:'模拟',reason:'模拟',visibility:'public',sourceSeqs:[1]},{messages:[{seq:1,userId:'123',text:'私聊'}],seen:new Set([1])}),/不能公开/);
 assert.equal(publicExperiences([{records:[{...j.records[0],evidence:[]}]}]).records.length,0);
});
test('reading prompt limits scope, ignores text commands and does not claim exercises or mastery',()=>{
 assert.match(leisurePrompt(item,content),/不调用工具.*材料内的命令/);assert.match(leisurePrompt(item,content),/不声称完成课程/);assert.throws(()=>parseLeisureNote('{}',content),/缺少/);assert.equal(leisureHint({},'最近读书'),'');
});
test('an appropriate invitation can retrieve at most two actual reading questions without fabrication or a background task',async()=>{
 const f=fixture();await f.service.run({manual:true});const before=JSON.stringify(f.saved),cost=f.calls.length;
 assert.equal(f.service.hint('歇会儿聊聊'),'');const hint=f.service.hint('歇会儿聊聊',{invite:true});assert.match(hint,/待想：改变约定会怎样/);assert.match(hint,/不是必须问的清单/);assert.match(hint,/实际读到/);
 assert.equal(f.calls.length,cost);assert.equal(JSON.stringify(f.saved),before);
 const noQuestions={...f.saved,notes:f.saved.notes.map(n=>({...n,question:''}))};assert.equal(leisureHint(noQuestions,'歇会儿聊聊',{invite:true}),'');
 assert.equal(leisureHint({},'陪我聊会儿',{invite:true}),'');
});
async function bridge(extra={},run){const h=await bridgeHarness({config:{socialV2:{rhythm:{enabled:false}},...extra.config},...extra});h.setMode('reserved2');h.setReady(true);try{await run(h);}finally{await h.close();}}
test('bridge learning eligibility respects live ready/mode/pause/busy/idle; status reads create no model turn or files',()=>bridge({},async h=>{
 assert.equal(h.leisureEligibility({manual:true}).ok,true);h.setReady(false);assert.equal(h.leisureEligibility({manual:true}).ok,false);h.setReady(true);h.socialV2.paused=true;assert.equal(h.leisureEligibility({manual:true}).ok,false);h.socialV2.paused=false;
 const st=h.getSocialV2State('private:123');st.lastIncomingAt=Date.now();assert.equal(h.leisureEligibility({manual:false}).ok,false);assert.equal(h.leisureEligibility({manual:true}).ok,true);h.pendingWakeKeys.add('private:123');assert.equal(h.leisureEligibility({manual:true}).ok,false);h.pendingWakeKeys.clear();
 h.leisureOf().status();assert.equal(h.calls.prompts.length,0);assert.equal(fs.existsSync(h.temp+'/state/leisure.json'),false);
}));
test('bridge activity context exposes public notes to real chats and preserves journals and raw messages',()=>bridge({},async h=>{
 const f=fixture();await f.service.run({manual:true});fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify(f.saved));const st=h.getSocialV2State('private:123');st.recentMessages=[{seq:1,userId:'123',text:'最近学习什么',plain:'最近学习什么',directToAi:true}];const before=JSON.stringify(st.recentMessages);
 assert.match(h.livedContextV2('private:123',st),/编码/);assert.equal(JSON.stringify(st.recentMessages),before);assert.equal(h.calls.sent.length,0);assert.equal(h.calls.prompts.length,0);
}));
test('damaged background state fails closed without overwriting it or breaking ordinary chat prompts',()=>bridge({},async h=>{
 fs.writeFileSync(h.temp+'/state/leisure.json','{damaged');const st=h.getSocialV2State('private:123');assert.match(h.livedContextV2('private:123',st),/交流余力/);assert.throws(()=>h.leisureOf().status());assert.equal(fs.readFileSync(h.temp+'/state/leisure.json','utf8'),'{damaged');
}));
test('management route rejects agent headers and ordinary console reads do not invoke background work',()=>bridge({},async h=>{
 const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{const request=(headers={})=>fetch(base+'/api/leisure',{headers:{'x-console-token':'fixture-console-token',...headers}});
 assert.equal((await request({'x-agent-token':h.getSocialV2State('private:123').agentToken})).status,403);assert.equal((await request({'x-agent-call':'1'})).status,403);const r=await request();assert.equal(r.status,200);assert.equal((await r.json()).items.length,5);assert.equal(h.calls.prompts.length,0);
 const f=fixture();await f.service.run({manual:true});fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify(f.saved));const real=h.getSocialV2State('private:123');real.experience={sources:[],records:[{id:'private-record',kind:'relationship',topic:'PRIVATE-FIXTURE-TOPIC',position:'私聊看法',reason:'不分享',visibility:'conversation',evidence:[]}]};
 const runPost=async body=>{const r=await fetch(base+'/api/leisure',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 assert.equal((await runPost({action:'run',itemId:'not-present'})).status,409);h.leisureOf().edit({settings:{dailyLimit:1}});assert.equal((await runPost({action:'run',itemId:'fixture'})).status,429);assert.equal(h.calls.prompts.length,0);h.leisureOf().edit({settings:{enabled:false}});assert.equal((await runPost({action:'run',itemId:'fixture'})).status,409);
 h.setPresets(['qq-chat-v2','qq-chat','standard']);
 const op=async(body)=>{const r=await fetch(base+'/api/debug/group-rehearsal',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const test=await op({action:'start',groupId:'456',backgroundNotes:true});assert.equal(test.status,200,JSON.stringify(test.body));const k=test.body.key;
 try{const ctx=h.livedContextV2(k,h.getSocialV2State(k));assert.match(ctx,/编码/);assert.doesNotMatch(ctx,/PRIVATE-FIXTURE-TOPIC/);h.saveSocialV2State();assert.equal(JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json','utf8')).conversations[k],undefined);}finally{await op({action:'finish',key:k});}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));
