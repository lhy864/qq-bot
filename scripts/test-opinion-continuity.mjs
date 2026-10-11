import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {leisureJournal,leisurePrompt} from '../src/leisure.js';import {publicExperiences,reflectExperience,experienceContext} from '../src/lived-experience.js';import {materialConversationHint} from '../src/material-conversation.js';import {bridgeHarness} from './audit-bridge-harness.mjs';
import {leisureHint} from '../src/leisure.js';
const now=Date.now(),note=(i,position,reason)=>({id:'leisure-'+String(i).repeat(20),itemId:'book',title:'模拟书虫 · 原作',kind:'reading',url:'https://ncode.syosetu.com/n12345/2/',excerpt:'女孩想找书，认得家人却不习惯这个新身体。',coverage:'仅读到开头',summary:'女孩想找书',position,reason,at:now-3000+i*1000});
const first=note(1,'我以为她主要嫌弃家人','最先注意到她躲手的动作'),second=note(2,'更在意身体与记忆的错位','同一片段交代记忆不是她自己的');
test('direct practice-history questions receive a concrete absent-record check, even with no Python note',()=>{
 const hint=leisureHint({notes:[first],items:[]},'你前面学计算机，有自己跑过 Python 的小程序吗？');assert.match(hint,/当前没有保存的实际代码执行记录/);assert.match(hint,/先诚实说明还没实际运行/);assert.doesNotMatch(leisureHint({notes:[first],items:[]},'我运行过一个 Python 小程序'),/本次亲身练习核对/);
});
test('same work has a stable current opinion with bounded actual previous positions and source ids',()=>{
 const a=leisureJournal({notes:[first],items:[]}),b=leisureJournal({notes:[first,second],items:[]});assert.equal(b.records.length,1);assert.equal(a.records[0].id,b.records[0].id);assert.equal(b.records[0].position,second.position);assert.equal(b.records[0].revisions[0].reason,first.reason);assert.equal(b.records[0].revisions[0].sourceId,first.id);assert.equal(publicExperiences([b,a]).records[0].position,second.position);
 const p=leisurePrompt({title:first.title,coverage:first.coverage},second.excerpt,[first]);assert.match(p,/最先注意到/);assert.match(p,/不同用词不等于必须改观/);
});
test('actual reflected change updates original opinion and survives reload with prior reasons',()=>{
 const journal=leisureJournal({notes:[first,second],items:[]}),old=journal.records[0];const changed=reflectExperience(journal,{id:old.id,kind:'interest',topic:old.topic,position:'接受身体错位的解释，但仍不赞成用嫌弃评价家人',reason:'有新身体的处境能解释动作，不能替代相处选择',visibility:'public',sourceIds:[second.id]},{now});
 const saved=JSON.parse(JSON.stringify(changed.journal)),r=saved.records[0];assert.equal(r.id,old.id);assert.equal(r.revisions.length,2);assert.match(experienceContext(saved,{text:'上次模拟书虫那个观点呢'}),/此前判断|原作/);
 const hint=materialConversationHint([first,second],[],'模拟书虫你现在怎么看',{experiences:saved,target:'123',now});assert.match(hint,/接受身体错位的解释/);assert.match(hint,/我以为她主要嫌弃家人|更在意身体/);assert.match(hint,/可以部分接受/);assert.match(hint,/更新原 id/);
});
test('opinion histories do not pull another participant or unrelated private subject into the hint',()=>{
 const own=leisureJournal({notes:[first],items:[]});own.records.push({...own.records[0],id:'other',topic:'模拟书虫',position:'他人秘密立场',target:'456'});own.records.push({...own.records[0],id:'unrelated',topic:'无关私事',position:'无关秘密'});
 const hint=materialConversationHint([first,second],[],'模拟书虫呢',{experiences:own,target:'123',now});assert.doesNotMatch(hint,/他人秘密|无关秘密/);
});
test('real model entry includes specific no-invented-exercise guard without fetching or modifying persona',async()=>{
 const h=await bridgeHarness();try{h.setMode('reserved2');fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify({notes:[first,second],items:[]}));const st=h.getSocialV2State('private:123');st.recentMessages=[{seq:1,userId:'123',text:'Python循环你试过没',time:now,directToAi:true}];st.unread=st.recentMessages;st.modelSeenSeqs=new Set([1]);const before=JSON.stringify(st.experience);assert.match(h.livedContextV2('private:123',st),/知识例子和网页上的练习不是你做过/);assert.equal(JSON.stringify(st.experience),before);assert.equal(h.calls.prompts.length,0);}finally{await h.close();}
});
