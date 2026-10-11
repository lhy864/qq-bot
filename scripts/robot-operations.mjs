// Local operational checks. No QQ message, model prompt, configuration write or reset.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readOneBotTokens } from '../src/snowluma-conn.js';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
const normalizePath = (value) => path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('无法读取或解析 ' + path.basename(file) + '，请检查文件'); }
};

export function localUrl(value, protocols = ['http:', 'https:']) {
  let url; try { url = new URL(value); } catch { throw new Error('本机服务地址格式无效'); }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error('运维入口仅支持无附加凭据的本机服务地址');
  return url;
}

export function loadOperations(root) {
  root = fs.realpathSync(root);
  const cfg = readJson(path.join(root, 'config.json'));
  const optionsFile = path.join(root, 'robot-runtime.json');
  const options = fs.existsSync(optionsFile) ? readJson(optionsFile) : {};
  const consolePort = Number(cfg.consolePort ?? 3100);
  if (!Number.isSafeInteger(consolePort) || consolePort <= 0 || consolePort > 65535) throw new Error('控制台端口无效');
  const ws = localUrl(cfg.snowluma?.wsUrl ?? 'ws://127.0.0.1:3011', ['ws:', 'wss:']);
  const dsh = localUrl(cfg.dsh?.baseUrl ?? 'http://127.0.0.1:19387');
  const http = localUrl(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000');
  const snowlumaHome = options.snowlumaHome ?? cfg.snowluma?.homeDir ?? 'D:\\SnowLuma';
  const candidates = [{ baseUrl: http.href.replace(/\/$/, ''), token: String(cfg.snowluma?.accessToken ?? '') }];
  // HTTP and WS tokens are distinct. Use matching local WS configurations for fallback.
  for (const entry of readOneBotTokens(snowlumaHome)) {
    if (!entry.http || !entry.ws || Number(entry.ws.port) !== Number(ws.port || (ws.protocol === 'wss:' ? 443 : 80))) continue;
    try {
      const endpoint = localUrl('http://' + entry.http.host + ':' + entry.http.port);
      candidates.push({ baseUrl: endpoint.href.replace(/\/$/, ''), token: entry.http.token });
    } catch { /* A remote or malformed fallback is outside this local launcher. */ }
  }
  const deduped = candidates.filter((value, index) => candidates.findIndex((other) => other.baseUrl === value.baseUrl && other.token === value.token) === index);
  let consoleToken = String(cfg.consoleToken ?? '').trim();
  if (consoleToken.length < 16) {
    try { consoleToken = fs.readFileSync(path.join(root, 'state', 'console-token'), 'utf8').trim(); } catch { consoleToken = ''; }
  }
  if (/[\r\n]/.test(consoleToken)) consoleToken = '';
  let sourceHash = null;
  try { sourceHash = sha(fs.readFileSync(path.join(root, 'src', 'bridge.js'))); } catch {}
  return { root, consoleUrl: 'http://127.0.0.1:' + consolePort, consoleToken,
    wsPort: Number(ws.port || (ws.protocol === 'wss:' ? 443 : 80)), wsHost: ws.hostname.replace(/^\[|\]$/g, ''),
    dshPort: Number(dsh.port || (dsh.protocol === 'https:' ? 443 : 80)), dshHost: dsh.hostname.replace(/^\[|\]$/g, ''),
    httpCandidates: deduped, sourceHash,
    paths: { qq: options.qqExecutable ?? 'D:\\QQ\\QQ.exe', dsh: options.dshExecutable ?? 'D:\\Deepseek_Harness\\DeepSeek Harness.exe',
      snowluma: options.snowlumaLauncher ?? cfg.snowluma?.launcherPath ?? path.join(snowlumaHome, 'launcher.bat'), bridge: path.join(root, 'start.bat') },
    timeoutMs: Math.max(1000, Math.min(5000, Number(options.requestTimeoutMs) || 2500)),
    qqSettleMs: Math.max(0, Math.min(30000, Number(options.qqSettleMs ?? 8000) || 0)),
    startupTimeoutMs: Math.max(10000, Math.min(180000, Number(options.startupTimeoutMs) || 90000)) };
}

export async function requestJson(url, init, fetchImpl = fetch, timeoutMs = 2500) {
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, code: response.status === 401 || response.status === 403 ? 'authorization' : 'http-' + response.status };
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 1024 * 1024) throw new Error('oversized-response');
      chunks.push(Buffer.from(chunk));
    }
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch (error) {
    const code = error?.cause?.code;
    return { ok: false, code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout'
      : code === 'ECONNREFUSED' ? 'connection-refused' : 'unavailable-or-invalid-response' };
  }
}

export async function checkRobot(settings, io) {
  const [bridgeReply, dshListening, wsListening] = await Promise.all([
    settings.consoleToken ? io.request(settings.consoleUrl + '/api/status', { headers: { 'x-console-token': settings.consoleToken } }) : { ok: false, code: 'missing-console-token' },
    io.port(settings.dshPort, settings.dshHost), io.port(settings.wsPort, settings.wsHost),
  ]);
  let gateway = { ready: false, code: 'unavailable', online: null, good: null, port: null };
  const gatewayDeadline = Date.now() + 10000;
  for (const candidate of settings.httpCandidates) {
    const remaining = gatewayDeadline - Date.now();
    if (remaining <= 0) { gateway.code = 'probe-budget-exhausted'; break; }
    const response = await io.request(candidate.baseUrl + '/get_status', { method: 'POST', body: '{}',
      headers: { 'content-type': 'application/json', ...(candidate.token ? { authorization: 'Bearer ' + candidate.token } : {}) } }, Math.min(settings.timeoutMs, remaining));
    const body = response.body;
    if (response.ok && body?.status === 'ok' && (body.retcode === undefined || body.retcode === 0) && typeof body.data?.online === 'boolean') {
      gateway = { ready: true, code: 'ok', online: body.data.online, good: typeof body.data.good === 'boolean' ? body.data.good : null,
        port: Number(new URL(candidate.baseUrl).port || 80) }; break;
    }
    gateway.code = response.code ?? 'invalid-onebot-status';
  }
  const status = bridgeReply.body;
  const validBridge = bridgeReply.ok && typeof status?.dshReady === 'boolean' && typeof status?.mode === 'string';
  const build = validBridge ? status.build : null;
  let identity = 'unverified';
  if (typeof build?.root === 'string' && normalizePath(build.root) !== normalizePath(settings.root)) identity = 'other-project';
  else if (typeof build?.root === 'string' && /^[0-9a-f]{64}$/i.test(build.bridgeSha256 ?? '') && settings.sourceHash) identity = build.bridgeSha256.toUpperCase() === settings.sourceHash ? 'current' : 'old-code';
  const health = validBridge ? status.snowluma : null;
  const bridge = { ready: validBridge, code: validBridge ? 'ok' : bridgeReply.code ?? 'invalid-bridge-status', identity,
    pid: Number.isSafeInteger(build?.pid) ? build.pid : null, startedAt: typeof build?.startedAt === 'string' ? build.startedAt : null,
    mode: validBridge ? status.mode : null, paused: validBridge ? status.socialV2Paused === true : null, silent: validBridge ? status.roleMode === 'silent' : null };
  const dsh = { ready: validBridge && status.dshReady === true && dshListening, listening: dshListening };
  const receive = { connected: typeof health?.connected === 'boolean' ? health.connected : null,
    good: typeof health?.good === 'boolean' ? health.good : null, listening: wsListening };
  const online = gateway.online ?? (typeof health?.accountOnline === 'boolean' ? health.accountOnline : null);
  const receiveConfirmed = gateway.good === true || receive.good === true;
  const ready = validBridge && identity === 'current' && dsh.ready && gateway.ready && online === true
    && receive.connected === true && wsListening && receiveConfirmed && gateway.good !== false && receive.good !== false;
  return { schemaVersion: 1, at: new Date().toISOString(), root: settings.root, ready, bridge, dsh, gateway, receive,
    qq: { online }, logSummary: readLogSummary(settings.root) };
}

function tail(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes)); const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, length).toString('utf8'); return (offset ? text.slice(text.indexOf('\n') + 1) : text).split(/\r?\n/);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readLogSummary(root) {
  const errors = { seqScope: 0, resetTokenScope: 0, unhandled: 0 };
  for (const line of tail(path.join(root, 'state', 'bridge.log'))) {
    if (/seq is not defined/.test(line)) errors.seqScope++;
    if (/consoleToken is not defined/.test(line)) errors.resetTokenScope++;
    if (/unhandledRejection|uncaughtException/.test(line)) errors.unhandled++;
  }
  let toolFailures = 0; const recentFailedTools = [];
  for (const line of tail(path.join(root, 'state', 'tool-calls.jsonl'))) {
    try {
      const record = JSON.parse(line);
      if (record.ok !== false) continue;
      toolFailures++;
      if (/^[A-Za-z0-9_-]{1,120}$/.test(record.tool ?? '')) recentFailedTools.push(record.tool);
    } catch { /* Concurrent append or old log format; do not emit raw records. */ }
  }
  const files = {};
  for (const name of ['bridge.log', 'qq-activity.log', 'tool-calls.jsonl', 'token-usage.jsonl']) {
    try { const stat = fs.statSync(path.join(root, 'state', name)); files[name] = { bytes: stat.size, modifiedAt: stat.mtime.toISOString() }; }
    catch { files[name] = null; }
  }
  return { window: 'each log last 64 KiB; historical events, not a live fault count', errors, toolFailures,
    recentFailedTools: [...new Set(recentFailedTools)].slice(-10), files };
}

export function describeStatus(snapshot) {
  const boolean = (value, yes, no) => value === true ? yes : value === false ? no : '未确认';
  return [
    'QQ 账号：' + boolean(snapshot.qq.online, '在线', '未登录或离线'),
    'SnowLuma 动作接口：' + (snapshot.gateway.ready ? '可用（端口 ' + snapshot.gateway.port + '）' : snapshot.gateway.code),
    'SnowLuma 接收连接：' + boolean(snapshot.receive.connected, '已连接', '未连接') + '；收发健康：' + boolean(snapshot.receive.good ?? snapshot.gateway.good, '正常', '异常'),
    '桥接控制台：' + (snapshot.bridge.ready ? '可用' : snapshot.bridge.code) + '；版本：' + ({ current: '当前文件版本', 'old-code': '仍在运行旧代码', 'other-project': '另一个项目', unverified: '旧程序未提供版本标识' }[snapshot.bridge.identity]),
    'DSH 会话接口：' + (snapshot.dsh.ready ? '已就绪' : snapshot.dsh.listening ? '端口已打开，会话尚未确认就绪' : '未就绪'),
    'AI 暂停状态：' + boolean(snapshot.bridge.paused, '已暂停', '未暂停'),
    '角色静默状态：' + boolean(snapshot.bridge.silent, '已静默', '未静默'),
    snapshot.ready ? '结果：当前版本的连接已就绪。' : '结果：尚未完整就绪，以上项目需要检查。',
  ].join('\n');
}

function powershell(script, env = {}) {
  const encoded = Buffer.from('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ErrorActionPreference="Stop"; ' + script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 12000, windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('Windows 进程操作失败；请检查系统权限或启动路径');
  return result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, '')) : null;
}

export function createWindowsIO(settings) {
  const request = (url, init, timeoutMs = settings.timeoutMs) => requestJson(url, init, fetch, timeoutMs);
  const port = (number, host = '127.0.0.1') => new Promise((resolve) => {
    const socket = net.createConnection({ host, port: number }); let done = false;
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(800); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
  const processes = () => {
    const result = powershell("@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','QQ.exe','DeepSeek Harness.exe') } | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress");
    return Array.isArray(result) ? result : result ? [result] : [];
  };
  const present = async (kind) => {
    if (kind === 'dsh' && await port(settings.dshPort, settings.dshHost)) return true;
    if (kind === 'snowluma' && await port(settings.wsPort, settings.wsHost)) return true;
    if (kind === 'bridge' && await port(Number(new URL(settings.consoleUrl).port))) return true;
    const list = processes();
    if (kind === 'qq' || kind === 'dsh') return list.some((p) => p.ExecutablePath ? normalizePath(p.ExecutablePath) === normalizePath(settings.paths[kind]) : p.Name.toLowerCase() === path.basename(settings.paths[kind]).toLowerCase());
    if (kind === 'bridge') {
      let pid; try { pid = Number(fs.readFileSync(path.join(settings.root, 'state', 'bridge.lock'), 'utf8').trim()); } catch {}
      return list.some((p) => p.ProcessId === pid && p.Name.toLowerCase() === 'node.exe' && /(?:^|[\\/\s])bridge\.js(?:["\s]|$)/i.test(p.CommandLine ?? ''));
    }
    return list.some((p) => p.Name.toLowerCase() === 'node.exe' && String(p.CommandLine ?? '').toLowerCase().includes(path.dirname(settings.paths.snowluma).toLowerCase()) && /index\.mjs/i.test(p.CommandLine ?? ''));
  };
  const launch = async (kind) => {
    const file = path.resolve(settings.paths[kind]); if (!fs.existsSync(file)) throw new Error(kind + ' 启动文件不存在');
    const isBatch = /\.(bat|cmd)$/i.test(file);
    // Background helpers stay hidden; QQ is interactive when login is required.
    const result = powershell(isBatch
      ? "$env:PATH=$env:QQ_OPS_CWD+';'+$env:PATH; $launchArgs=@('/d','/s','/c',('\"\"'+$env:QQ_OPS_FILE+'\"\"')); $launchProcess=Start-Process -FilePath $env:ComSpec -ArgumentList $launchArgs -WorkingDirectory $env:QQ_OPS_CWD -WindowStyle Hidden -PassThru; @{pid=$launchProcess.Id}|ConvertTo-Json -Compress"
      : "$p=Start-Process -FilePath $env:QQ_OPS_FILE -WorkingDirectory $env:QQ_OPS_CWD -WindowStyle $env:QQ_OPS_WINDOW -PassThru; @{pid=$p.Id}|ConvertTo-Json -Compress",
    { QQ_OPS_FILE: file, QQ_OPS_CWD: path.dirname(file), QQ_OPS_WINDOW: kind === 'qq' ? 'Normal' : 'Hidden' });
    return result?.pid ?? null;
  };
  const openConsole = async (token) => {
    const url = settings.consoleUrl + (token ? '/?token=' + encodeURIComponent(token) : '/');
    powershell("Start-Process -FilePath $env:QQ_OPS_URL | Out-Null", { QQ_OPS_URL: url });
  };
  return { request, port, present, launch, openConsole, now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
}

export function acquireLaunchLock(root) {
  const dir = path.join(root, 'state'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'launcher.lock'); const value = JSON.stringify({ pid: process.pid, id: crypto.randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
      return () => { try { if (fs.readFileSync(file, 'utf8') === value) fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old; try { old = readJson(file); } catch { throw new Error('启动锁格式损坏，请先检查，不自动删除'); }
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Error('启动锁 PID 无效，请先检查');
      let alive = true;
      try { process.kill(old.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('已有启动任务正在运行，请等它完成');
      if (fs.readFileSync(file, 'utf8') === JSON.stringify(old)) fs.unlinkSync(file);
      else throw new Error('启动锁已变化，请稍后再试');
    }
  }
  throw new Error('启动锁获取失败');
}

export async function startRobot(readSettings, io, onStage = () => {}) {
  let settings = readSettings();
  for (const kind of ['dsh', 'qq', 'snowluma']) {
    const alreadyPresent = await io.present(kind);
    if (alreadyPresent) onStage(kind, 'reuse');
    else { const pid = await io.launch(kind); onStage(kind, 'launched', pid); }
    if (kind === 'qq') {
      const end = io.now() + 15000;
      while (!await io.present('qq') && io.now() < end) await io.sleep(1000);
      if (!await io.present('qq')) throw new Error('QQ 进程未启动；请查看安装路径');
      if (!alreadyPresent) await io.sleep(settings.qqSettleMs ?? 8000);
    }
  }
  const end = io.now() + settings.startupTimeoutMs;
  let bridgeStarted = await io.present('bridge'); let snapshot;
  while (io.now() < end) {
    settings = readSettings(); snapshot = await checkRobot(settings, io);
    if (snapshot.bridge.identity === 'other-project') throw new Error('控制台端口属于另一个项目，已停止启动流程');
    if (!bridgeStarted && snapshot.gateway.ready && snapshot.qq.online === true) {
      const pid = await io.launch('bridge'); bridgeStarted = true; onStage('bridge', 'launched', pid);
    }
    if (snapshot.bridge.ready) {
      if (snapshot.bridge.identity === 'old-code' || snapshot.bridge.identity === 'unverified') {
        await io.openConsole(settings.consoleToken);
        throw new Error('现有桥接仍是旧版或无法核验版本，请在维护后重启桥接；启动器不会强制终止它');
      }
      if (snapshot.ready) { await io.openConsole(settings.consoleToken); return snapshot; }
    }
    onStage('waiting', snapshot.qq.online === true ? 'connections' : 'qq-login');
    await io.sleep(1500);
  }
  if (snapshot?.bridge.ready) await io.openConsole(settings.consoleToken);
  const error = new Error(snapshot?.qq.online !== true ? '等待 QQ 登录/网关就绪超时，请完成登录后再启动' : '连接检查超时；请打开检查机器人查看具体状态');
  error.snapshot = snapshot; throw error;
}

export function saveOperations(root, event) {
  const state = path.join(root, 'state'); fs.mkdirSync(state, { recursive: true });
  const log = path.join(state, 'operations.jsonl');
  try { if (fs.statSync(log).size > 1024 * 1024) fs.renameSync(log, log + '.1'); } catch {}
  fs.appendFileSync(log, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}
