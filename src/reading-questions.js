// Question progress is derived from actual notes, never from elapsed time.
const clip=(s,n=180)=>String(s||'').trim().slice(0,n),STATES=['open','answered','revised','paused'];
export function parseReadingQuestionUpdate(value,excerpt,previous=[]){
 if(value===undefined||value===null)return null;
 if(typeof value!=='object'||Array.isArray(value)||!STATES.includes(value.status))throw Error('疑问更新状态无效，没有推进');
 const id=clip(value.previousNoteId,80),origin=previous.find(n=>n.id===id&&n.question),anchor=clip(value.anchor,60),explanation=clip(value.explanation);
 if(!origin||anchor.length<6||!String(excerpt).includes(anchor)||!explanation)throw Error('疑问更新缺少原问题或本段依据，没有推进');
 return {previousNoteId:id,status:value.status,explanation,anchor};
}
export function readingQuestions(notes,itemId,now=Date.now()){
 const current=new Map();
 for(const n of notes.filter(n=>n.itemId===itemId&&(!n.at||n.at<=now))){
  if(n.question)current.set(n.id,{id:n.id,text:clip(n.question,160),status:'open',explanation:'',updatedAt:n.at,sourceNoteId:n.id});
  const u=n.questionUpdate;
  if(u&&current.has(u.previousNoteId)&&STATES.includes(u.status)&&u.anchor?.length>=6&&n.excerpt?.includes(u.anchor)&&u.explanation){const old=current.get(u.previousNoteId);current.set(old.id,{...old,status:u.status,explanation:clip(u.explanation),updatedAt:n.at,sourceNoteId:n.id});}
 }
 return [...current.values()].sort((a,b)=>Number(a.updatedAt)-Number(b.updatedAt)).slice(-4);
}
