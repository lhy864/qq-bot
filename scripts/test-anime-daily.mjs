import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {advanceAnimeDaily,animeDaySummary,animeCatalogItems,animeDayKey} from '../src/anime-progress.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const now=new Date(2026,9,10,14).getTime();
const original={day:'2026-10-09',advancedToday:9,watching:[{title:'模拟A',watched:3,total:24},{title:'手动加入B',watched:2,total:12}],queue:[{title:'推荐C',total:13,priority:90,recommendedBy:'fixture-user'}],finished:[],history:[],custom:'preserve'};
test('daily completion finishes a whole series, replenishes in priority order and preserves other manual progress',()=>{
 const r=advanceAnimeDaily(original,{now,maxWatching:2,catalog:[{title:'库D',total:12}]});
 assert.equal(r.result.completed,1);assert.equal(r.result.episodes,21);assert.equal(r.result.completedToday,1);assert.equal(r.state.advancedToday,21);
 assert.equal(r.state.watching[0].title,'手动加入B');assert.equal(r.state.watching[0].watched,2);assert.equal(r.state.watching[1].title,'推荐C');
 assert.equal(r.state.history[0].episodes,21);assert.equal(r.state.finished[0].simulation,true);assert.equal(r.state.custom,'preserve');assert.equal(original.watching[0].watched,3);
 assert.equal(advanceAnimeDaily(r.state,{now}).changed,false);
});
test('completion goal survives repeated checks and restarts; next day advances without erasing history',()=>{
 const first=advanceAnimeDaily(original,{now});const saved=JSON.parse(JSON.stringify(first.state));
 assert.equal(advanceAnimeDaily(saved,{now}).result.goalMet,true);
 const next=advanceAnimeDaily(saved,{now:now+86400000});assert.equal(next.result.completedToday,1);assert.equal(next.state.finished.length,2);
 assert.equal(next.state.history.length,2);assert.equal(next.state.advancedToday,10);
});
test('drops do not fulfill the goal and unavailable queues remain explicit',()=>{
 const state={finished:[{title:'弃番',total:12,watched:4,dropped:true,at:now}],watching:[],queue:[]};
 assert.equal(animeDaySummary(state,{now}).completedToday,0);assert.equal(advanceAnimeDaily(state,{now}).changed,false);
 assert.match(advanceAnimeDaily(state,{now}).result.why,/暂无可追/);
 const recovered=advanceAnimeDaily({...state,queue:[{title:'弃番'},{title:''}]},{now,catalog:[{title:'新番',total:12}]});
 assert.equal(recovered.result.completed,1);assert.equal(recovered.state.finished.at(-1).title,'新番');
});
test('catalog reader reconciles legacy arrays/items/list without losing entries',()=>{
 assert.equal(animeCatalogItems([{title:'A'}]).length,1);
 assert.deepEqual(animeCatalogItems({items:[{title:'A',total:12}],list:[{title:'A',total:24},{title:'B'}]}).map(x=>[x.title,x.total]),[['A',24],['B',undefined]]);
});
async function fixture(run,{failWrites=false}={}){
 let handler,block=false;const periods=[];
 const fakeHttp={createServer(fn){handler=fn;const s=new EventEmitter();s.address=()=>({port:31999});s.listen=(_p,_h,cb)=>{s.listening=true;cb();return s;};return s;}};
 const fakeFs={...fs,renameSync(...args){if(block)throw Object.assign(new Error('fixture write rejected'),{code:'EIO'});return fs.renameSync(...args);}};
 const h=await bridgeHarness({config:{socialV2:{anime:{enabled:true,perDayMax:2,maxWatching:2},rhythm:{enabled:false},dailyState:{enabled:true,current:'busy'},sticker:{enabled:false}}},globals:{http:fakeHttp,...(failWrites?{fs:fakeFs}:{}),setInterval(fn,ms){periods.push({fn,ms});return {unref(){}};}}});
 h.setMode('reserved2');h.startConsoleServer();fs.writeFileSync(h.temp+'/state/anime.json',JSON.stringify({...original,day:animeDayKey(),advancedToday:0}));
 h.request=(url,body)=>new Promise((resolve,reject)=>{const req=new EventEmitter();req.method=body?'POST':'GET';req.url=url;req.headers={host:'127.0.0.1:31999','x-console-token':'fixture-console-token','content-type':'application/json'};req.pause=()=>{};Promise.resolve(handler(req,{writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}})).catch(reject);if(body)queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});});
 try{await run(h,{periods,setWriteFailure:value=>{block=value;}});}finally{await h.close();}
}
test('background timer is connected; GET is read-only and both control views use saved episode/completion counts',async()=>fixture(async(h,{periods})=>{
 const raw=fs.readFileSync(h.temp+'/state/anime.json','utf8');const before=await h.request('/api/socialV2/anime-admin');assert.equal(before.body.today,0);assert.equal(fs.readFileSync(h.temp+'/state/anime.json','utf8'),raw);
 const timer=periods.find(x=>x.ms===60000&&String(x.fn).includes('animeAutoAdvanceToday'));assert.ok(timer);timer.fn();
 const panel=await h.request('/api/socialV2/anime-admin'),summary=await h.request('/api/debug/selftest',{anime:'status'});
 assert.equal(panel.body.today,21);assert.equal(summary.body.today,21);assert.equal(panel.body.automation.completedToday,1);assert.equal(summary.body.automation.completedToday,1);
 assert.equal(panel.body.timeline.at(-1).count,21);assert.equal(JSON.parse(fs.readFileSync(h.temp+'/state/anime.json')).finished.length,1);
 assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);assert.match(h.animeMoodText(),/不能说亲身看完/);
}));
test('disabled/paused/offline/resting automation does not progress; busy simulated daily status cannot cancel the daily minimum',async()=>fixture(async h=>{
 h.socialV2.paused=true;assert.equal(h.animeAutoAdvanceToday().ok,false);h.socialV2.paused=false;
 h.setReady(false);assert.equal(h.animeAutoAdvanceToday().ok,false);h.setReady(true);
 h.cfg.socialV2.anime.enabled=false;assert.equal(h.animeAutoAdvanceToday().ok,false);h.cfg.socialV2.anime.enabled=true;
 h.cfg.socialV2.rhythm={enabled:true,hours:Array(24).fill(0.05)};assert.equal(h.animeAutoAdvanceToday().ok,false);
 h.cfg.socialV2.rhythm.enabled=false;assert.equal(h.animeAutoAdvanceToday().completed,1);assert.equal(h.animeAutoAdvanceToday().completedToday,1);
}));
test('failed state commit leaves memory and disk untouched and can retry once',async()=>fixture(async(h,{setWriteFailure})=>{
 const before=fs.readFileSync(h.temp+'/state/anime.json','utf8');setWriteFailure(true);assert.equal(h.animeAutoAdvanceToday().ok,false);
 assert.equal(h.loadAnime().finished.length,0);assert.equal(fs.readFileSync(h.temp+'/state/anime.json','utf8'),before);
 setWriteFailure(false);assert.equal(h.animeAutoAdvanceToday().completed,1);assert.equal(h.animeAutoAdvanceToday().completedToday,1);
},{failWrites:true}));
test('catalog add/delete and daily goal parameters round-trip through the real operator API',async()=>fixture(async h=>{
 fs.writeFileSync(h.temp+'/state/anime-catalog.json',JSON.stringify({version:7,items:[{title:'A',total:12}],list:[{title:'B',total:13}]}));
 assert.equal((await h.request('/api/socialV2/anime-admin',{action:'addCatalog',title:'C',total:14})).body.ok,true);
 assert.equal((await h.request('/api/socialV2/anime-admin')).body.catalog.length,3);
 await h.request('/api/socialV2/anime-admin',{action:'delCatalog',title:'B'});assert.deepEqual(h.animeCatalog().map(x=>x.title),['A','C']);
 const saved=JSON.parse(fs.readFileSync(h.temp+'/state/anime-catalog.json'));assert.equal(saved.version,7);assert.equal(saved.list,undefined);
 await h.request('/api/socialV2/anime-admin',{action:'params',dailyCompletionTarget:1});assert.equal((await h.request('/api/socialV2/anime-admin')).body.params.dailyCompletionTarget,1);
}));
