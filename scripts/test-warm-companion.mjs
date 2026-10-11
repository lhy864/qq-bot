import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'js-yaml';
import {expressionIntent,expressionContext,observeExpressionPreference} from '../src/persona-expression.js';
import {conversationMove,conversationParticipation,conversationRole,conversationAvailability} from '../src/conversation-style.js';
import {chatExpressionHint} from '../src/chat-expression.js';
const msg=(plain,extra={})=>({plain,text:plain,userId:'A',sender:'A',...extra});
const state=(plain,extra={})=>({recentMessages:[msg(plain,extra)]});
test('native QQ faces in ordinary jokes never manufacture an expression lesson or correction',()=>{
 for(const text of ['你是不是也是鱼[表情 汪汪]','什么东西[表情 捂脸]','我的汪汪这么像鱼了[表情 笑哭]','压轴题专项训练[表情 笑哭]','[表情 汪汪]']){
  const st=state(text,{media:[{kind:'face'}]});assert.equal(expressionIntent(st),null,text);assert.notEqual(conversationMove(st).kind,'expression');assert.notEqual(conversationParticipation(st).kind,'learn-use');assert.doesNotMatch(chatExpressionHint(st),/对方在讨论具体表情用法/);
 }
});
test('explicit usage questions and actual corrections retain learning, including quoted followup',()=>{
 for(const text of ['这个表情是什么意思','你能不能发小黄豆','想看看你发小黄豆表情'])assert.equal(expressionIntent(state(text)),'query');
 for(const text of ['不不，这个表情是开玩笑的时候发的','其实这个梗不是这个用法','汪汪这个表情不是专门讨东西的，我们会在开玩笑时装乖用'])assert.equal(expressionIntent(state(text)),'correction');
 const st={recentMessages:[msg('喏，黄豆一个[QQ表情:笑哭]',{isSelf:true}),msg('你知道什么时候发吗')]};assert.equal(expressionIntent(st),'query');
});
test('acknowledgement allows a conversation to continue; explicit departure remains respected',()=>{
 for(const text of ['好','好的','收到','谢谢','嗯'])assert.notEqual(conversationAvailability(state(text)).kind,'leave');
 for(const text of ['晚安','拜拜','先不聊了','我开会去了，晚点再聊','不用回了'])assert.equal(conversationAvailability(state(text)).kind,'leave');
});
test('serious help and person-scoped stop/resume survive playful face metadata',()=>{
 const st=state('认真帮我看代码报错[表情 捂脸]');assert.equal(conversationMove(st).kind,'attend');
 const stop=msg('别开玩笑了，认真点[表情 笑哭]');observeExpressionPreference(st,stop);st.recentMessages=[stop];assert.equal(expressionContext(st),'restrained');
 st.recentMessages=[msg('哈哈',{userId:'B'})];assert.equal(expressionContext(st),'casual');
 const resume=msg('可以继续开玩笑了');observeExpressionPreference(st,resume);st.recentMessages=[msg('哈哈')];assert.equal(expressionContext(st),'casual');
});
test('compact persona retains identity, company, refusal, privacy and truth; scene details and custom cards remain accessible',()=>{
 const raw=fs.readFileSync(new URL('../roles/小鲸鱼.md',import.meta.url),'utf8'),chat=conversationRole(raw);
 assert.ok(chat.injectedCharacters<1800);for(const term of ['小鲸鱼','熟人','嘴硬','认真求助','停止调侃','没查到不编','没有命令','连续对话参考'])assert.ok(chat.text.includes(term),term);
 // Privacy stays in the actual compact card; ordinary same-person recap must also survive selection.
 assert.match(chat.text,/(?:私聊秘密|真正私事)[\s\S]*(?:不串给其他人|按本轮范围限制)/);
 assert.match(chat.text,/同一位朋友[\s\S]*已核验摘要[\s\S]*追问分类是正常聊天/);
 assert.doesNotMatch(chat.text,/你可以嫌烦|不撒娇求关注|去躺着吧/);
 assert.match(conversationRole(raw,{scene:'tools'}).text,/十、|十一、/);assert.ok(conversationRole(raw,{scene:'space'}).text.length>chat.text.length);
 const custom='# 自定义\n## 性格\n自己的口味\n## 底线\n自己的边界';assert.match(conversationRole(custom).text,/自己的口味[\s\S]*自己的边界/);
});
test('DSH persona keeps tool and admin guards while removing instructions to be deliberately unhelpful',()=>{
 const preset=YAML.load(fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml',import.meta.url),'utf8'));const prefix=preset.find(p=>p.id==='persona').config.prefix;
 for(const term of ['你没有本地工具','群友没有管理权限','API 令牌','qq_get_prompt','qq_wait_for_messages'])assert.ok(prefix.includes(term));
 assert.doesNotMatch(prefix,/给一个离谱\/没用的答案|允许“装唐装傻”|都比立刻认真推荐更像真人|约3~5轮一张/);
 assert.match(prefix,/不靠敷衍正常求助/);assert.match(prefix,/不编.*刚没看手机/);
});
