// Shared read adapter for scoped, source-backed acquisition. No QQ writes.
import * as bili from './bili.js';

export async function discoverBili({action='search',keyword='',limit=6,exclude=[],sessdata=''},dependencies=bili) {
  const term=String(keyword).trim().slice(0,120);
  if(!term||!['search','recommend'].includes(action))throw Error('请给具体的搜索方向');
  const result=await dependencies.search({keyword:term,limit:Math.max(1,Math.min(12,Number(limit)||6)),sessdata});
  if(result.error)throw Error('B站搜索暂不可用');
  const items=(result.list||[]).filter(r=>/^BV[0-9A-Za-z]{10}$/.test(r.bvid||'')&&!exclude.includes(r.bvid)).slice(0,12)
    .map(r=>({title:String(r.title||'').slice(0,160),bvid:r.bvid,url:'https://www.bilibili.com/video/'+r.bvid,up:String(r.up||'').slice(0,80),duration:String(r.duration||'').slice(0,30)}));
  return {action,items:action==='recommend'?items.slice(0,3):items,boundary:'搜索得到的是标题、UP与链接，不是看过视频。标题不能证明音量、剧情或实际风格；仅凭标题选推荐时说这是候选方向或猜测，不断言“不吵/治愈/剧情怎样”。需要评价内容再查具体资料。查询没有发送推荐、没有写全局口味或推送计数。'};
}

export async function acquireBiliObservation({ action = 'auto', url = '', limit = 8, sessdata = '' }, dependencies = bili) {
  if (!['auto', 'info', 'subtitle', 'comments', 'danmaku'].includes(action)) throw Error('此动作不能生成内容依据');
  const got = bili.extractBili(url);
  if (!got) throw Error('请给 B 站视频链接或 BV 号');
  if (got.shortUrl) {
    const u = new URL(got.shortUrl);
    if (u.hostname !== 'b23.tv' || !['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) throw Error('不是有效的 B 站短链');
  }
  const target = got.shortUrl ? await dependencies.resolveShort(got.shortUrl) : got;
  if (target.error) throw Error('B 站短链解析失败');
  const info = await dependencies.videoInfo(target);
  if (info.error) throw Error('视频资料查询失败');
  const n = Math.min(40, Math.max(1, Math.floor(Number(limit) || 8)));
  const parts = [{ kind: 'metadata', text: `标题：${info.title}\n简介：${info.desc || '无'}`, coverage: '标题与简介，不是剧情全文' }];
  const tasks = action === 'auto' ? ['subtitle', 'comments', 'danmaku'] : action === 'info' ? [] : [action];
  const results = await Promise.all(tasks.map(async kind => {
    const r = kind === 'subtitle' ? await dependencies.subtitle({ bvid: info.bvid, cid: info.cid, sessdata })
      : kind === 'comments' ? await dependencies.comments({ aid: info.aid, limit: n }) : await dependencies.danmaku({ cid: info.cid, limit: n });
    return { kind, result: r };
  }));
  for (const { kind, result: r } of results) {
    if (!r || r.error) continue;
    const text = kind === 'subtitle' ? r.text : kind === 'danmaku' ? (r.sample || []).join('\n') : (r.list || []).map(x => x.text || '').join('\n');
    if (text) parts.push({ kind, text, coverage: kind === 'subtitle' ? '取得的字幕文字，可能被截断；没有画面/原始音频' : '观众意见，可能含玩笑、误读与剧透' });
  }
  return { source: { type: 'bili', bvid: info.bvid, title: info.title, parts },
    text: [dependencies.formatBiliResult('info', info), ...results.map(x => dependencies.formatBiliResult(x.kind, x.result))].join('\n\n') };
}
