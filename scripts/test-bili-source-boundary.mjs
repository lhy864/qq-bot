import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatBiliResult } from '../src/bili.js';

test('metadata preserves usable facts while stating absence of actual video content', () => {
  const text = formatBiliResult('info', { title: 'fixture-video', desc: 'fixture-description', cid: 12, aid: 34, duration: 80 });
  assert.match(text, /视频标题、简介/); assert.match(text, /此段不包含视频画面、原始音频或字幕/);
  assert.match(text, /fixture-video/); assert.match(text, /fixture-description/); assert.match(text, /cid=12 aid=34/);
});
test('danmaku and comments are identified as audience claims, not transcript or observed scene', () => {
  const dm = formatBiliResult('danmaku', { total: 1, sample: ['fixture audience joke'] });
  const cm = formatBiliResult('comments', { list: [{ user: 'fixture', text: 'fixture speculation', like: 3 }] });
  assert.match(dm, /不是视频画面或逐字字幕/); assert.match(dm, /fixture audience joke/);
  assert.match(cm, /不是视频事实证据/); assert.match(cm, /fixture speculation/);
});
test('unavailable subtitles never claim text was acquired; successful transcript remains bounded', () => {
  for (const data of [{ needLogin: true, note: 'fixture login required' }, { count: 0, note: 'fixture no transcript' }]) {
    const text = formatBiliResult('subtitle', data); assert.match(text, /未取得字幕文本/); assert.match(text, new RegExp(data.note));
  }
  const text = formatBiliResult('subtitle', { text: 'fixture speech text', list: ['中文'] });
  assert.match(text, /字幕文本/); assert.match(text, /没有读取视频画面或原始音频/); assert.match(text, /fixture speech text/);
});
test('failed request does not claim source was obtained, and search stays a discovery result', () => {
  assert.doesNotMatch(formatBiliResult('info', { error: 'fixture failure' }), /本次来源/);
  const search = formatBiliResult('search', { list: [{ title: 'fixture-found', bvid: 'BV1234567890' }] });
  assert.match(search, /视频搜索结果/); assert.match(search, /尚未读取/); assert.match(search, /BV1234567890/);
});
test('actual MCP exposes source boundary and auto reads three auxiliary sources concurrently', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url)), temp = fs.mkdtempSync(path.join(root, '.tmp-bili-boundary-'));
  fs.mkdirSync(path.join(temp, 'src')); fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(temp,'state'));fs.writeFileSync(path.join(temp,'state/console-token'),'fixture-console-token');
  const consoleServer=http.createServer((req,res)=>{
    assert.equal(req.headers['x-console-token'],'fixture-console-token');
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({mode:'closed-agent'}));
  });await new Promise(resolve=>consoleServer.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(temp, 'config.json'),JSON.stringify({consolePort:consoleServer.address().port}));
  for (const rel of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js']) fs.copyFileSync(path.join(root, 'src', rel), path.join(temp, 'src', rel));
  const moduleUrl = new URL('../src/bili.js', import.meta.url).href;
  fs.writeFileSync(path.join(temp, 'src/bili.js'), `export { formatBiliResult } from ${JSON.stringify(moduleUrl)};
export const resolveShort = async () => ({ bvid: 'BV1234567890' });
export const videoInfo = async () => ({ title: 'fixture-video', bvid: 'BV1234567890', cid: 12, aid: 34, duration: 60 });
const pending = [];
const concurrent = value => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('sources were read sequentially')), 500);
  pending.push(() => { clearTimeout(timer); resolve(value); });
  if (pending.length === 3) for (const done of pending) done();
});
export const danmaku = () => concurrent({ total: 1, sample: ['fixture audience joke'] });
export const comments = () => concurrent({ list: [{ user: 'fixture', text: 'fixture speculation' }] });
export const subtitle = () => concurrent({ text: 'fixture spoken content', list: ['中文'] });
export const search = async () => ({ list: [] }); export const recommend = async () => ({});`);
  const client = new Client({ name: 'bili-boundary-fixture', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(temp, 'src/mcp-snowluma-safe.js')], stderr: 'pipe' }));
    const tool = (await client.listTools()).tools.find(t => t.name === 'qq_bili_info');
    assert.match(tool.description, /这是资料查询工具/); assert.doesNotMatch(tool.description, /判断这视频到底讲了什么|看完要诚实转述/);
    assert.match(tool.description, /字幕最多等待 3 秒/);
    const reply = await client.callTool({ name: 'qq_bili_info', arguments: { action: 'auto', url: 'BV1234567890' } });
    assert.notEqual(reply.isError, true, reply.content[0]?.text);
    const text = reply.content[0].text;
    assert.match(text, /视频标题、简介/); assert.match(text, /观众弹幕/); assert.match(text, /观众评论/);
    assert.match(text, /fixture audience joke/); assert.match(text, /fixture speculation/);
    assert.match(text, /fixture spoken content/); assert.match(text, /没有读取视频画面或原始音频/);
  } finally { await client.close(); await new Promise(resolve=>consoleServer.close(resolve));assert.equal(path.dirname(temp), path.resolve(root)); fs.rmSync(temp, { recursive: true }); }
});
