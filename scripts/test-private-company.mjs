import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationAvailability,conversationMove,privateConversationHint,conversationRole} from '../src/conversation-style.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import fs from 'node:fs';
const state=text=>({recentMessages:[{userId:'123',sender:'模拟朋友',text,plain:text,time:Date.now()}]});
test('private short answers and life updates retain company without applying the same policy to groups',()=>{
 for(const text of ['嗯','好的','我在复习','今天下班了真累','我在学数组，现在想扯两句','故事里最后他说了晚安']){
  assert.notEqual(conversationAvailability(state(text)).kind,'leave');assert.match(privateConversationHint(state(text),{key:'private:123'}),/默认愿意继续/);
  assert.match(conversationMove(state(text),{key:'private:123'}).text,/不主动说/);
  assert.equal(privateConversationHint(state(text),{key:'group:456'}),'');
 }
});
test('explicit departures are respected; negated departures and resumed company do not become automatic goodbye',()=>{
 for(const text of ['晚安','晚安啦','我走啦，拜拜','我先睡了','我去睡了','我该去睡觉了','先不聊了','不用回了']){
  assert.equal(conversationAvailability(state(text)).kind,'leave');assert.match(privateConversationHint(state(text),{key:'private:123'}),/不挽留/);
 }
 for(const text of ['不是让你不用回','我没说不聊了，接着聊','现在休息，陪我聊会儿'])assert.notEqual(conversationAvailability(state(text)).kind,'leave');
});
test('real wait guard uses the same departure meaning instead of matching busy words or quoted night greetings',async()=>{
 const h=await bridgeHarness();try{h.setMode('reserved2');
  for(const text of ['我在复习','下班了，好累','不是让你不聊了','故事里最后说了晚安'])assert.equal(h.hasExplicitEndV2(state(text)),false,text);
  for(const text of ['晚安','先不聊了','我走啦，拜拜'])assert.equal(h.hasExplicitEndV2(state(text)),true,text);
 }finally{await h.close();}
});
test('compact role stays bounded and retains explicit refusal/stop/truth alongside private attachment',()=>{
 const role=conversationRole(fs.readFileSync(new URL('../roles/小鲸鱼.md',import.meta.url),'utf8'));
 assert.ok(role.injectedCharacters<1800);for(const text of ['私聊默认想继续陪着','撒娇留人','停止调侃','没查到不编','认真求助'])assert.ok(role.text.includes(text),text);
});
