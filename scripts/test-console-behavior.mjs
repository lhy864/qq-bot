import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const html=fs.readFileSync(new URL('../public/console.html',import.meta.url),'utf8');
const apiCode=html.slice(html.indexOf('let consoleAuthPrompt ='),html.indexOf('function esc(s)'));
function apiHarness(promptValue){
  const values=new Map([['consoleToken','old']]);let prompts=0,requests=0;
  const context=vm.createContext({URLSearchParams,JSON,Error,Promise,localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},prompt:()=>{prompts++;return promptValue;},fetch:async(_url,init)=>{requests++;return init.headers['x-console-token']==='new'?{status:200,json:async()=>({ok:true})}:{status:401};}});
  vm.runInContext(apiCode,context);
  return {context,api:context.api,get prompts(){return prompts;},get requests(){return requests;}};
}
test('concurrent expired-token requests share one prompt and retry with the refreshed token',async()=>{
  const h=apiHarness(' new ');const results=await Promise.all([h.api('/a'),h.api('/b'),h.api('/c')]);
  assert(results.every(r=>r.ok));assert.equal(h.prompts,1);
});
test('cancelling token entry suppresses polling prompts until an explicit retry',async()=>{
  const h=apiHarness(null);await Promise.allSettled([h.api('/a'),h.api('/b'),h.api('/c')]);
  assert.equal(h.prompts,1);const before=h.requests;await assert.rejects(h.api('/again'),/未授权/);assert.equal(h.requests,before);
  vm.runInContext('consoleAuthCancelled=false',h.context);await assert.rejects(h.api('/manual'),/未授权/);assert.equal(h.prompts,2);
});
test('experience rendering escapes model text and marks resolved/expired feelings as history',()=>{
  const from=html.indexOf('function esc(s)'),to=html.indexOf('// 上游静默',from);
  const rfrom=html.indexOf('function renderExperienceJournal('),rto=html.indexOf('function loadV2Memory(',rfrom);
  const context=vm.createContext({Date});vm.runInContext(html.slice(from,to)+html.slice(rfrom,rto),context);
  const output=context.renderExperienceJournal({records:[{kind:'feeling',topic:'<script>bad</script>',position:'<img src=x>',reason:'"reason"',resolved:true,evidence:[],revisions:[]},{kind:'feeling',topic:'past',position:'old',reason:'why',expiresAt:1,evidence:[],revisions:[]}]});
  assert.match(output,/&lt;script&gt;/);assert.doesNotMatch(output,/<script>|<img/);assert.match(output,/已经化解/);assert.match(output,/已到期/);assert.doesNotMatch(output,/<button/);
});
test('partial rhythm status renders missing data explicitly without crashing or inventing values',()=>{
  const from=html.indexOf('function renderRhythmState('),to=html.indexOf('async function refreshRhythm(',from),box={};
  const context=vm.createContext({document:{getElementById:()=>box},esc:String});vm.runInContext(html.slice(from,to),context);
  context.renderRhythmState({now:{}});assert.doesNotMatch(box.innerHTML,/undefined|NaN/);assert.match(box.innerHTML,/—/);
});
