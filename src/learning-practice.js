// Only fixed, owned examples run here. Acquired pages and model output cannot
// supply executable code, flags, imports or commands.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
const executeFile=promisify(execFile),hash=s=>createHash('sha256').update(String(s)).digest('hex');
const PROGRAM='total = 0\nfor i in range(1, 10):\n    total += i\nprint(total)\ntotal = 0\nfor i in range(1, 11):\n    total += i\nprint(total)\n';
const EXPECTED='45\n55',ID='python-range-boundary';
const normalized=s=>String(s||'').replace(/\r\n/g,'\n').trim();
const digest=r=>hash(JSON.stringify([r.id,r.sourceUrl,r.anchor,r.programSha256,r.expected,r.stdout,r.status,r.exitCode,r.at,r.durationMs,r.origin,r.runMode]));
function approved(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='docs.python.org'&&!u.username&&!u.password&&!u.port&&!u.search&&/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?3\/tutorial\//.test(u.pathname);}catch{return false;}}
export function practicePlan(item,excerpt){
 if(item?.kind!=='study'||!approved(item.url))return null;
 const found=/\brange\s*\(|\bfor\s+[A-Za-z_]\w*\s+in\b|\bwhile\s+(?:[A-Za-z_]\w*|\d)|(?:for|while).{0,12}(?:循环|loop)|循环/.exec(String(excerpt));if(!found)return null;
 return {id:ID,title:'试一试循环的结束边界',origin:'maintainer-fixed',runMode:'single-process',sourceUrl:item.url,anchor:String(excerpt).slice(Math.max(0,found.index-25),found.index+85),program:PROGRAM,programSha256:hash(PROGRAM),expected:EXPECTED};
}
export function practiceEvidence(note,now=Date.now()){
 const r=note?.practice;if(!r||r.id!==ID||r.origin!=='maintainer-fixed'||r.runMode!=='single-process'||r.program!==PROGRAM||r.programSha256!==hash(PROGRAM)||r.expected!==EXPECTED||!approved(r.sourceUrl)||r.sourceUrl!==note.url||r.anchor?.length<6||!note.excerpt?.includes(r.anchor)||!(r.at>0&&r.at<=now)||!(r.durationMs>=0&&r.durationMs<=30000)||r.receiptSha256!==digest(r))return null;
 if(r.status==='succeeded'&&(r.exitCode!==0||normalized(r.stdout)!==EXPECTED))return null;
 if(!['succeeded','failed','timeout'].includes(r.status))return null;
 return r;
}
export async function runLearningPractice({item,excerpt},{python=process.env.QQ_BRIDGE_PYTHON||'python',timeoutMs=2500,execute=executeFile,clock=()=>Date.now()}={}){
 const plan=practicePlan(item,excerpt);if(!plan)return null;
 const tempRoot=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'qq-learning-')),file=path.join(dir,'example.py'),at=clock();
 let r={...plan,at,status:'failed',exitCode:null,stdout:'',error:'',durationMs:0};
 try{
  fs.writeFileSync(file,plan.program,{encoding:'utf8',flag:'wx'});
  const output=await execute(python,['-I','-S',file],{cwd:dir,timeout:Math.max(1,Math.min(3000,timeoutMs)),maxBuffer:4096,windowsHide:true,shell:false});
  r.stdout=normalized(output.stdout).slice(0,1600);r.exitCode=0;r.status=r.stdout===plan.expected?'succeeded':'failed';if(r.status==='failed')r.error='运行结果与预期不一致';
 }catch(e){r.status=e.killed?'timeout':'failed';r.exitCode=Number.isInteger(e.code)?e.code:null;r.stdout=normalized(e.stdout).slice(0,1600);r.error=e.killed?'运行超时':e.code==='ENOENT'?'未找到 Python 解释器':'Python 执行失败';}
 finally{
  r.durationMs=Math.max(0,clock()-at);
  const resolved=path.resolve(dir),parent=path.dirname(resolved);if(parent.toLowerCase()!==tempRoot.toLowerCase()||!path.basename(resolved).startsWith('qq-learning-'))throw Error('Practice temporary directory boundary differs');
  fs.rmSync(resolved,{recursive:true,force:true});
 }
 r.receiptSha256=digest(r);return r;
}
