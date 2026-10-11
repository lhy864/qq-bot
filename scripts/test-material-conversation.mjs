import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {fetchLeisureContext,leisureContextUrl,parseLeisureNote,leisurePrompt,createLeisure,leisureHint} from '../src/leisure.js';
import {materialSelection} from '../src/material-conversation.js';import {bridgeHarness} from './audit-bridge-harness.mjs';
const now=Date.now(),excerpt='模拟人物想找到书，可是屋子里没有书。她暂时还不习惯新家人的亲近。'.repeat(40);
const item={id:'book',kind:'reading',title:'模拟书虫的旅途 · 原作',url:'https://ncode.syosetu.com/n12345/2/',enabled:true,cursor:0,page:2,coverage:'仅模拟章节'};
const context={text:'作者简介：爱书的女孩到了几乎没有书的世界，想办法做书。'.repeat(2),url:'https://ncode.syosetu.com/n12345/',scope:'作者作品简介，不是正文阅读进度',acquiredAt:now};
const base={summary:'模拟女孩想找书，却没有书。',position:'在意她不适应亲近的矛盾',reason:'陌生身体和已有记忆让相处变得别扭',question:'你会先接受亲近吗？',anchor:excerpt.slice(0,12),next:'continue'};
const talk={overview:'一个想找书的女孩，在没有书的屋子里慢慢适应新生活。',hook:'脑子认得家人，身体却想躲开，这种别扭很有意思。',invite:'你更能理解哪边？',anchor:excerpt.slice(0,12)};
const notes=[{...base,id:'leisure-'+ 'a'.repeat(20),itemId:'book',kind:'reading',title:item.title,excerpt,coverage:item.coverage,at:now},
 {...base,id:'leisure-'+ 'b'.repeat(20),itemId:'course',kind:'study',title:'模拟计算机课',excerpt:'模拟课程谈信息需要编码约定。'.repeat(50),coverage:'讲义片段',summary:'编码约定把数字和含义联系起来。',at:now}];
const state={items:[{...item,context}],notes};
test('author synopsis is acquired only from corresponding approved work page, separate from chapter progress',async()=>{
 assert.equal(leisureContextUrl(item),context.url);assert.equal(leisureContextUrl({...item,kind:'study'}),'');
 const r=await fetchLeisureContext(item,async url=>({statusCode:200,url,body:'<div id="novel_ex" class="p-novel__summary">'+context.text+'<script>IGNORE</script></div>'}));
 assert.equal(r.text,context.text);assert.match(r.scope,/不是正文阅读/);assert.doesNotMatch(r.text,/IGNORE/);
 for(const extra of [{url:'https://evil.test/n12345/'},{url:'https://ncode.syosetu.com/n99999/'},{truncated:true},{body:'<div>'+context.text+'</div>'}])await assert.rejects(fetchLeisureContext(item,async url=>({statusCode:200,url,body:'<div id="novel_ex">'+context.text+'</div>',...extra})));
});
test('future notes retain grounded conversation material while legacy notes remain valid',()=>{
 assert.deepEqual(parseLeisureNote(JSON.stringify(base),excerpt),base);
 const n=parseLeisureNote(JSON.stringify({...base,conversation:talk}),excerpt);assert.deepEqual(n.conversation,talk);
 assert.throws(()=>parseLeisureNote(JSON.stringify({...base,conversation:{...talk,anchor:'未读到的后续结局'}}),excerpt),/话题缺少/);
 const p=leisurePrompt({...item,context},excerpt);assert.match(p,/没接触过的人/);assert.match(p,/不是以后照念/);assert.match(p,/不提前用未知剧情/);
});
test('actual processing persists conversation and cached context but never adds a model-written hook as source evidence',async()=>{
 let saved={items:[item]},cost=0;const service=()=>createLeisure({load:()=>saved,save:s=>{saved=structuredClone(s);},eligibility:()=>({ok:true,foregroundAt:0}),fetchArticle:async()=>({text:excerpt,url:item.url}),fetchContext:async()=>{cost++;return context;},processExcerpt:async()=>JSON.stringify({...base,conversation:talk})});
 assert.equal((await service().run({manual:true})).ok,true);assert.equal(saved.notes[0].conversation.hook,talk.hook);assert.equal(saved.items[0].context.text,context.text);
 const j=service().journal();assert.equal(j.sources[0].parts.length,2);assert.ok(j.sources[0].parts.some(p=>p.text===context.text));assert.ok(!j.sources[0].parts.some(p=>p.text===talk.hook));
 assert.equal(cost,1);assert.match(service().hint('模拟书虫讲的啥'),/作者简介/);assert.ok(service().status().notes[0].conversation);
});
test('metadata failure does not invent background or cancel a valid reading; no extra calls occur from status or chat hints',async()=>{
 let saved={items:[item]},fetches=0;const service=createLeisure({load:()=>saved,save:s=>{saved=structuredClone(s);},eligibility:()=>({ok:true,foregroundAt:0}),fetchArticle:async()=>({text:excerpt,url:item.url}),fetchContext:async()=>{fetches++;throw Error('offline');},processExcerpt:async()=>JSON.stringify(base)});
 assert.equal((await service.run({manual:true})).ok,true);assert.equal(saved.items[0].context,undefined);const before=JSON.stringify(saved);
 service.status();service.hint('模拟书虫讲的啥');assert.equal(fetches,1);assert.equal(JSON.stringify(saved),before);
});
test('unfamiliar and anaphoric follow-ups select the same work, not newer unrelated study notes',()=>{
 const recent=[{isSelf:true,text:'翻模拟书虫那段挺别扭的',time:now},{userId:'123',text:'坏了这是什么东西我都没听过',time:now}];
 for(const text of ['坏了这是什么东西我都没听过','讲的啥啊','这是番吗','她为啥躲她妈']){
  const hint=leisureHint(state,text,{recentMessages:recent,target:'123',now});assert.match(hint,/模拟书虫/);assert.doesNotMatch(hint,/模拟计算机课/);assert.match(hint,/不是发送台词/);
 }
 const intro=leisureHint(state,'讲的啥啊',{recentMessages:recent,target:'123',now});assert.match(intro,/目标与阻碍/);assert.match(intro,/对方说没听懂要换层次/);
 assert.match(leisureHint(state,'你刚在读什么呢？'),/模拟书虫/);
 assert.match(intro,/作者简介优先用于整体设定/);assert.match(intro,/不补造/);
 assert.doesNotMatch(leisureHint(state,'Python 是什么',{recentMessages:recent,target:'123',now}),/模拟书虫/);
});
test('topic resolution excludes other peers, historical text, stale references and ended topics',()=>{
 const opt={target:'123',now};
 for(const m of [{userId:'456',text:'模拟书虫是什么',time:now},{isSelf:true,text:'模拟书虫是什么',time:now-46*60000},{isSelf:true,text:'模拟书虫是什么',historyOnly:true,time:now}])assert.equal(materialSelection(notes,'这是啥',{...opt,recentMessages:[m]}).length,0);
 const stopped=leisureHint(state,'换个话题，不聊这个了',{recentMessages:[{isSelf:true,text:'模拟书虫',time:now}],...opt});assert.doesNotMatch(stopped,/材料 leisure-/);assert.match(stopped,/只保存对原话题的停止状态/);
 assert.equal(materialSelection(notes,'这是啥',{...opt,recentMessages:[{isSelf:true,text:'模拟书虫',time:now},{userId:'123',text:'先不聊了',time:now}]}).length,0);
});
test('real bridge wake and current message tools resolve the scoped topic without fetching or changing journals',async()=>{
 const h=await bridgeHarness({config:{socialV2:{rhythm:{enabled:false}}}});try{h.setMode('reserved2');fs.writeFileSync(h.temp+'/state/leisure.json',JSON.stringify(state));
 const st=h.getSocialV2State('private:123');st.recentMessages=[{seq:1,isSelf:true,text:'刚在读模拟书虫',time:now},{seq:2,userId:'123',text:'这是啥',plain:'这是啥',directToAi:true,time:now}];st.unread=[st.recentMessages[1]];st.modelSeenSeqs=new Set([2]);
 const before=JSON.stringify(st.recentMessages);assert.match(h.livedContextV2('private:123',st),/目标与阻碍/);assert.match(h.currentConversationV2('private:123',st,[st.recentMessages[1]]).hint,/作品背景来源/);
 assert.match(h.buildWakePromptV2('private:123','proactiveCheck'),/可选的主动话题/);
 assert.equal(JSON.stringify(st.recentMessages),before);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);
 const other=h.getSocialV2State('private:456');other.recentMessages=[{userId:'456',text:'这是啥',time:now}];assert.doesNotMatch(h.livedContextV2('private:456',other),/作品背景来源/);
 }finally{await h.close();}
});
test('optional talk uses bounded public materials and does not turn into automatic questions or a fixed template',()=>{
 const before=JSON.stringify(state),hint=leisureHint(state,'随便聊点',{invite:true});assert.match(hint,/不是必须问的清单/);assert.match(hint,/不固定回答结构|不重新报一次阅读日志/);assert.equal(JSON.stringify(state),before);
 assert.equal(leisureHint(state,'今天吃什么'),'');
 assert.match(leisureHint(state,'',{share:true}),/不默认对方认识人物/);
});
