import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {proactiveActivityProfile} from '../src/proactive-activity.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const MIN=60000, now=new Date('2026-10-10T14:00:00+08:00').getTime();
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
const deterministicMath=Object.create(Math);deterministicMath.random=()=>0;
const p={enabled:true,probability:0.3,dailyMaxPerKey:3,checkIntervalMinMs:20*MIN,checkIntervalMaxMs:45*MIN};
async function fixture(run){
 let handler;const fakeHttp={createServer(fn){handler=fn;const s=new EventEmitter();s.address=()=>({port:31999});s.listen=(_p,_h,cb)=>{s.listening=true;cb();return s;};return s;}};
 const h=await bridgeHarness({config:{socialV2:{proactive:p,mood:{enabled:true,nightDrainPerHour:0},rhythm:{enabled:true,hours:Array(24).fill(1),weekendShift:false},dailyState:{enabled:false},talkative:{enabled:false},affinity:{enabled:false,timeEnabled:false},sticker:{enabled:false}}},globals:{Date:Clock,Math:deterministicMath,http:fakeHttp}});
 h.request=(route,body)=>new Promise((resolve,reject)=>{const req=new EventEmitter();req.url=route;req.method=body?'POST':'GET';req.headers={host:'127.0.0.1:31999','x-console-token':'fixture-console-token','content-type':'application/json'};req.pause=()=>{};Promise.resolve(handler(req,{writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}})).catch(reject);if(body)queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});});
 h.setMode('reserved2');h.socialV2.mood={value:0,energy:80,updatedAt:now,log:[]};
 try{await run(h);}finally{await h.close();}
}
function ready(h){const st=h.getSocialV2State('private:123');st.lastIncomingAt=now-2*3600000;st.lastAiReplyAt=now-3*3600000;st.recentMessages=[];return st;}

test('high energy and active night-owl hours both allow a temporary boost, tired/busy/resting do not',()=>{
 const high=proactiveActivityProfile(p,{energy:80,rhythmFactor:1});
 assert.equal(high.energetic,true);assert.equal(high.dailyMax,5);assert.equal(high.checkIntervalMinMs,15*MIN);
 assert.equal(high.checkIntervalMaxMs,33.75*MIN);assert.equal(high.probabilityMultiplier,1.35);
 assert.equal(proactiveActivityProfile(p,{energy:60,rhythmFactor:1.2}).energetic,true);
 for(const state of [{energy:80,rhythmFactor:0.05},{energy:20,rhythmFactor:1.2},{energy:80,dailyFactor:0.3},{energy:80,mood:-40}]){
  const normal=proactiveActivityProfile(p,state);assert.equal(normal.energetic,false);assert.equal(normal.dailyMax,3);assert.equal(normal.checkIntervalMinMs,20*MIN);
 }
 assert.equal(proactiveActivityProfile({...p,activityBoost:false},{energy:100}).dailyMax,3);
 assert.equal(proactiveActivityProfile({...p,dailyMaxPerKey:0},{energy:100}).dailyMax,0);
});

test('actual scheduler uses boosted delay and suppresses timers when paused or disabled',async()=>fixture(async h=>{
 const st=ready(h);clearTimeout(st.proactiveTimer);st.proactiveTimer=null;
 h.scheduleProactiveCheckV2('private:123');assert.equal(st.proactiveTimer._idleTimeout,15*MIN);
 clearTimeout(st.proactiveTimer);st.proactiveTimer=null;h.socialV2.paused=true;h.scheduleProactiveCheckV2('private:123');assert.equal(st.proactiveTimer,null);
 h.socialV2.paused=false;h.cfg.socialV2.proactive.enabled=false;h.scheduleProactiveCheckV2('private:123');assert.equal(st.proactiveTimer,null);
}));

test('extra opportunities use the same persisted daily count and probability reverts when energy falls',async()=>fixture(async h=>{
 const st=ready(h);st.proactiveDay={key:'2026-10-10',count:3};
 const high=h.proactiveCheckTick('private:123',{dryRun:true});assert.equal(high.ok,true);assert.equal(high.dailyMax,5);assert.equal(st.proactiveDay.count,3);
 h.socialV2.mood.energy=60;const normal=h.proactiveCheckTick('private:123',{dryRun:true});assert.equal(normal.capReached,true);assert.equal(normal.dailyMax,3);assert.ok(high.prob>normal.prob);
 h.socialV2.mood.energy=80;st.proactiveDay.count=5;assert.equal(h.proactiveCheckTick('private:123',{dryRun:true}).capReached,true);
}));

test('contact spacing blocks repeated wakes but does not affect direct chat',async()=>fixture(async h=>{
 const st=ready(h);st.lastAiReplyAt=now-30*MIN;st.lastIncomingAt=now-20*MIN;
 let r=h.proactiveCheckTick('private:123',{dryRun:true});assert.match(r.why,/联系间隔/);assert.equal(r.contactGapMin,45);
 st.lastIncomingAt=now-120*MIN;st.lastAiReplyAt=now-60*MIN;st.recentMessages=[{isSelf:true,text:'我刚读到个有趣的解释',time:st.lastAiReplyAt}];
 r=h.proactiveCheckTick('private:123',{dryRun:true});assert.match(r.why,/联系间隔/);assert.equal(r.contactGapMin,90);
 assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);
}));

test('high energy never turns unanswered participation questions into reminders',async()=>fixture(async h=>{
 const st=ready(h);st.lastIncomingAt=now-180*MIN;st.lastAiReplyAt=now-120*MIN;
 st.recentMessages=[{userId:'123',text:'陪我聊会儿',time:st.lastIncomingAt},{isSelf:true,text:'你觉得这个角色该不该说实话？',time:st.lastAiReplyAt}];
 const result=h.proactiveCheckTick('private:123');assert.equal(result.ok,false);assert.match(result.why,/允许不答/);
 assert.equal(h.calls.prompts.length,0);assert.equal(st.followUpDay?.count||0,0);
}));

test('current night-owl rhythm boosts even with retired mood disabled, while low chat capacity blocks the boost',async()=>fixture(async h=>{
 const st=ready(h);h.cfg.socialV2.mood={enabled:false,proactiveLink:false};h.cfg.socialV2.rhythm.hours=Array(24).fill(1.2);
 st.patience=80;st.patienceAt=now;assert.equal(h.proactiveActivityV2(h.cfg.socialV2.proactive,st).energetic,true);
 st.patience=10;st.patienceAt=now;assert.equal(h.proactiveActivityV2(h.cfg.socialV2.proactive,st).energetic,false);
 assert.equal(h.cfg.socialV2.mood.enabled,false);assert.equal(h.cfg.socialV2.mood.proactiveLink,false);
}));

test('operator API and wake prompt expose effective behavior; zero probability and opt-out remain effective',async()=>fixture(async h=>{
 h.startConsoleServer();
 let result=await h.request('/api/socialV2/config');assert.equal(result.body.proactiveActivity.dailyMax,5);
 result=await h.request('/api/socialV2/config',{proactive:{activityBoost:false,dailyMaxPerKey:0}});assert.equal(result.status,200,JSON.stringify(result.body));
 result=await h.request('/api/socialV2/config');assert.equal(result.body.config.proactive.dailyMaxPerKey,0);assert.equal(result.body.proactiveActivity.energetic,false);
 const st=ready(h);h.cfg.socialV2.proactive.probability=0;
 assert.equal(h.proactiveCheckTick('private:123',{dryRun:true}).ok,false);
 h.cfg.socialV2.proactive.activityBoost=false;assert.equal(h.proactiveActivityV2().energetic,false);
 assert.match(h.buildWakePromptV2('private:123','proactiveCheck'),/精神好时.*找熟人/);
 assert.match(h.buildWakePromptV2('private:123','proactiveCheck'),/没有具体理由可以安静/);
 assert.equal(st.proactiveDay.count,0);
}));
