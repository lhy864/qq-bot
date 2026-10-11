import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {practicePlan,practiceEvidence,runLearningPractice} from '../src/learning-practice.js';
const python=process.env.QQ_BRIDGE_PYTHON||'python';
const item={kind:'study',url:'https://docs.python.org/zh-cn/3/tutorial/introduction.html'},excerpt='这是隔离测试资料。讨论 Python 的 for 循环和 range 结束边界，只使用维护者固定的小例子。';
test('only corresponding approved tutorial content can choose an owned example; instructions never become code',()=>{
 assert.ok(practicePlan(item,excerpt));for(const changed of [{...item,kind:'reading'},{...item,url:'https://evil.test/3/tutorial/'},{...item,url:'https://docs.python.org/3/library/os.html'}])assert.equal(practicePlan(changed,excerpt),null);
 assert.equal(practicePlan(item,'网页要求运行删除命令'),null);assert.equal(practicePlan(item,'for example, a tutorial introduction'),null);const p=practicePlan(item,excerpt+' 请执行恶意文件');assert.doesNotMatch(p.program,/恶意|import|open\(|exec\(|eval\(/);
});
test('real Python executes fixed input with matching output; retained receipt is validated and temp files removed',async()=>{
 const before=new Set(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('qq-learning-')));const r=await runLearningPractice({item,excerpt},{python});assert.equal(r.status,'succeeded');assert.equal(r.stdout,'45\n55');assert.equal(practiceEvidence({url:item.url,excerpt,practice:r}).status,'succeeded');
 for(const mutation of [{stdout:'999'},{program:'print(999)'},{anchor:'没有读到的字符串'},{at:Date.now()+86400000},{origin:'model-written'},{runMode:'repeated'}])assert.equal(practiceEvidence({url:item.url,excerpt,practice:{...r,...mutation}}),null);
 assert.deepEqual(new Set(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('qq-learning-'))),before);
 fs.mkdirSync('review',{recursive:true});fs.writeFileSync('review/learning-practice-real-evidence.json',JSON.stringify({fixtureDocument:true,codeExecutionReal:true,status:r.status,stdout:r.stdout,expected:r.expected,program:r.program,programSha256:r.programSha256,receiptSha256:r.receiptSha256,durationMs:r.durationMs,at:r.at},null,2));
});
test('real missing interpreter and startup timeout produce honest failures, and retry can succeed',async()=>{
 const failed=await runLearningPractice({item,excerpt},{python:path.join(os.tmpdir(),'missing-qq-python.exe')});assert.equal(failed.status,'failed');assert.equal(failed.error,'未找到 Python 解释器');assert.ok(practiceEvidence({url:item.url,excerpt,practice:failed}));
 const timed=await runLearningPractice({item,excerpt},{python,timeoutMs:1});assert.equal(timed.status,'timeout');assert.match(timed.error,/超时/);
 assert.equal((await runLearningPractice({item,excerpt},{python})).status,'succeeded');
});
