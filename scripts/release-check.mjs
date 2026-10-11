// Scan publishable files; report only filenames and rule names, never matched secrets.
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(['.git','node_modules'].includes(e.name)&&e.isDirectory())return [];if(e.isSymbolicLink())throw Error('Release cannot contain symlinks');const p=prefix+e.name;return e.isDirectory()?walk(path.join(dir,e.name),p+'/'):[p];});}
const indexed=fs.existsSync(path.join(root,'.git'));let files;if(indexed){const r=spawnSync('git',['ls-files','--cached','-z'],{cwd:root,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('Cannot inspect Git index');files=r.stdout.split('\0').filter(Boolean);if(!files.length)throw Error('No staged/tracked source files; stage the intended release first');}else files=walk(root);
const read=(rel)=>{if(!indexed)return fs.readFileSync(path.join(root,rel),'utf8');const r=spawnSync('git',['show',':'+rel],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});if(r.status!==0)throw Error('Cannot read staged file: '+rel);return r.stdout;};
const forbidden=/(^|\/)(state|review|backups|node_modules|logs|audio|recordings)\/|(^|\/)(config\.json|robot-runtime\.json|\.npmrc|\.privacy-rules\.json|\.env(?:\..*)?)$|\.(?:zip|log|bak|pem|key)$/i;
const rules=[
 ['bilibili-session',/SESSDATA\s*[:=]\s*["']?([A-Za-z0-9%_-]{40,})/i],
 ['credential-literal',/["'](?:authToken|accessToken|consoleToken|password|apiKey|secret)["']\s*:\s*["']((?!fixture-|test-|mock-)[A-Za-z0-9_%.+/=-]{24,})["']/i],
 ['private-key',new RegExp('-----BEGIN [A-Z ]*PRIVATE KEY-----[\\r\\n]+[A-Za-z0-9+/=\\r\\n]{60,}')],
 ['github-token',/\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{70,})\b/],
 ['user-path',/[A-Z]:[\\/]Users[\\/](?!(?:Public|Default|someone|x|fixture)[\\/]|<)[^\\/"'\s]+[\\/]/i],
];
const findings=[];for(const rel of files){if(forbidden.test(rel)){findings.push({path:rel,rule:'private-runtime-file'});continue;}const full=path.resolve(root,rel);if(!full.startsWith(path.resolve(root)+path.sep)||fs.existsSync(full)&&fs.lstatSync(full).isSymbolicLink())throw Error('Invalid release path');const text=read(rel);for(const[name,pattern]of rules)if(pattern.test(text))findings.push({path:rel,rule:name});}
const config=JSON.parse(read('config.example.json'));if(config.allowAllWhenEmpty!==false||config.ownerQQ||config.consoleToken||config.dsh?.authToken||config.snowluma?.accessToken||config.allow.private.length||config.allow.groups.length)throw Error('Example configuration contains enabled destinations or credentials');
const pkg=JSON.parse(read('package.json'));for(const command of Object.values(pkg.scripts||{})){for(const m of command.matchAll(/\bnode\s+(scripts\/[\w.-]+\.mjs|src\/[\w.-]+\.js)/g))if(indexed?!files.includes(m[1]):!fs.existsSync(path.join(root,m[1])))findings.push({path:'package.json',rule:'missing-script-'+m[1]});}
console.log(JSON.stringify({files:files.length,findings,exampleIsBlankAndDenyByDefault:true}));process.exitCode=findings.length?1:0;
