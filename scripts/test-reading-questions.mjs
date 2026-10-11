import test from 'node:test';import assert from 'node:assert/strict';import {parseReadingQuestionUpdate,readingQuestions} from '../src/reading-questions.js';
const now=Date.now(),first={id:'old',itemId:'book',question:'她为什么没有接受这个称呼？',excerpt:'她听见称呼却没回答。',at:now-2000},next={id:'new',itemId:'book',excerpt:'新的正文明确说明她还不习惯新身份。',at:now-1000};
test('questions stay open until a corresponding actual later excerpt supports an update',()=>{
 assert.equal(readingQuestions([first], 'book')[0].status,'open');const update=parseReadingQuestionUpdate({previousNoteId:'old',status:'answered',explanation:'本段说明暂时不适应新身份',anchor:'她还不习惯新身份'},next.excerpt,[first]);
 const result=readingQuestions([first,{...next,questionUpdate:update}],'book')[0];assert.equal(result.status,'answered');assert.equal(result.sourceNoteId,'new');assert.match(result.explanation,/本段/);
 assert.equal(readingQuestions([first,{...next,questionUpdate:{...update,anchor:'原文不存在'}}],'book')[0].status,'open');
});
test('unknown origin, unsupported future answers and malformed status cannot become a resolved question',()=>{
 const value={previousNoteId:'old',status:'answered',explanation:'解释',anchor:'她还不习惯新身份'};for(const changed of [{previousNoteId:'invented'},{anchor:'未读到的全书结局'},{status:'finished'}])assert.throws(()=>parseReadingQuestionUpdate({...value,...changed},next.excerpt,[first]),/疑问更新/);
 assert.equal(readingQuestions([first,{...next,at:now+86400000,questionUpdate:value}],'book',now)[0].status,'open');assert.equal(readingQuestions([first], 'other').length,0);
});
test('an unresolved or revised understanding stays tentative and survives serialized state',()=>{
 const update=parseReadingQuestionUpdate({previousNoteId:'old',status:'revised',explanation:'有新线索但尚未知道是否接受',anchor:'她还不习惯新身份'},next.excerpt,[first]);const saved=JSON.parse(JSON.stringify([first,{...next,questionUpdate:update}]));const q=readingQuestions(saved,'book')[0];assert.equal(q.status,'revised');assert.match(q.explanation,/尚未知道/);
});
