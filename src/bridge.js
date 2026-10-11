// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText, renameRoleReferences } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { shareCardText } from './share-card.js';
import { buildExpressionHint, expressionTargets, expressionBoundaryEvents, sharedExpressionTargets, observeExpressionPreference, expressionContext, replyFocus, classifyInteraction, selectMemePhrases, selectContextSlang } from './persona-expression.js';
import { createSelfActions, selfActionPolicy } from './self-actions.js';
import { reviewConversation, reviewHint, assertPublicSelfText } from './daily-review.js';
import { CONTINUITY_CATEGORIES, normalizeContinuity, appendContinuity, updateContinuity, removeContinuity, formatContinuity, CONTINUITY_HINT } from './social-continuity.js';
import {normalizePersonContinuity,capturePersonContracts,upsertPersonContract,validatePersonContract,personContractView,personContractHint,PERSON_CONTRACT_HINT,upsertPersonThread,personThreadProjection,personThreadHint,PERSON_THREAD_HINT} from './person-continuity.js';
import {discussionTopics,captureDiscussionRecaps,discussionRecall,discussionRecallHint} from './person-recall.js';
import {affinityBreakdown,nicknameSnapshot} from './console-consistency.js';
import { normalizeExperience, addAcquiredSource, reflectExperience, selectExperiences, experienceContext, publicExperiences, communicationHint, activityContext, EXPERIENCE_POLICY, OPINION_RETENTION_HINT, SELF_HISTORY_HINT } from './lived-experience.js';
import { acquireBiliObservation, discoverBili } from './bili-observation.js';
import { createLeisure, leisurePrompt, leisureJournal, leisureHint, dailyActivityContextNeeded } from './leisure.js';
import { eventTimeMs, normalizeRecovery, historyFloor, planHistory, knownMessage, rememberMessage, recoveryHint, recoverySendExpired, RECOVERY_INTERVAL_MS, RECOVERY_OVERLAP_MS, recoveryReplyWindow } from './message-recovery.js';
import { compactModelMessage } from './qq-model-view.js';
import {conversationRole,conversationMove,conversationAvailability,conversationTurnHint,participationQuestion,privateConversationHint,CONVERSATION_BASE,PROACTIVE_CONVERSATION} from './conversation-style.js';
import {proactiveActivityProfile} from './proactive-activity.js';
import {animeCatalogItems,animeDaySummary,advanceAnimeDaily} from './anime-progress.js';
import {nativeFaceCatalog,normalizeFaceIds,nativeFaceContext,faceRecord,chatExpressionHint} from './chat-expression.js';
import {readConversationContacts,sharedConversationRecall} from './conversation-access.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  applySlangResearchResult,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
// Captured at process start: editing the file on disk must not relabel an old process.
const BRIDGE_RUNTIME_BUILD = Object.freeze({
  root: ROOT, pid: process.pid, startedAt: new Date().toISOString(),
  // Module hashes are also captured now, so edited files cannot relabel a running bridge.
  conversationStyleSha256: (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'conversation-style.js'))).digest('hex').toUpperCase(); } catch { return null; } })(),
  personaExpressionSha256: (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'persona-expression.js'))).digest('hex').toUpperCase(); } catch { return null; } })(),
  chatExpressionSha256: (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'chat-expression.js'))).digest('hex').toUpperCase(); } catch { return null; } })(),
  bridgeSha256: (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'))).digest('hex').toUpperCase(); } catch { return null; } })()
});
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState(key) {
  const st = readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
  const base = { role: st?.role ?? null, mode: st?.mode ?? 'active', perKey: st?.perKey ?? null };
  // 本机改动（2026-10-06）：perKey = 按会话覆盖人格卡。例：
  //   {"role":"天童爱丽丝","perKey":{"private:<QQ号>":"女友爱丽丝"}}
  // → 私聊用「女友爱丽丝」，群聊仍用全局 role。没命中就回退全局。
  if (key && base.perKey && typeof base.perKey === 'object'
      && Object.prototype.hasOwnProperty.call(base.perKey, key)) {
    return { ...base, role: base.perKey[key] ?? null };
  }
  return base;
}
function writeRoleState(role, mode) {
  const prev = readJsonSafe(ROLE_STATE_FILE, null);
  const next = { role: role ?? null, mode: mode ?? 'active' };
  // 保留 perKey：否则用控制台/命令切一次全局角色，私聊人格配置就被抹掉了。
  if (prev && typeof prev === 'object' && prev.perKey && typeof prev.perKey === 'object') next.perKey = prev.perKey;
  atomicWriteJson(ROLE_STATE_FILE, next);
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
    socialLookup: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 3,   // 本机改动：1 → 3（群里热闹时太紧，@ 会被挡）
        maxWakePerHour: 40,    // 本机改动：12 → 40
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 12,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      rhythm: {
      enabled: true,
      weekendShift: true,
      weekendShiftHours: 1,
      sleepThreshold: 0.1,
      sleepDelayMultiplier: 2.5
    },
    patience: {
      enabled: true,
      max: 100,
      initial: 70,
      drainPerMessage: 6,
      spamMultiplier: 1.8,
      tiredMultiplier: 1.5,
      recoverPerMinute: 0.3,
      sleepRecoverMultiplier: 3,
      midThreshold: 45,
      lowThreshold: 20,
      midFactor: 0.7,
      lowFactor: 0.35
    },
    proactive: {
      enabled: true,
      // Stored configuration overrides these defaults; activity boosts are temporary.
      checkIntervalMinMs: 20 * 60 * 1000,
      checkIntervalMaxMs: 45 * 60 * 1000,
      idleThresholdMs: 15 * 60 * 1000,
      probability: 0.3,
      dailyMaxPerKey: 2,
      activityBoost: true
    },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    socialLookup: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    sendVoice: false,
    aiVoice: true,
    react: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 12,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
const EPHEMERAL_GROUP_KEYS = new Set(); // Never persisted or sent to QQ, even after expiry.
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  const projected = { ...state, sessions: Object.fromEntries(Object.entries(state.sessions).filter(([k]) => !EPHEMERAL_GROUP_KEYS.has(k))),
    sessionPolicies: Object.fromEntries(Object.entries(state.sessionPolicies || {}).filter(([k]) => !EPHEMERAL_GROUP_KEYS.has(k))) };
  atomicWriteJson(STATE_FILE, projected);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
    const __atList = [];   // 本机改动：收集这条消息 @ 了谁
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
              try { __atList.push(d.qq === 'all' ? 'all' : String(d.qq)); } catch {}
        }
        break;
      }
        case 'face': {
          const __fid = String(d.id ?? '');
          let __fn = '';
          try { __fn = (JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'face-map.json'), 'utf8')).map ?? {})[__fid] ?? ''; } catch { __fn = ''; }
          out.push(__fn ? ('[表情 ' + __fn + ']') : ('[表情' + __fid + ']'));
          break;
        }
        case 'image': {
          // 本机改动 2026-10-07：QQ 收藏表情是以 image 段发来的，靠 summary 认出来
          const sm = String(d.summary ?? '');
          const isSticker = /动画表情|表情包|\[表情\]/.test(sm) || String(d.sub_type ?? d.subType ?? '') === '1';
          out.push(isSticker ? '[表情包]' : '[图片]');
          break;
        }
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      // 本机改动（2026-10-06）：分享卡片别再变成没用的 [卡片消息] ——
      // 把标题/来源/链接提取出来，AI 才知道"这是个什么链接"，需要时能自己去抓。
      case 'json':
      case 'xml': {
        const cardText = shareCardText(String(d.data ?? ''));
        out.push(cardText || '[卡片消息]');
        break;
      }
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
    // 本机改动 2026-10-07：标注这条消息是「对谁说的」（她因此知道该回答还是只起哄）
    const __SELF_NAMES = ['小鲸鱼', '鲸鱼', 'DeepSeek', 'deepseek', '大肥鱼', 'DS', 'D老师', 'D指导', 'D师傅', 'R1', '深度求索'];
    const __isSelfAt = __atList.some((x) => __SELF_NAMES.some((s) => String(x).includes(s)));
    const __isAllAt = __atList.includes('all');
    if (__atList.length && !__isSelfAt && !__isAllAt) out.unshift('[对 @' + __atList.join(' @') + ' 说的] ');
    else if (__isSelfAt) out.unshift('[对你说的] ');
    else if (__isAllAt) out.unshift('[对全体说的] ');
return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
    for (const entry of slangEntries) if (['queued', 'running'].includes(entry.research?.status)) {
      entry.research = { ...entry.research, status: 'interrupted', finishedAt: new Date().toISOString(), message: '上次研究在桥接重启时中断，可重新提交；已有草稿保留。' };
    }
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 已排队及研究中的候选 id，防止重复提交
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    // 本机改动 2026-10-07：表情尺寸修复 —— 收藏表情原图常常 500px+，发出来比群里别的大一圈 ⚠️
    // 只缩**静态图**（最长边 200px，贴纸大小）；GIF 动图保持原样（简单缩放会丢动画）。
    // 全程兜底：任何一步出错就用原图，绝不影响发送。
    try {
      const __isGif = /gif/i.test(String(image?.mimeType ?? '')) || /\.gif(\?|$)/i.test(String(url));
      if (!__isGif) {
        const __mod = await loadCanvasModule();
        if (__mod) {
          const __img = await __mod.loadImage(image.buffer);
          const __w = Number(__img.width) || 0;
          const __h = Number(__img.height) || 0;
          const __MAX = 200;
          if (__w > __MAX || __h > __MAX) {
            const __s = __MAX / Math.max(__w, __h, 1);
            const __cv = __mod.createCanvas(Math.max(1, Math.round(__w * __s)), Math.max(1, Math.round(__h * __s)));
            const __ctx = __cv.getContext('2d');
            __ctx.drawImage(__img, 0, 0, __cv.width, __cv.height);
            const __out = __cv.toBuffer('image/png');
            if (__out?.length) image = { buffer: __out, mimeType: 'image/png', shrunk: true };
          }
        }
      }
    } catch { /* 缩放失败就用原图 */ }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    // 本机改动（2026-10-06）：把"收藏这张表情时的聊天语境"一起存下来。
    // 为什么：光靠看图猜含义远不如当时大家在聊什么 —— 语境才是这张图"怎么用"的准确答案。
    const ctxAll = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const ctxIdx = ctxAll.findIndex((m) => m && String(m.seq) === String(found.seq));
    const ctxMsgs = ctxIdx > 0 ? ctxAll.slice(Math.max(0, ctxIdx - 3), ctxIdx) : [];
    const collectedContext = ctxMsgs
      .filter((m) => m && (m.text || m.plain))
      .map((m) => (m.isSelf ? '我' : (m.card || m.sender || '对方')) + '：' + String(m.text || m.plain).replace(/\s+/g, ' ').slice(0, 60))
      .join(' / ');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    // 本机改动（2026-10-06）：把"收藏时的聊天语境"落到本地库。
    // 语境比看图猜准得多 —— 尤其你们说"存这个"的时候，前后几句话就是这张图的标准用法。
    try {
      const localEntry = entry || findSticker(stickerEntries, emojiId);
      if (localEntry) {
        if (collectedContext) {
          localEntry.context = collectedContext;
          localEntry.contextAt = Date.now();
          const cur = String(localEntry.localNote ?? '').trim();
          if (!cur) localEntry.localNote = '（收藏时的语境）' + collectedContext;
          else if (!cur.includes(collectedContext)) localEntry.localNote = (cur + '｜（收藏时的语境）' + collectedContext).slice(0, 400);
        }
        localEntry.updatedAt = new Date().toISOString();
        try { saveStickerStoreSafe(); } catch {}
      }
    } catch (error) { log('记录表情语境失败:', error?.message ?? error); }
    return { emojiId, entry: entry || null, remark: cleanRemark, context: collectedContext || '' };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return false;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
      return true;
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); return false; }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  function queueSlangResearch(candidates) {
    if (cfg.slang?.enabled === false || !dshReady || !slangStoreWritable) return { count: 0, unavailable: true };
    const targets = [], requestedAt = new Date().toISOString();
    for (const candidate of candidates || []) {
      const entry = slangEntries.find(e => e.id === candidate?.id && e.status === SLANG_STATUS.CANDIDATE);
      if (!entry || slangResearchingIds.has(entry.id)) continue;
      slangResearchingIds.add(entry.id);
      entry.research = { status: 'queued', requestedAt, message: '已排队，等待独立学习会话处理。' };
      targets.push({ id: entry.id, content: entry.content, evidence: entry.evidence });
    }
    if (!targets.length) return { count: 0, duplicateCount: candidates?.length || 0 };
    if (!saveSlangStore()) {
      for (const target of targets) { slangResearchingIds.delete(target.id); const entry = slangEntries.find(e => e.id === target.id); if (entry) entry.research = { status: 'failed', requestedAt, message: '研究状态保存失败，未提交任务。' }; }
      return { count: 0, unavailable: true };
    }
    queueSlangTask(() => runSlangResearch(targets));
    return { count: targets.length, duplicateCount: Math.max(0, (candidates?.length || 0) - targets.length) };
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  // Background material processing owns separate, disposable sessions. Neither
  // the workspace nor its prompt contains QQ keys or conversation credentials.
  let leisure = null;
  const leisureFile = path.join(STATE_DIR, 'leisure.json');
  function leisureEligibility({manual=false,settings={}}={}) {
    if(!dshReady||currentMode!=='reserved2'||socialV2.paused)return {ok:false,reason:'等待机器人就绪并恢复二代活动'};
    const now=new Date();
    if(rhythmCfg().enabled!==false&&(rhythmIsSleeping(now)||rhythmHourFactor(now)<0.5))return {ok:false,reason:'当前是低活动时段'};
    let last=0;
    for(const [key,st] of socialV2.conversations){
      if(EPHEMERAL_GROUP_KEYS.has(key))continue;
      if(isConversationBusyV2(key,st))return {ok:false,reason:'正在处理聊天，稍后再读'};
      last=Math.max(last,Number(st.lastIncomingAt)||0,Number(st.lastAiReplyAt)||0);
    }
    if(!manual&&Date.now()-last<(settings.idleMinutes||15)*60000)return {ok:false,reason:'等聊天空闲一会儿再读'};
    return {ok:true,foregroundAt:last};
  }
  async function processLeisureExcerpt({item,excerpt,previous}) {
    const preset=resolvePresetName('qq-chat-v2',{strict:true});
    if(!preset)throw Error('没有已核验的安全阅读预设');
    const dir=path.join(STATE_DIR,'leisure-agent');fs.mkdirSync(dir,{recursive:true});
    const ownedFile=path.join(dir,'owned-session.json');
    if(fs.existsSync(ownedFile)){
      const old=readJsonSafe(ownedFile,null,true);
      if(old?.owner!=='qq-leisure-v1'||old.workspacePath!==dir||old.preset!==preset||!old.sessionId)throw Error('独立阅读会话的归属记录无效');
      await api.stopSessionWork(old.sessionId);unwrap(await api.workspace.archiveSession({sessionId:old.sessionId}),'leisure stale archive');fs.unlinkSync(ownedFile);
    }
    const ws=unwrap(await api.workspace.create({path:dir}),'leisure workspace');
    let sid,watch;
    try {
      sid=unwrap(await api.sessions.create({workspaceId:ws.workspace.workspaceId,agentPreset:preset}),'leisure session').sessionId;
      atomicWriteJson(ownedFile,{owner:'qq-leisure-v1',sessionId:sid,workspacePath:dir,preset});
      learnerSessions.add(sid);api.events.follow(sid);await ensureChatModel(sid);
      const backbone=currentRoleHintV2('').match(/^## 性格主轴[^\n]*\n([\s\S]*?)(?=^## |$)/m)?.[1]?.trim()||'';
      const result=waitLearnerTurn(sid,120000);result.catch(()=>{});
      const originalForeground=leisureEligibility({manual:true}).foregroundAt;
      watch=setInterval(()=>{let allowed=false;try{const check=leisureEligibility({manual:true});allowed=check.ok&&check.foregroundAt===originalForeground&&leisureOf().status().settings.enabled!==false;}catch{}
        if(!allowed){
        for(const w of learnerWaiters.get(sid)||[]){clearTimeout(w.timer);w.reject(Error('聊天或活动状态变化，阅读已让位'));}
        learnerWaiters.delete(sid);
      }},1500);watch.unref?.();
      if(!leisureEligibility({manual:true}).ok)throw Error('当前不适合开始处理');
      unwrap(await api.sessions.prompt({sessionId:sid,mode:'queue',content:[{type:'text',text:leisurePrompt(item,excerpt,previous,backbone)}]}),'leisure prompt');
      return await result;
    } finally {
      clearInterval(watch);
      if(sid){
        for(const w of learnerWaiters.get(sid)||[]){clearTimeout(w.timer);w.reject(Error('独立阅读会话已结束'));}
        learnerWaiters.delete(sid);learnerCollectors.delete(sid);learnerSessions.delete(sid);
        try{await api.stopSessionWork(sid);}catch{}
        try{unwrap(await api.workspace.archiveSession({sessionId:sid}),'leisure archive');if(fs.existsSync(ownedFile))fs.unlinkSync(ownedFile);}catch{log('[兴趣与日常] 独立会话归档暂未成功，下次仅清理本模块拥有的会话');}
        modelAppliedSessions.delete(sid);
      }
    }
  }
  function leisureOf(){
    if(!leisure)leisure=createLeisure({load:()=>fs.existsSync(leisureFile)?readJsonSafe(leisureFile,null,true):{},save:s=>atomicWriteJson(leisureFile,s),eligibility:leisureEligibility,processExcerpt:processLeisureExcerpt,publicGuard:publicSelfGuard});
    return leisure;
  }
  function leisureJournalFor(key){try{return EPHEMERAL_GROUP_KEYS.has(key)?{sources:[],records:[]}:leisureOf().journal();}catch{return {sources:[],records:[]};}}
  function leisureHintFor(key,text,options){try{
    const st=socialV2.conversations.get(key);
    const target=options?.target||(String(key).startsWith('private:')?String(key).split(':')[1]:replyFocus({recentMessages:options?.recentMessages||[],unread:[]})?.userId);
    options={...options,target,experiences:st?.experience,continuity:cfg.socialV2?.continuity?.enabled!==false?st?.continuity:undefined};
    if(EPHEMERAL_GROUP_KEYS.has(key))return leisureHint(groupRehearsals.get(key)?.publicLeisureState||{items:[],notes:[]},text,options);
    return leisureOf().hint(text,options);
  }catch{return '';}}

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangResearch(researchCandidates);
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    const targets = candidates.filter(target => slangEntries.some(e => e.id === target.id && e.content === target.content && e.status === SLANG_STATUS.CANDIDATE));
    try {
      if (cfg.slang?.enabled === false || !dshReady) throw new Error('学习已关闭或 DSH 未就绪，请稍后重试。');
      if (!targets.length) return;
      const startedAt = new Date().toISOString();
      for (const target of targets) {
        const entry = slangEntries.find(e => e.id === target.id);
        entry.research = { ...entry.research, status: 'running', startedAt, message: '正在研究含义和实际使用场合。' };
      }
      if (!saveSlangStore()) throw new Error('黑话库写入失败，研究未开始。');
      const sessionId = await ensureSlangLearnerSession();
      const promptText = buildResearchPrompt(targets);
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        throw new Error('DSH 拒绝了研究任务。');
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      const totals = { completed: 0, uncertain: 0, empty: 0, skipped: 0 };
      for (const target of targets) {
        const entry = slangEntries.find(e => e.id === target.id && e.content === target.content);
        const result = results.find(r => r.content === target.content);
        totals[applySlangResearchResult(entry, result)]++;
      }
      if (!saveSlangStore()) throw new Error('研究结果写入失败，请检查本地文件权限。');
      log(`黑话研究：完成 ${totals.completed} 条，待核实草稿 ${totals.uncertain} 条，无有效结果 ${totals.empty} 条，已变更跳过 ${totals.skipped} 条；未自动转正`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      const message = redactSensitiveText(String(error?.message ?? error)).slice(0, 300);
      for (const target of targets) {
        const entry = slangEntries.find(e => e.id === target.id && e.status === SLANG_STATUS.CANDIDATE);
        if (entry) entry.research = { ...entry.research, status: 'failed', finishedAt: new Date().toISOString(), message };
      }
      saveSlangStore();
      log('黑话研究失败:', message);
    } finally {
      for (const e of candidates) slangResearchingIds.delete(e.id);
      for (const e of candidates.filter(e => !targets.includes(e))) {
        const entry = slangEntries.find(x => x.id === e.id);
        if (entry?.research?.status === 'queued') entry.research = { ...entry.research, status: 'interrupted', finishedAt: new Date().toISOString(), message: '排队期间词条已变更，请按最新内容重新提交。' };
      }
      saveSlangStore();
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText, key = null) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return promptText;
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const relevant = key ? selectContextSlang(slangEntries, getSocialV2State(key)) : slangEntries;
      const block = buildSlangContext(relevant, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // Operator-only private dialogue acceptance leases. Never global config/test mode.
  const privateDialogueTests = new Map();
  const groupRehearsals = new Map();
  async function finishGroupRehearsal(key) {
    const test = groupRehearsals.get(key);
    if (!test) return;
    groupRehearsals.delete(key); clearTimeout(test.timer);
    const st = socialV2.conversations.get(key);
    if (st) st.agentToken = ''; // Revoke before awaiting model cancellation.
    const sid = state.sessions[key];
    if (sid) { try { await api.stopSessionWork(sid); } catch {} }
    retireSession(key);
    socialV2.conversations.delete(key);
    if (sid) { try { await api.workspace.archiveSession({ sessionId: sid }); } catch {} }
  }
  function rehearsalPrompt(key, reason) {
    const st = getSocialV2State(key);
    return currentRoleHintV2(key) + '\n\n' + buildExpressionHint(st, { enabled: false })
      + '\n' + livedContextV2(key, st, reason) + '\n' + formatMemoryV2(st, {messages:privateTestRecent(key,st)})
      + (groupRehearsals.get(key)?.privateScene?'\n【隔离私聊排演】你和一个模拟朋友正在私聊。只有模拟消息，没有真人或旧私聊资料。按私聊回应，不点评测试过程。'+privateConversationHint(st,{key:'private:fixture'}):'\n【隔离群聊排演】这是多个模拟网友的群聊。按真实群聊回应，不点评测试过程。只有这些模拟消息，没有真人或旧群资料；如附有阅读经历，那是管理员明确选入的公开材料笔记。')
      + '会话 key=' + key + '，令牌=' + st.agentToken + '。所有发言用 qq_send_message/qq_reply，回复由本地捕获，不发到QQ。'
      + '分别认清说话人，不替另一个人回答。先读取本次快照；'+(reason==='proactiveCheck'?PROACTIVE_CONVERSATION+'\n'+leisureHintFor(key,'',{share:true,recentMessages:privateTestRecent(key,st),now:Date.now()}):'处理本次消息。')
      + (groupRehearsals.get(key)?.continuous?'回复后继续等待本轮后续消息，按返回的 conversation 更新意图；只有对方明确结束再 qq_set_wake_config(mode="diving",infinite=true,triggers={atMention:true},throughSeq=readThroughSeq) 收尾。':'完成后 qq_mark_read(throughSeq=本次最后seq)，qq_set_wake_config(mode="diving", infinite=true, triggers={atMention:true}, throughSeq=本次最后seq)。')
      + (groupRehearsals.get(key)?.continuous?'本排演会在同一轮继续来消息，回复后可 qq_wait_for_messages(timeoutMs=30000) 接着聊；对方明确结束再收尾，不要每次重新取角色。':'本排演按批投递，不需要长等待；')+'可用 qq_experience 和共同事件/约定记忆保存本批有依据的经历；'
      + (groupRehearsals.get(key)?.styleFixtures ? buildStickerStrategyHint()+'\nqq_list_stickers/qq_send_sticker 和 qq_bili_info(search/recommend)为固定模拟结果，可按需使用；数据标为模拟，不是真实观看资料。原生小黄豆和 Emoji 也只在本地捕获。不要语音、全局人物、社交写入或其他群工具。' : '不要调用网络、表情、语音、全局人物或其他群工具。');
  }
  // During a fresh-context acceptance run, retain local chat records but hide
  // pre-switch messages from model-facing replay/read tools. Saved memory stays visible.
  const privateTestRecent = (key, st) => {
    const test = privateDialogueTests.get(key) || groupRehearsals.get(key), recent = st.recentMessages || [];
    if (!test || test.freshBoundarySeq === undefined || Date.now() >= test.expiresAt) return recent;
    return recent.filter(m => Number.isSafeInteger(m?.seq) ? m.seq > test.freshBoundarySeq : Number(m?.time) >= test.freshStartedAt);
  };
  const finishPrivateDialogueTest = (key) => {
    const test = privateDialogueTests.get(key);
    if (!test) return false;
    clearTimeout(test.timer);
    const st = getSocialV2State(key), quiet = new Set(expressionTargets(st.expressionQuietTargets));
    if (test.originalQuiet) quiet.add(test.owner); else quiet.delete(test.owner);
    st.expressionQuietTargets = [...quiet];
    for (const msg of st.recentMessages) {
      if (!msg.isSelf && msg.seq > test.startSeq && !String(msg.messageId || '').startsWith(`${test.runId}:`)) observeExpressionPreference(st, msg);
    }
    privateDialogueTests.delete(key);
    saveSocialV2State();
    return true;
  };
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      const fromDsh = ns?.value ? normalizeModeInput(ns.value.mode) : null;
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return currentMode === 'reserved2' && groupRehearsals.has(key) && Date.now() < groupRehearsals.get(key).expiresAt;
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    const wasSilent = snowlumaHealth.lastPacketAt > 0 && Date.now() - snowlumaHealth.lastPacketAt > 90000;
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
    if (wasSilent) queueHistoryRecoveryV2('packets-resumed');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    const recovered = snowlumaHealth.good === false && good === true;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
    if (recovered) queueHistoryRecoveryV2('receive-restored');
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  async function resetSessionContext(key, { preserveMemory = false, summary = '', archivePrevious = true } = {}) {
    const oldSessionId = state.sessions[key];
    if (!oldSessionId) throw new Error('会话不存在');
    if (sessionResettingKeys.has(key)) throw new Error('会话正在重置');
    sessionResettingKeys.add(key);
    const retained = socialV2.conversations.get(key);
    try {
      // Automatic reset must succeed in stopping DSH before clearing its count/state.
      if (preserveMemory) {
        await api.stopSessionWork(oldSessionId);
        if (state.sessions[key] !== oldSessionId) throw new Error('重置期间会话已变化');
      }
      sessionEpoch++;
      delete state.sessions[key];
      modelAppliedSessions.delete(oldSessionId);
      // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
      delete state.sessionPolicies[key];
      reverse.delete(oldSessionId);
      collectors.delete(oldSessionId);
      sendToolSucceededSessions.delete(oldSessionId);
      pendingSendToolCalls.delete(oldSessionId);
      v2TurnStartAt.delete(oldSessionId);
      toolCallNames.delete(oldSessionId);
      const pe = pending.get(key);
      if (pe) {
        clearTimeout(pe.timer);
        cancelPendingEntry(pe).catch(() => {});
      }
      pending.delete(key);
      queued.delete(key);
      queuedHintAt.delete(key);
      sessionPromises.delete(key);
      drainPromptQueue(key, '会话已重置');
      social.recentMessages.delete(key);
      messageMediaStore.delete(key);
      social.pendingSummaries.delete(key);
      social.states.delete(key);
      social.silentContext.delete(key);
      social.silentTurns.delete(oldSessionId);
      social.exitingSessions.delete(oldSessionId);
      slangWindows.delete(key);
      slangExtractionCooldowns.delete(key);
      slangSubmitTimes.delete(key);
      cancelSocialTimers(key);
      clearSocialV2Timers(key);
      disarmPendingWakeLease(key);
      pendingWakeKeys.delete(key);
      wakeConfigUpdatedKeys.delete(key);
      markReadCalledKeys.delete(key);
      wakeConfigMissCount.delete(key);
      forgetAgentToken(key);
      if (preserveMemory && retained) {
        retained.agentToken = crypto.randomBytes(16).toString('hex');
        rememberAgentToken(key, retained.agentToken);
        retained.bootstrapSent = false;
        retained.modelSeenSeqs = new Set();
        retained.msgSinceReset = 0;
        if (summary) appendMemoryV2(retained, 'activeTopic', summary, {});
      } else {
        socialV2.conversations.delete(key);
        seenForwardIds.delete(key);
      }
      saveSocialV2State();
      saveState();

      if (!preserveMemory) {
        try { await api.stopSessionWork(oldSessionId); }
        catch (error) { log('⚠️ 停止旧会话失败 ' + key + ':', error?.message ?? error); }
      }
      if (archivePrevious) {
        try { await api.workspace.archiveSession({ sessionId: oldSessionId }); }
        catch (error) { log('⚠️ 归档旧会话失败 ' + key + ':', error?.message ?? error); }
      }
      return { key, archived: oldSessionId };
    } finally {
      sessionResettingKeys.delete(key);
      if (preserveMemory && socialV2.conversations.get(key) === retained) {
        scheduleProactiveCheckV2(key);
        setupSleepTimerV2(key);
        if (retained.unread.length) scheduleWakeV2(key, 'bootstrap');
      }
    }
  }

  async function sendAgentActionV2(key, token, flag, action, params, spokenText = null) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const sending = sendChain.then(async () => {
      try { assertSendAllowed(); }
      catch (error) { error.statusCode = 403; throw error; }
      if (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
          || sessionResettingKeys.has(key) || socialV2.conversations.get(key) !== st || st.agentToken !== token
          || !v2ToolEnabled(flag) || shouldBlockSilentReply(key)) {
        const error = new Error('动作已取消：会话权限、模式、静默状态或工具开关已变化'); error.statusCode = 403; throw error;
      }
      if (spokenText !== null && (SENSITIVE_RE.test(spokenText) || [...KNOWN_AGENT_TOKENS].some((t) => t && spokenText.includes(t)))) {
        const error = new Error('消息含敏感信息，已阻止发送'); error.statusCode = 403; throw error;
      }
      const now = Date.now();
      const send = cfg.socialV2?.send ?? {};
      const minute = Number(send.maxSendPerMinute) || 0; const hour = Number(send.maxSendPerHour) || 0;
      if ((minute > 0 && st.sendTimes.filter((t) => now - t < 60000).length >= minute)
          || (hour > 0 && st.sendTimes.filter((t) => now - t < 3600000).length >= hour)) {
        const error = new Error('发送频率超限，请稍后再试'); error.statusCode = 429; throw error;
      }
      st.sendTimes.push(now);
      try {
        const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const response = await fetch(base + '/' + action, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {}) },
          body: JSON.stringify(params), signal: AbortSignal.timeout(15000)
        });
        const body = await response.json();
        if (!response.ok || body.status !== 'ok' || (body.retcode !== undefined && body.retcode !== 0)) throw new Error('OneBot 动作失败: ' + (body.wording ?? body.retcode ?? response.status));
        if (spokenText !== null) {
          recordSentMessagesV2(key, [spokenText]);
          st.lastAiReplyAt = Date.now(); st.wakeConfig.noActionCount = 0;
        }
        st.lastActionAt = Date.now(); st.sendTimes = st.sendTimes.slice(-500); saveSocialV2State();
        return body.data ?? {};
      } catch (error) {
        const index = st.sendTimes.indexOf(now); if (index >= 0) st.sendTimes.splice(index, 1);
        saveSocialV2State(); throw error;
      }
    });
    sendChain = sending.catch(() => {});
    return sending;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      let bodyPromise;
      const readBody = () => bodyPromise ||= new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1（缺令牌时 x-agent-token 为空串），这里只要看到
      // 这个声明就要求令牌必须命中某个活跃会话，端点自己漏写校验也不会退回管理端。
      if (req.headers['x-agent-call'] !== undefined) {
        if (!isLiveAgentToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '未授权：智能体调用必须携带有效的会话令牌' }, 403);
          return;
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // Rehearsal credentials are bound to one synthetic conversation and text tools only.
        if (req.headers['x-agent-token']) {
          for (const [testKey, test] of groupRehearsals) {
            if (!agentTokenOk(testKey, req.headers['x-agent-token'])) continue;
            const routes = ['/api/socialV2/prompt', '/api/socialV2/unread', '/api/socialV2/recent', '/api/socialV2/my-recent',
              '/api/socialV2/mark-read', '/api/socialV2/wake-config', '/api/socialV2/send-message', '/api/socialV2/send-burst', '/api/send/reply',
              '/api/socialV2/experience', '/api/socialV2/memory', '/api/socialV2/memory-append', '/api/socialV2/memory-update',
              ...(test.styleFixtures?['/api/socialV2/sticker-list','/api/socialV2/send-sticker','/api/socialV2/bili-discovery','/api/socialV2/react']:[]),...(test.continuous?['/api/socialV2/wait']:[])];
            const data = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody();
            if (Date.now() >= test.expiresAt || !routes.includes(url.pathname) || data.key !== testKey) {
              sendJson({ ok: false, error: '隔离排演只能读取和回复本批模拟消息' }, 403); return;
            }
            if (url.pathname === '/api/socialV2/memory-append' && !CONTINUITY_CATEGORIES.includes(data.category)) { sendJson({ok:false,error:'排演只能写本批共同事件/约定'},403); return; }
            if (url.pathname === '/api/socialV2/memory-update' && !CONTINUITY_CATEGORIES.includes(data.category)) { sendJson({ok:false},403); return; }
            const testState = getSocialV2State(testKey);
            if (data.replyToMessageId != null && !testState.recentMessages.some(m => String(m.messageId || '') === String(data.replyToMessageId))) {
              sendJson({ ok: false, error: '只能引用本次模拟消息' }, 403); return;
            }
            if (data.atUserId != null && !testState.recentMessages.some(m => String(m.userId || '') === String(data.atUserId))) {
              sendJson({ ok: false, error: '只能提及模拟角色' }, 403); return;
            }
            if (url.pathname === '/api/socialV2/wake-config'&&!test.continuous) testState.preSleepWaitSatisfiedAt = Date.now();
          }
        }
        // During an explicitly started private acceptance run, only that session's
        // text/dialogue and journal tools are available. Other chats are unaffected.
        if (req.headers['x-agent-token']) {
          for (const [testKey, test] of privateDialogueTests) {
            if (Date.now() >= test.expiresAt) { finishPrivateDialogueTest(testKey); continue; }
            if (!agentTokenOk(testKey, req.headers['x-agent-token'])) continue;
            const allowed = ['/api/status', '/api/socialV2/prompt', '/api/socialV2/state',
              '/api/socialV2/unread', '/api/socialV2/recent', '/api/socialV2/my-recent',
              '/api/socialV2/wake-config', '/api/socialV2/mark-read', '/api/socialV2/wait',
              '/api/socialV2/check-send', '/api/socialV2/message-detail', '/api/socialV2/memory',
              '/api/socialV2/send-message', '/api/socialV2/send-burst',
              '/api/socialV2/memory-append', '/api/socialV2/memory-update', '/api/socialV2/feedback', '/api/socialV2/experience',
              '/api/send/private', '/api/send/reply'];
            if (!allowed.includes(url.pathname)) {
              sendJson({ ok: false, error: '维护验收只允许当前私聊的文字对话和共同事件/约定工具' }, 403); return;
            }
            if (test.freshBoundarySeq !== undefined && url.pathname === '/api/socialV2/message-detail') {
              sendJson({ ok: false, error: '跨上下文记忆验收期间不读取旧消息详情，请使用保存的记忆' }, 403); return;
            }
          }
        }
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/recover'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (url.pathname === '/api/leisure' && ['GET','POST'].includes(req.method)) {
          if(req.headers['x-agent-call']!==undefined||req.headers['x-agent-token']!==undefined){sendJson({ok:false,error:'该接口仅控制台可用'},403);return;}
          try {
            if(req.method==='GET'){sendJson({ok:true,...leisureOf().status()});return;}
            const body=await readBody();
            if(body.action==='run'){
              const check=leisureEligibility({manual:true});if(!check.ok){sendJson({ok:false,error:check.reason},409);return;}
              const view=leisureOf().status(),itemId=String(body.itemId||'');
              if(!view.settings.enabled||view.phase!=='idle'){sendJson({ok:false,error:'后台活动已暂停或有任务正在进行'},409);return;}
              if(view.todayAttempts>=view.settings.dailyLimit){sendJson({ok:false,error:'达到今日处理上限'},429);return;}
              if(!view.items.some(i=>(!itemId||i.id===itemId)&&i.enabled!==false&&!i.complete&&(!i.laterUntil||i.laterUntil<=Date.now()))){sendJson({ok:false,error:'这份材料当前没有可继续的段落'},409);return;}
              void leisureOf().run({manual:true,itemId:String(body.itemId||'')}).then(r=>log('[兴趣与日常] '+(r.ok?'已保存一段阅读笔记':r.error||r.reason))).catch(()=>log('[兴趣与日常] 保存或处理失败；未证明进度'));
              sendJson({ok:true,scheduled:true});return;
            }
            if(body.action!=='edit'){sendJson({ok:false,error:'请选择保存设置或读一段'},400);return;}
            sendJson({ok:true,...leisureOf().edit(body)});
          }catch{sendJson({ok:false,error:'资料或设置无效，现有记录未被替换'},400);}
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            build: BRIDGE_RUNTIME_BUILD,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            messageRecovery: {enabled:cfg.socialV2?.recovery?.enabled!==false,intervalMs:RECOVERY_INTERVAL_MS,
              conversations:[...socialV2.conversations].filter(([key])=>!EPHEMERAL_GROUP_KEYS.has(key)).map(([key,st])=>{
                const r=normalizeRecovery(st.historyRecovery);return {key,lastCheckedAt:r.lastCheckedAt,lastImportedAt:r.lastImportedAt,imported:r.imported,historyOnly:r.historyOnly,limited:r.limited,error:r.error};
              })},
            dailyReview: reviewSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (url.pathname === '/api/socialV2/review' && (req.method === 'GET' || req.method === 'POST')) {
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) { sendJson({ ok: false, error: '复盘管理仅限操作者' }, 403); return; }
          const result = req.method === 'POST' ? reviewTick() : null;
          sendJson({ ok: true, ...reviewSnapshot(), ...(result || {}) }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          const previous=readJsonSafe(ROLE_STATE_FILE,{role:null,mode:'active'},true);
          const switched=previous.role===from;
          const perKeyFollowed=Object.values(previous.perKey||{}).filter(name=>name===from).length;
          const renamed=renameRoleReferences(previous,from,to);
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          try{if(switched||perKeyFollowed)atomicWriteJson(ROLE_STATE_FILE,renamed);}
          catch(error){fs.renameSync(roleFilePath(to),roleFilePath(from));throw error;}
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched, perKeyFollowed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = resolvePresetName(url.searchParams.get('preset'));
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          try {
            sendJson({ ok: true, backups: listPresetBackups(resolvePresetName(url.searchParams.get('preset'))) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = resolvePresetName(body.preset);
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          const queued = queueSlangResearch(candidates);
          if (queued.unavailable) { sendJson({ ok: false, error: 'DSH 未就绪或黑话库无法写入，未提交研究。' }, 503); return; }
          sendJson({ ok: true, ...queued });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState(key);
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {}, proactiveActivity: proactiveActivityV2() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'socialLookup', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability', 'dailyMaxPerKey']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.activityBoost !== undefined) merged.proactive.activityBoost = merged.proactive.activityBoost === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          if (!paused) queueHistoryRecoveryV2('unpaused');
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          if (groupRehearsals.has(key)) {
            const fixture=groupRehearsals.get(key).styleFixtures;
            sendJson({ ok: true, key, role: { name: readRoleState(key).role, hint: rehearsalPrompt(key) },
              recommended: { send: cfg.socialV2?.send, wait: cfg.socialV2?.wait }, enabledTools: ['qq_send_message','qq_reply','qq_mark_read','qq_set_wake_config',...(groupRehearsals.get(key).continuous?['qq_wait_for_messages']:[]),...(fixture?['qq_list_stickers','qq_send_sticker','qq_bili_info']:[])],
              nativeFaces:fixture?nativeFaceContext(faceCatalogV2()):{enabled:false},
              unreadCount: st.unread.length, recentCount: st.recentMessages.length, currentWakeConfig: st.wakeConfig,
              replyTiming: replyTimingV2(st), memory: '', slang: { enabled: false }, stickers: fixture?{enabled:true,context:'可按需查询模拟表情；有笑到拍桌、无语凝视、收尾挥手三类，不必逢句发'}:{ enabled: false }, voices: { enabled: false } }); return;
          }
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState(key);
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            socialLookup: 'qq_social_lookup',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_update / qq_memory_query / qq_memory_remove / qq_memory_clear / qq_experience',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2(key, ['space','examples','tools'].includes(url.searchParams.get('scene')) ? url.searchParams.get('scene') : 'chat') + '\n\n' + ticsText({ ...st, recentMessages: privateTestRecent(key, st) }, key) : currentRoleHint(key),
              details:conversationRole(roleHintForMode('v2',key)).availableDetails,
              detailHint:'默认只取日常聊天需要的角色规则；空间/资料规则用 qq_get_prompt(scene="space")，原回复示例用 scene="examples"，操作参考用 scene="tools" 按需读取。当前工具协议与当轮边界优先，完整源卡保留在控制台。' },
            affinity: personAffinityViewV2(key,st),
            experienceHint: livedContextV2(key,st),
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            nativeFaces: v2ToolEnabled('sendMessage') ? nativeFaceContext(faceCatalogV2()) : {enabled:false},
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st, { messages: privateTestRecent(key, st) }),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: selectContextSlang(confirmedSlangListV2(), st),
              block: buildSlangContext(selectContextSlang(slangEntries, st), cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8,stickerSelectionV2(key,st)) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq,conversation:currentConversationV2(key,st,messages) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const recent = req.headers['x-agent-token'] ? privateTestRecent(key, st) : st.recentMessages;
          const start = Math.max(0, recent.length - offset - limit);
          const end = Math.max(0, recent.length - offset);
          const messages = recent.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq,conversation:currentConversationV2(key,st,messages) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st) && !!req.headers['x-agent-token']) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        // ── 游戏状态 / 掷骰（本机改动 2026-10-06）───────────────────────────
        if (url.pathname === '/api/socialV2/game' && (req.method === 'GET' || req.method === 'POST')) {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const isAgent = !!req.headers['x-agent-token'];
          if (isAgent && !v2ToolEnabled('game')) { sendJson({ ok: false, error: '工具未启用：qq_game_state' }, 403); return; }
          if (req.method === 'GET') { sendJson({ ok: true, ...gameSnapshot(key) }); return; }
          const action = String(body.action ?? '').trim();
          const g = gameOf(key);
          try {
            if (action === 'roll') {
              const r = rollDice(body.expr ?? body.dice ?? '1d100');
              if (r.error) { sendJson({ ok: false, error: r.error }, 400); return; }
              gameLog(g, 'roll', `${r.expr} = ${r.total}（${r.rolls.join(',')}）`);
              g.updatedAt = Date.now();
              saveGameState();
              sendJson({ ok: true, ...r });
              return;
            }
            if (action === 'score') {
              const target = String(body.target ?? '').trim();
              const delta = Math.round(Number(body.delta ?? 0));
              if (!target) { sendJson({ ok: false, error: '要指定 target（谁）' }, 400); return; }
              if (!Number.isFinite(delta) || delta === 0) { sendJson({ ok: false, error: 'delta 必须是非零整数' }, 400); return; }
              if (Math.abs(delta) > 1000) { sendJson({ ok: false, error: '单次最多 ±1000' }, 400); return; }
              const now = Math.max(-99999, Math.min(99999, (Number(g.scores[target]) || 0) + delta));
              g.scores[target] = now;
              gameLog(g, 'score', `${target} ${delta > 0 ? '+' : ''}${delta} → ${now}（${String(body.reason ?? '').slice(0, 40)}）`);
              g.updatedAt = Date.now();
              saveGameState();
              sendJson({ ok: true, target, delta, score: now, ...gameSnapshot(key) });
              return;
            }
            if (action === 'title') {
              const target = String(body.target ?? '').trim();
              if (!target) { sendJson({ ok: false, error: '要指定 target（谁）' }, 400); return; }
              const title = String(body.title ?? '').trim().slice(0, 24);
              if (title) g.titles[target] = title; else delete g.titles[target];
              gameLog(g, 'title', `${target} → ${title || '(清除)'}`);
              g.updatedAt = Date.now();
              saveGameState();
              sendJson({ ok: true, ...gameSnapshot(key) });
              return;
            }
            if (action === 'stat') {
              const field = String(body.field ?? '').trim();
              if (!['games', 'wins', 'losses'].includes(field)) { sendJson({ ok: false, error: 'field 只能是 games/wins/losses' }, 400); return; }
              g.stats[field] = Math.max(0, (Number(g.stats[field]) || 0) + (Math.round(Number(body.delta ?? 1)) || 1));
              g.updatedAt = Date.now();
              saveGameState();
              sendJson({ ok: true, ...gameSnapshot(key) });
              return;
            }
            if (action === 'session') {
              const game = String(body.game ?? '').trim();
              if (!game) { g.session = null; gameLog(g, 'session', '清空进行中的一局'); }
              else { g.session = { game: game.slice(0, 40), state: body.state && typeof body.state === 'object' ? body.state : {}, startedAt: Date.now() }; gameLog(g, 'session', '开始：' + game.slice(0, 40)); }
              g.updatedAt = Date.now();
              saveGameState();
              sendJson({ ok: true, ...gameSnapshot(key) });
              return;
            }
            if (action === 'reset') {
              if (isAgent) { sendJson({ ok: false, error: '清空战绩只能由管理员在控制台操作' }, 403); return; }
              const st = loadGameState();
              delete st.conversations[key];
              saveGameState();
              sendJson({ ok: true, ...gameSnapshot(key) });
              return;
            }
            if (action === 'get' || action === '') { sendJson({ ok: true, ...gameSnapshot(key) }); return; }
            sendJson({ ok: false, error: 'action 必须是 roll/score/title/stat/session/get/reset' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
          }
          return;
        }

        // ── 对外形象：空间 / 资料（本机改动 2026-10-06）─────────────────────
        if (url.pathname === '/api/socialV2/self' && (req.method === 'GET' || req.method === 'POST')) {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!selfCfgEnabled()) { sendJson({ ok: false, error: '对外形象未启用（config.json 的 socialV2.self）' }, 400); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('selfAction')) { sendJson({ ok: false, error: '工具未启用：selfAction' }, 403); return; }
          if (req.method === 'GET') {
            const original = loadQzoneState();
            const st = original.dayKey === localDayKey() ? original : { ...original, postedToday: 0, profileChangedToday: 0 };
            const c = selfCfg();
            let profile = null;
            let feeds = null;
            let ownSpaceReadOk = false;
            try { profile = await selfProfileRead(); } catch (error) { profile = { error: String(error?.message ?? error) }; }
            try { feeds = (await selfActionsOf().ownPosts()).posts; ownSpaceReadOk = true; } catch { feeds = null; }
            const savedDraft = st.pending;
            const pd = savedDraft && Date.now() - Number(savedDraft.createdAt || 0) <= Math.max(60000, Number(c.approvalTimeoutMs ?? 1800000)) ? savedDraft : null;
            sendJson({
              ok: true,
              profile,
              policy: selfActionPolicy(c),
              qzone: {
                pending: pd ? { action: pd.action, preview: String(pd.content ?? pd.nickname ?? '').slice(0, 200), createdAt: pd.createdAt } : null,
                todayPosted: Number(st.postedToday || 0),
                maxPerDay: Math.max(0, Number(c.qzoneMaxPerDay ?? 1)),
                maxChars: Math.max(1, Number(c.qzoneMaxChars ?? 300)),
                todayProfileChanges: Number(st.profileChangedToday || 0),
                maxProfilePerDay: Math.max(0, Number(c.profileMaxPerDay ?? 1)),
                history: st.history.slice(0, 10),
                feeds, // Compatibility name; these are now only the account's own posts.
                posts: feeds, feedScope: 'self', readOk: ownSpaceReadOk,
                operations: (st.operations || []).slice(-10).map(o => ({ id: o.id, kind: o.kind, status: o.status, at: o.at, verifiedAt: o.verifiedAt ?? null }))
              }
            });
            return;
          }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('selfAction')) { sendJson({ ok: false, error: '工具未启用：qq_qzone_post / qq_set_profile' }, 403); return; }
          const action = String(body.action ?? '').trim();
          try {
            if (action === 'qzone') {
              if (cfg.socialV2?.self?.qzoneRequiresApproval === false) {
                // 本机改动：管理员放开了审批 → 直接发（这个号没有别的好友）
                const c = selfCfg();
                const content = String(body.content ?? '').trim();
                const maxChars = Math.max(1, Number(c.qzoneMaxChars ?? 300));
                const st0 = rollSelfDay();
                const maxPerDay = Math.max(0, Number(c.qzoneMaxPerDay ?? 1));
                if (!content) { sendJson({ ok: false, error: '说说内容不能为空' }, 400); return; }
                if (content.length > maxChars) { sendJson({ ok: false, error: `说说最多 ${maxChars} 字` }, 400); return; }
                if (SENSITIVE_RE.test(content)) { sendJson({ ok: false, error: '内容含敏感信息特征，已拒绝' }, 400); return; }
                const pub = await qzonePublish(content);
                sendJson({ ok: true, published: true, tid: pub?.tid ?? null, verified: pub.verified, duplicate: pub.duplicate === true, operationId: pub.operationId ?? null });
                return;
              }
              const draft = await qzoneSubmitDraft(key, body.content);
              sendJson({ ok: true, pending: true, requiresApproval: true, id: draft.id, hint: '草稿已发给管理员，等他回复「通过」或「拒绝」' });
              return;
            }
            if (action === 'profile') {
              const wantNick = body.nickname !== undefined && String(body.nickname ?? '').trim() !== '';
              const needApproval = cfg.socialV2?.self?.nicknameRequiresApproval !== false;
              if (wantNick && !needApproval) {
                // 本机改动：管理员放开了审批 → 直接改（这个号没有别的好友）
                const applied = await selfProfileWrite({ nickname: body.nickname, signature: body.signature, sex: body.sex });
                sendJson({ ok: true, applied });
                return;
              }
              if (wantNick) {
                if (body.signature !== undefined) { const signature = String(body.signature ?? '').trim(); if (signature.length > 60 || SENSITIVE_RE.test(signature)) throw new Error('签名长度或内容不符合要求'); publicSelfGuard(signature); }
                if (body.sex !== undefined && ![0, 1, 2].includes(Number(body.sex))) throw new Error('sex 只能是 0/1/2');
                const nn = String(body.nickname).trim();
                if (SENSITIVE_RE.test(nn)) { sendJson({ ok: false, error: '昵称含敏感信息特征' }, 400); return; }
                if (nn.length > 24) { sendJson({ ok: false, error: '昵称最多 24 字' }, 400); return; }
                if (pendingSelfAction()) { sendJson({ ok: false, error: '还有一条待审批（管理员回「通过」或「拒绝」后才行）' }, 400); return; }
                const ownerKey = selfOwnerKey();
                const nickDraft = {
                  kind: 'selfAction', action: 'nickname', nickname: nn, signature: body.signature, sex: body.sex,
                  content: `（改昵称）${nn}`, id: crypto.randomBytes(4).toString('hex'), createdAt: Date.now()
                };
                pending.set(ownerKey, nickDraft);
                persistSelfPending(nickDraft);
                await sendToQQ(ownerKey, `📝 她想把 QQ 昵称改成：${nn}${body.signature !== undefined ? '\n同时更新签名：' + String(body.signature).slice(0, 60) : ''}${body.sex !== undefined ? '\n同时更新性别字段：' + String(body.sex) : ''}\n回复「通过」修改 / 「拒绝」不改`);
                sendJson({ ok: true, pending: true, requiresApproval: true, hint: '昵称改动要管理员确认（会显示在所有群里）' });
                return;
              }
              const applied = await selfProfileWrite({ signature: body.signature, sex: body.sex });
              sendJson({ ok: true, applied });
              return;
            }
            sendJson({ ok: false, error: 'action 必须是 qzone（发说说）或 profile（改资料）' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
          }
          return;
        }

        // ── 心情 / 精力（本机改动 2026-10-06）───────────────────────────────
        if (url.pathname === '/api/socialV2/mood' && (req.method === 'GET' || req.method === 'POST')) {
          const body = req.method === 'POST' ? await readBody() : {};
          const key = String((req.method === 'GET' ? url.searchParams.get('key') : body.key) ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (moodCfg().enabled === false) { sendJson({ ok: false, error: '心情系统未启用（config.json 的 socialV2.mood）' }, 400); return; }
          if (req.method === 'POST') {
            if (req.headers['x-agent-token'] && !v2ToolEnabled('moodAdjust')) { sendJson({ ok: false, error: '工具未启用：qq_mood_adjust' }, 403); return; }
            const result = moodAdjust(body.moodDelta, body.energyDelta, body.reason);
            log(`心情 ${result.applied.mood >= 0 ? '+' : ''}${result.applied.mood} / 精力 ${result.applied.energy >= 0 ? '+' : ''}${result.applied.energy} → 心情 ${result.value}「${result.moodLabel}」 精力 ${result.energy}｜${String(body.reason ?? '').slice(0, 40)}`);
            sendJson({ ok: true, ...result });
            return;
          }
          sendJson({ ok: true, ...moodSnapshot() });
          return;
        }

        // ── 好感度（本机改动 2026-10-06）─────────────────────────────────────

        // ── 追番管理（本机改动 2026-10-07 用户要求增强可控性）──────────────────
        // GET  返回：在追 / 队列 / 已看完·已弃 / 库 / 参数 / 最近 7 天时间线
        // POST 动作：watch(开始追) drop(弃番) restore(捞回来) remove(移除) setProgress(改集数)
        //           addCatalog(加新番，可带标签) delCatalog(删库) params(改参数)
        if (url.pathname === '/api/socialV2/anime-admin') {
          const a = loadAnime();
          if (req.method === 'GET') {
            const catalog = animeCatalog();
            const days = [];
            for (let i = 6; i >= 0; i -= 1) {
              const d = new Date(); d.setDate(d.getDate() - i);
              const key = localDayKeyStr(d);
              const hit = (a.history ?? []).filter((h) => String(h.day ?? '').slice(0, 10) === key);
              days.push({ day: key.slice(5), count: hit.reduce((sum,h)=>sum+(Number.isFinite(Number(h.episodes))?Math.max(0,Number(h.episodes)):1),0) });
            }
            sendJson({
              ok: true,
              watching: (a.watching ?? []).map((w) => ({ title: w.title, watched: w.watched, total: w.total, tags: w.tags ?? [] })),
              queue: a.queue ?? [],
              finished: (a.finished ?? []).slice(-30).reverse(),
              catalog: catalog.map((x) => ({ title: x.title, total: x.total, tags: x.tags ?? [] })),
              params: { perDayMax: animeCfg().perDayMax ?? 2, maxWatching: animeCfg().maxWatching ?? 2, autoChance: animeCfg().autoChance ?? 0.7, dropRate: animeCfg().dropRate ?? 0.08, dailyCompletionTarget: animeSummaryV2(a).target },
              today: animeSummaryV2(a).advancedToday, autoDay: a.autoDay ?? null, day: a.day ?? null, automation: animeAutomationStatusV2(),
              timeline: days, canAnimeToday: (dailyStateMeta()?.canAnime !== false)
            });
            return;
          }
          const b = await readBody();
          const act = String(b.action ?? '').trim();
          const t = String(b.title ?? '').trim();
          const out = { ok: false };
          if (act === 'watch' && t) {
            const cat = animeCatalog().find((x) => x.title === t);
            a.watching = Array.isArray(a.watching) ? a.watching : [];
            if (a.watching.some((w) => w.title === t)) out.error = '已经在追了';
            else {
              a.watching.push({ title: t, watched: Number(b.ep) || 0, total: Number(b.total) || cat?.total || 12, tags: b.tags ?? cat?.tags ?? [], startedAt: Date.now() });
              out.ok = true; out.msg = '开始追《' + t + '》';
            }
          } else if (act === 'drop' && t) {
            const w = (a.watching ?? []).find((x) => x.title === t);
            if (!w) out.error = '没在追这部';
            else {
              a.watching = a.watching.filter((x) => x.title !== t);
              a.finished = Array.isArray(a.finished) ? a.finished : [];
              a.finished.push({ title: t, watched: w.watched, dropped: true, at: Date.now() });
              out.ok = true; out.msg = '弃了《' + t + '》（第 ' + w.watched + ' 集）';
            }
          } else if (act === 'restore' && t) {
            a.finished = Array.isArray(a.finished) ? a.finished : [];
            const f = a.finished.find((x) => x.title === t);
            if (!f) out.error = '历史里没有这部';
            else {
              a.finished = a.finished.filter((x) => x.title !== t);
              a.watching = Array.isArray(a.watching) ? a.watching : [];
              a.watching.push({ title: t, watched: f.watched ?? 0, total: f.total ?? 12, tags: [], restoredAt: Date.now() });
              out.ok = true; out.msg = '把《' + t + '》捞回来继续追';
            }
          } else if (act === 'remove' && t) {
            a.watching = (a.watching ?? []).filter((x) => x.title !== t);
            out.ok = true; out.msg = '已移出在追列表';
          } else if (act === 'advance' && t) {
            animeRollDay();
            // 本机改动（2026-10-07 用户反馈）：面板要能"指定某部番推一集"（原来是不指定、看不出来动的是哪部）
            const w = (a.watching ?? []).find((x) => x.title === t);
            if (!w) out.error = '没在追这部';
            else {
              w.watched = Number(w.watched || 0) + 1;
              w.lastAt = Date.now();
              a.advancedToday = Number(a.advancedToday || 0) + 1;
              a.history = Array.isArray(a.history) ? a.history : [];
              a.history.push({ day: localDayKeyStr(), title: t, ep: w.watched, episodes:1, at: Date.now(), by: '控制台指定' });
              if (a.history.length > 400) a.history.shift();
              out.ok = true; out.msg = '《' + t + '》推进到第 ' + w.watched + ' 集（今日共 ' + a.advancedToday + ' 集）';
              // 集数看完 → 自动换下一部（跟正常推进保持一致）
              if (Number(w.total) > 0 && w.watched >= Number(w.total)) {
                a.watching = (a.watching ?? []).filter((x) => x.title !== t);
                a.finished = Array.isArray(a.finished) ? a.finished : [];
                a.finished.push({ title: t, watched: w.watched, total: w.total, at: Date.now() });
                out.msg += '（已看完，移入"看过"）';
              }
            }
          } else if (act === 'setProgress' && t) {
            const w = (a.watching ?? []).find((x) => x.title === t);
            if (!w) out.error = '没在追这部';
            else { w.watched = Math.max(0, Number(b.ep) || 0); out.ok = true; out.msg = '《' + t + '》改成第 ' + w.watched + ' 集'; }
          } else if (act === 'addCatalog' && t) {
            const cat = animeCatalog();
            const raw = readJsonSafe(path.join(ROOT, 'state', 'anime-catalog.json'), null);
            const list = animeCatalogItems(raw);
            if (list.some((x) => x.title === t)) out.error = '库里已有';
            else {
              list.push({ title: t, total: Number(b.total) || 12, tags: Array.isArray(b.tags) ? b.tags.slice(0, 6) : [] });
              saveAnimeCatalogV2(raw,list);
              out.ok = true; out.msg = '已加入番剧库：《' + t + '》';
            }
          } else if (act === 'delCatalog' && t) {
            const raw = readJsonSafe(path.join(ROOT, 'state', 'anime-catalog.json'), null);
            const list = animeCatalogItems(raw);
            const after = list.filter((x) => x.title !== t);
            saveAnimeCatalogV2(raw,after);
            out.ok = true; out.msg = '已从库中删除：《' + t + '》';
          } else if (act === 'params') {
            cfg.socialV2 = cfg.socialV2 ?? {}; cfg.socialV2.anime = cfg.socialV2.anime ?? {};
            for (const k of ['perDayMax', 'maxWatching', 'autoChance', 'dropRate']) {
              if (b[k] !== undefined && Number.isFinite(Number(b[k]))) cfg.socialV2.anime[k] = Number(b[k]);
            }
            if(b.dailyCompletionTarget!==undefined)cfg.socialV2.anime.dailyCompletionTarget=Math.min(3,Math.max(1,Math.floor(Number(b.dailyCompletionTarget)||1)));
            atomicWriteJson(path.join(ROOT, 'config.json'), cfg);
            out.ok = true; out.msg = '参数已保存'; out.params = cfg.socialV2.anime;
          } else out.error = '未知动作或无标题';
          if (out.ok) { saveAnime(); log('[追番管理] ' + (out.msg ?? act)); }
          sendJson(out);
          return;
        }
        // ── 手动指定显示名（控制台）──────────────────────────────────────────
        // ── 加速测试开关（控制台/脚本用）────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/debug/testmode') {
          const b = await readBody();
          cfg.socialV2 = cfg.socialV2 ?? {};
          cfg.socialV2.debug = cfg.socialV2.debug ?? {};
          const cur = cfg.socialV2.debug.test ?? {};
          if (b.off === true) {
            cfg.socialV2.debug.test = { ...cur, enabled: false, until: 0 };
          } else {
            const mins = Number(b.minutes) || 15;
            cfg.socialV2.debug.test = {
              ...cur,
              enabled: true,
              until: Date.now() + mins * 60000,
              runId: b.runId || ('run-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)),
              scope: Array.isArray(b.scope) ? b.scope : (Array.isArray(cur.scope) ? cur.scope : []),
              dryRunExternal: b.dryRunExternal !== false,
              overrides: { ...(cur.overrides ?? {}), ...(b.overrides ?? {}) }
            };
            testStartSampler();
          }
          atomicWriteJson(path.join(ROOT, 'config.json'), cfg);
          log('[测试模式] ' + JSON.stringify(cfg.socialV2.debug.test).slice(0, 200));
          sendJson({ ok: true, test: cfg.socialV2.debug.test, active: testActive() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/debug/testmode') {
          sendJson({ ok: true, test: testCfg(), active: testActive(), scope: testScope() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/manual-name') {
          const b = await readBody();
          const q = String(b.qq ?? '').trim();
          if (!q) { sendJson({ ok: false, error: '需要 qq' }, 400); return; }
          const v = setManualName(q, b.name ?? null);
          log('[显示名] 手动指定 ' + q + ' → ' + (v ?? '（已清除，改回自动解析）'));
          sendJson({ ok: true, qq: q, name: v });
          return;
        }
        // ── 显示名表（控制台统一用真实昵称/群名；本机改动 2026-10-07）──────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/names') {
          await refreshContactCache(req.url.includes('refresh=1'));
          sendJson({ ok: true, ...(await displayNameTable()), cachedAt: contactCache.at, friends: Object.keys(contactCache.friends ?? {}).length, groups: Object.keys(contactCache.groups ?? {}).length });
          return;
        }
        // ── 耐心面板（本机改动 2026-10-07）────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/patience') {
          await refreshContactCache();
          const pc = patienceCfg();
          const list = [];
          for (const [k, stP] of socialV2.conversations ?? []) {
            try {
              patienceSample(stP);
              list.push({
                key: k,
                display: displayNameForKey(k).display,
                sub: displayNameForKey(k).sub,
                value: Math.round(patienceNow(stP)),
                level: patienceLevel(stP),
                factor: patienceFactor(stP),
                minutesToFull: patienceMinutesToFull(stP),
                history: Array.isArray(stP.patienceHistory) ? stP.patienceHistory : [],
                stats: stP.patienceStats ?? null,
                lastAiReplyAt: Number(stP.lastAiReplyAt) || 0,
                lastIncomingAt: Number(stP.lastIncomingAt) || 0
              });
            } catch {}
          }
          list.sort((a, b) => a.value - b.value);
          sendJson({
            ok: true, enabled: pc.enabled !== false, max: patienceMax(), list,
            params: {
              drainPerMessage: Number(pc.drainPerMessage) || 2,
              streakThreshold: Number(pc.streakThreshold) || 3,
              streakWindowMs: Number(pc.streakWindowMs) || 120000,
              replyGraceMs: Number(pc.replyGraceMs) || 120000,
              recoverPerMinute: Number(pc.recoverPerMinute) || 0.5,
              dayMultiplier: 0.5, nightMultiplier: 1.5,
              sleepRecoverMultiplier: Number(pc.sleepRecoverMultiplier) || 3,
              midThreshold: Number(pc.midThreshold) || 45, lowThreshold: Number(pc.lowThreshold) || 20,
              midFactor: Number(pc.midFactor) || 0.7, lowFactor: Number(pc.lowFactor) || 0.35
            }
          });
          return;
        }
        // 人物面板接口（本机改动 2026-10-07）：以**人物档案**为主表，动态合并外号与记忆
        // 全是现成数据，只读；人物档案里一有新人就会自动出现 ✅
        if (req.method === 'GET' && url.pathname === '/api/socialV2/people') {
          const people = loadPersons()?.people ?? {};
          const mem = (() => { try { return loadMemes(); } catch { return { byTarget: {} }; } })();
          const out = [];
          for (const p of Object.values(people)) {
            const qq = String(p.qq ?? "");
            if (!qq) continue;
            const nicknameInfo = consoleNicknameV2(qq);
            const nick = nicknameInfo.current?.state==='revoked'?'':nicknameInfo.current?.text||'';
            const key = state.sessions?.["private:" + qq] ? ("private:" + qq) : null;
            let memory = { activeTopic: [], pendingThought: [], memberImpression: [], person: [] };
            // ⚠️ 修正：记忆存在 state 顶层（activeTopics / pendingThoughts），不在 st.memory 下面
            try {
              const stP = socialV2.conversations.get("private:" + qq);
              memory.activeTopic = (stP?.activeTopics ?? []).map((x) => String(x.text ?? x));
              memory.pendingThought = (stP?.pendingThoughts ?? []).map((x) => String(x.text ?? x));
              memory.memberImpression = Object.entries(stP?.memberImpressions ?? {}).map(([k, v]) => k + ": " + String(v));
            } catch {}
            out.push({
              qq, name: displayNameForPerson(qq,p.name), nick, nicknameInfo,
              relation: (() => { try { const r0 = relationOf(p.qq, p.name); return (r0 && r0.label) || p.autoTier || ""; } catch { return p.autoTier ?? ""; } })(), affinity: Math.round(affinityNow(p)), label: affinityLabel(Math.round(affinityNow(p))),
              saidCount: p.msgCount ?? p.saidCount ?? null,
              tags: p.tags ?? [], lastAt: p.lastAt ?? null,
              // ⚠️ 修正：档案里的"印象"其实是 facts（公开）和 privateFacts（私聊知道的）
              facts: (p.facts ?? []).map((x) => String(x.text ?? x)),
              privateFacts: (p.privateFacts ?? []).map((x) => String(x.text ?? x)),
              memory, hasSession: !!key
            });
          }
          out.sort((a, b2) => String(a.name).localeCompare(String(b2.name)));
          sendJson({ ok: true, count: out.length, people: out });
          return;
        }
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/expr') {
          const L = exprLib() ?? { swear: [], tic: [], style: [] };
          if (req.method === "GET") { sendJson({ ok: true, expr: L }); return; }
          const body2 = await readBody();
          const kind = String(body2.kind ?? "swear");
          L[kind] = Array.isArray(L[kind]) ? L[kind] : [];
          if (body2.action === "add" && body2.w) {
            const w = String(body2.w).trim();
            if (w && !L[kind].some((x) => x.w === w)) L[kind].push({ w, use: String(body2.use ?? "") });
          } else if (body2.action === "del" && body2.w) {
            L[kind] = L[kind].filter((x) => x.w !== body2.w);
          }
          L.updatedAt = Date.now();
          fs.writeFileSync(path.join(STATE_DIR, "expression-lib.json"), JSON.stringify(L, null, 2));
          sendJson({ ok: true, expr: L });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/patience') {
          const b = await readBody();
          const out = {};
          if (b.params && typeof b.params === 'object') {
            cfg.socialV2.patience = { ...(cfg.socialV2.patience ?? {}) };
            for (const [k, v] of Object.entries(b.params)) {
              const num = Number(v);
              if (Number.isFinite(num)) cfg.socialV2.patience[k] = num;
            }
            out.params = cfg.socialV2.patience;
          }
          if (b.enabled !== undefined) { cfg.socialV2.patience = { ...(cfg.socialV2.patience ?? {}), enabled: b.enabled === true }; out.enabled = b.enabled === true; }
          if (b.key) {
            const stP = getSocialV2State(String(b.key));
            if (b.full === true) stP.patience = patienceMax();
            else if (b.zero === true) stP.patience = 0;
            else if (b.value !== undefined) stP.patience = Math.max(0, Math.min(patienceMax(), Number(b.value)));
            else stP.patience = Math.max(0, Math.min(patienceMax(), patienceNow(stP) + Number(b.delta ?? 0)));
            stP.patienceAt = Date.now();
            // 本机改动（2026-10-07 用户发现）：手动调整**不要每次都插走势点** ——
            // 走势是"每 10 分钟自动采样"的记录，手动调一次就插一个点会造出假历史
            //（实测测试期间把某个群插出了 8 个点）。手动调整只**就地更新最后一个点**，
            // 没有点时才新建。
            stP.patienceHistory = Array.isArray(stP.patienceHistory) ? stP.patienceHistory : [];
            const nowMs = Date.now();
            const curV = Math.round(patienceNow(stP));
            const lastPt = stP.patienceHistory[stP.patienceHistory.length - 1];
            if (lastPt && (nowMs - Number(lastPt.t)) < 10 * 60 * 1000) lastPt.v = curV;
            else {
              stP.patienceHistory.push({ t: nowMs, v: curV });
              if (stP.patienceHistory.length > 24) stP.patienceHistory.shift();
            }
            saveSocialV2State();
            out.key = String(b.key); out.value = Math.round(patienceNow(stP));
          }
          try { atomicWriteJson(path.join(ROOT, 'config.json'), cfg); } catch {}
          log('[耐心] 控制台更新：' + JSON.stringify(out).slice(0, 160));
          sendJson({ ok: true, ...out });
          return;
        }
        // ── 成本面板（读 DSH 的用量账本；本机改动 2026-10-07）──────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/cost') {
          const usageFile = path.join(process.env.USERPROFILE || ROOT, '.dsh', '.dshw-usage.json');
          const u = readJsonSafe(usageFile, null) ?? {};
          const events = Array.isArray(u.events) ? u.events : [];
          const today = localDayKeyStr();
          const todayEvents = events.filter((e) => e && e.day === today);
          // 按小时
          const byHour = Array.from({ length: 24 }, () => 0);
          for (const e of todayEvents) { const h = new Date(Number(e.ts)).getHours(); byHour[h] += Number(e.cost) || 0; }
          // 按"唤醒原因/会话"归因（本机改动 2026-10-07 修）：
          // 旧做法是"账单时间戳 vs bridge.log 里的唤醒行"直接比 —— 时区/格式一偏就全错开（实测全空）。
          // 新做法：① 主对齐源改成 **tool-calls.jsonl**（时间戳同源、还带会话 key，最可靠）；
          //          ② 时间戳自动做 ±12 小时容错（不管账单是 UTC 还是本地都能对上）；
          //          ③ 唤醒原因仍从 bridge.log 取，但用同样的容错窗口。
          const readToolCalls = () => {
            try {
              return fs.readFileSync(path.join(ROOT, 'state', 'tool-calls.jsonl'), 'utf8').split('\n')
                .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
                .filter((x) => x && x.type === 'call' && x.time);
            } catch { return []; }
          };
          const toolCalls = readToolCalls();
          const logLines = (() => { try { return fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8').split('\n'); } catch { return []; } })();
          const wakes = [];
          for (const line of logLines) {
            const m = line.match(/^\d{2}:(\d{2}):(\d{2}).*唤醒 (\S+)（([^）]+)）/);
            if (!m) continue;
            const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
            wakes.push({ t: d.getTime(), key: m[3 + 1], reason: m[5] });
          }
          // 把账单事件的时间戳统一"抬"到与本地记录同一坐标系（试 0 / ±8 / ±12 小时，取匹配最好的一种）
          const OFFSETS = [0, 8 * 3600000, -8 * 3600000, 12 * 3600000, -12 * 3600000];
          const EVENT_WINDOW = 300000;   // 5 分钟窗口
          const nearest = (list, t, getT) => {
            let best = null; let bestD = EVENT_WINDOW;
            for (const x of list) { const d = Math.abs(getT(x) - t); if (d < bestD) { bestD = d; best = x; } }
            return best;
          };
          let bestOffset = 0; let bestHit = -1;
          for (const off of OFFSETS) {
            let hit = 0;
            for (const e of todayEvents) if (nearest(toolCalls, Number(e.ts) + off, (x) => Date.parse(x.time))) hit += 1;
            if (hit > bestHit) { bestHit = hit; bestOffset = off; }
          }
          const byReason = {};
          const byKey = {};
          let attributed = 0; let unattributed = 0;
          for (const e of todayEvents) {
            const ts = Number(e.ts) + bestOffset; const cost = Number(e.cost) || 0;
            const call = nearest(toolCalls, ts, (x) => Date.parse(x.time));
            const wk = nearest(wakes, ts, (x) => x.t);
            if (call || wk) {
              if (wk) { const rk = String(wk.reason).split('@')[0]; byReason[rk] = (byReason[rk] ?? 0) + cost; }
              const convKey = call ? (String(call.args ?? '').match(/(group|private):\d+/) ?? [])[0] : null;
              const kk = convKey || (wk ? wk.key : null);
              if (kk) byKey[kk] = (byKey[kk] ?? 0) + cost;
              attributed += cost;
            } else unattributed += cost;
          }
          const round = (x) => Number(Number(x).toFixed(4));
          sendJson({
            ok: true,
            balance: Number(u.lastBalance) || 0,
            today: Number(u.todayUsage) || 0,
            history: u.history ?? {},
            todayEvents: todayEvents.length,
            byHour: byHour.map(round),
            byReason: Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, round(v)])),
            byKey: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, round(v)])),
            attributed: round(attributed), unattributed: round(unattributed),
            matchOffsetHours: bestOffset / 3600000, matchedCalls: bestHit,
            avgPerEvent: todayEvents.length ? round((Number(u.todayUsage) || 0) / todayEvents.length) : 0
          });
          return;
        }
        // ── 作息 / 精力 / 耐心：控制台面板用 ── 本机改动 2026-10-07 ──────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/rhythm') {
          const nowD = new Date();
          const table = [];
          for (let hh = 0; hh < 24; hh += 1) {
            const d = new Date(nowD); d.setHours(hh, 0, 0, 0);
            // 表格里给"未做周末后移"的原始值，前端画图用这个
            table.push(Number(rhythmHours()[hh]));
          }
          const patienceList = [];
          for (const [k, st] of socialV2.conversations ?? []) {
            try { patienceList.push({ key: k, value: Math.round(patienceNow(st)), level: patienceLevel(st), factor: patienceFactor(st), lastIncomingAt: Number(st.lastIncomingAt) || 0 }); } catch {}
          }
          const actCfg = activityCfg();
          sendJson({
            ok: true,
            enabled: cfg.socialV2?.rhythm?.enabled !== false,
            hours: table,
            now: { hour: nowD.getHours(), factor: Number(rhythmHourFactor(nowD).toFixed(3)), sleeping: rhythmIsSleeping(nowD), delayMultiplier: rhythmDelayMultiplier(), mood: rhythmMoodText(nowD) },
            weekendShift: cfg.socialV2?.rhythm?.weekendShift !== false,
            weekendShiftHours: Number(cfg.socialV2?.rhythm?.weekendShiftHours) || 1,
            sleepThreshold: Number(cfg.socialV2?.rhythm?.sleepThreshold) || 0.1,
            talkative: { value: dailyTalkative(), mood: talkativeMoodText(), date: localDayKeyStr() },
            activity: { windowMs: Number(actCfg.windowMs) || 300000, minSpeakers: Number(actCfg.minSpeakers) || 2, hotSpeakers: Number(actCfg.hotSpeakers) || 3, hotMsgs: Number(actCfg.hotMsgs) || 8, warmMsgs: Number(actCfg.warmMsgs) || 4, hotBoost: Number(actCfg.hotBoost) || 0.9, warmBoost: Number(actCfg.warmBoost) || 0.6, coolBoost: Number(actCfg.coolBoost) || 0.4, nightCap: Number(actCfg.nightCap) || 0.7, nightThreshold: Number(actCfg.nightThreshold) || 0.2, enabled: actCfg.enabled !== false },
            patience: patienceList
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/rhythm') {
          const b = await readBody();
          const out = {};
          if (Array.isArray(b.hours)) {
            const arr = b.hours.slice(0, 24).map((x) => Math.max(0, Math.min(1.5, Number(x) || 0)));
            if (arr.length !== 24) { sendJson({ ok: false, error: 'hours 必须是 24 个数' }, 400); return; }
            cfg.socialV2 = cfg.socialV2 ?? {};
            cfg.socialV2.rhythm = { ...(cfg.socialV2.rhythm ?? {}), hours: arr };
            out.hours = arr;
          }
          for (const k of ['enabled', 'weekendShift']) {
            if (b[k] !== undefined) { cfg.socialV2 = cfg.socialV2 ?? {}; cfg.socialV2.rhythm = { ...(cfg.socialV2.rhythm ?? {}), [k]: b[k] === true }; out[k] = b[k] === true; }
          }
          for (const k of ['weekendShiftHours', 'sleepThreshold']) {
            if (b[k] !== undefined) { const v = Number(b[k]); if (Number.isFinite(v)) { cfg.socialV2.rhythm = { ...(cfg.socialV2.rhythm ?? {}), [k]: v }; out[k] = v; } }
          }
          if (b.activity && typeof b.activity === 'object') {
            cfg.socialV2.activity = { ...(cfg.socialV2.activity ?? {}) };
            for (const [k, v] of Object.entries(b.activity)) {
              const num = Number(v);
              if (Number.isFinite(num)) cfg.socialV2.activity[k] = num;
            }
            out.activity = cfg.socialV2.activity;
          }
          if (b.patience && typeof b.patience === 'object' && b.patience.key) {
            const stP = getSocialV2State(String(b.patience.key));
            if (b.patience.value !== undefined) stP.patience = Math.max(0, Math.min(patienceMax(), Number(b.patience.value)));
            else stP.patience = Math.max(0, Math.min(patienceMax(), patienceNow(stP) + Number(b.patience.delta ?? 0)));
            stP.patienceAt = Date.now();
            saveSocialV2State();
            out.patience = { key: String(b.patience.key), value: Math.round(patienceNow(stP)) };
          }
          if (b.rerollTalkative === true) {
            dailyMoodCache = null;
            try { fs.rmSync(DAILY_MOOD_FILE, { force: true }); } catch {}
            out.talkative = dailyTalkative();
          }
          try { atomicWriteJson(path.join(ROOT, 'config.json'), cfg); } catch (error) { log('写 config 失败:', error?.message ?? error); }
          log('[作息] 控制台更新：' + JSON.stringify(out).slice(0, 200));
          sendJson({ ok: true, ...out });
          return;
        }
        // ── 好感度（按人）：控制台面板用 ── 本机改动 2026-10-07 ──────────────
        // 旧版是"按会话"的好感度（已废弃），这里换成"按人"，和人物档案/关系分层同一份数据。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/affinity') {
          await refreshContactCache();   // 先确保显示名缓存可用
          const stP = loadPersons();
          const list = Object.values(stP.people ?? {}).filter((p) => !p || p.testData !== true).map((p) => {
            const v = Math.round(affinityNow(p));
            const rel = relationOf(p.qq, p.name);
            // 名字是占位符（"私聊"等）时，显示成 QQ 或真实昵称 —— 否则面板上认不出是谁
            let dispName = p.name;
            if (((__s) => !__s || ['私聊','群聊','对方','未知','自检',''].includes(__s) || /^\d+$/.test(__s) || /^QQ /i.test(__s))(String(dispName ?? ''))) dispName = p.qq ? ('QQ ' + p.qq) : (dispName || '未知');
            return {
              qq: p.qq, name: displayNameForPerson(p.qq, p.name), cardName: dispName, id: p.id,
              affinity: v, affinityDetails:affinityBreakdown(p,affinityCfg(),affinityInitialFor(p.qq,p)), nicknameInfo:consoleNicknameV2(p.qq), label: affinityLabel(v), factor: Number(affinityFactorOf(p).toFixed(3)),
              tier: rel.tier, tierLabel: rel.label, tierSource: rel.source,
              msgCount: Number(p.msgCount) || 0,
              firstSeenAt: Number(p.firstSeenAt) || 0,
              lastSeenAt: Number(p.lastSeenAt) || 0,
              log: Array.isArray(p.affinityLog) ? p.affinityLog.slice(-5).reverse() : []
            };
          }).sort((a, b) => b.affinity - a.affinity);
          sendJson({ ok: true, count: list.length, list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/affinity') {
          const b = await readBody();
          // 从聊天记录补齐人物名单（本机改动 2026-10-07）：档案只记"功能上线后说过话的人"，
          // 历史群友不在里面 —— 这里扫各会话 recentMessages 补进来（并补句数，关系分档才准）。
          // 删除某个人物档案（本机改动 2026-10-07）—— 脏数据/测试号可以直接删掉
          if (b.remove === true) {
            const stP = loadPersons();
            const qq = String(b.qq ?? '').trim();
            const name = String(b.name ?? '').trim();
            const ids = [];
            for (const [id, p] of Object.entries(stP.people ?? {})) {
              if ((qq && String(p.qq) === qq) || (name && String(p.name) === name)) ids.push(id);
            }
            for (const id of ids) delete stP.people[id];
            savePersons();
            log('[好感度] 控制台删除人物：' + (name || qq) + '（' + ids.length + ' 条）');
            sendJson({ ok: true, removed: ids.length, ids });
            return;
          }
          if (b.backfill === true) {
            let added = 0; let seen = 0;
            const touched = new Map();
            for (const [key, st] of socialV2.conversations ?? []) {
              for (const m of (st.recentMessages ?? [])) {
                if (!m || m.isSelf) continue;
                const qq = m.userId ? String(m.userId) : (String(key).startsWith('private:') ? String(key).split(':')[1] : null);
                const name = m.card || m.sender || null;
                if (!qq && !name) continue;
                const id = personKey(qq, name);
                if (!id) continue;
                seen += 1;
                const cur = touched.get(id) ?? { qq, name, count: 0, first: Number(m.time) || Date.now() };
                cur.count += 1;
                if (Number(m.time) && Number(m.time) < cur.first) cur.first = Number(m.time);
                if (!cur.name && name) cur.name = name;
                touched.set(id, cur);
              }
            }
            for (const [, info] of touched) {
              const person = personOf(info.qq, info.name, true);
              if (!person) continue;
              const before = Number(person.msgCount) || 0;
              if (info.count > before) person.msgCount = info.count;
              if (!person.firstSeenAt || info.first < person.firstSeenAt) person.firstSeenAt = info.first;
              if (!person.lastSeenAt) person.lastSeenAt = Date.now();
              person.autoTier = autoTierOf(person);
              if (before === 0) added += 1;
            }
            // History discovery only restores people and counts. Repeated scans must not
            // recalculate scores or bind identities using a display name.
            savePersons();
            const total = Object.keys(loadPersons().people ?? {}).length;
            log('[好感度] 从聊天记录补齐：扫到 ' + seen + ' 条，新增 ' + added + ' 人，共 ' + total + ' 人');
            sendJson({ ok: true, backfill: true, scanned: seen, added, total, scoresRecalculated: false, identitiesMerged: false });
            return;
          }
          const qq = String(b.qq ?? '').trim();
          const name = String(b.name ?? '').trim() || null;
          if (!qq && !name) { sendJson({ ok: false, error: '需要 qq 或 name' }, 400); return; }
          const person = personOf(qq || null, name, true);
          if (!person) { sendJson({ ok: false, error: '找不到这个人' }, 400); return; }
          const cur = affinityNow(person);
          let next;
          if (b.value !== undefined && b.value !== null && b.value !== '') next = Number(b.value);
          else next = cur + Number(b.delta ?? 0);
          if (!Number.isFinite(next)) { sendJson({ ok: false, error: 'value/delta 不合法' }, 400); return; }
          next = Math.max(0, Math.min(100, next));
          const reason = String(b.reason ?? '控制台手动调整').slice(0, 60);
          const adjustment=affinityAdjust(person.qq, person.name, next - cur, reason, Date.now());
          log('[好感度] 控制台：' + (person.name || person.qq) + ' ' + Math.round(cur) + ' → ' + Math.round(next) + '（' + reason + '）');
          const v = Math.round(affinityNow(person));
          const rel = relationOf(person.qq, person.name);
          sendJson({ ok: true, qq: person.qq, name: person.name, affinity: v, affinityDetails:affinityBreakdown(person,affinityCfg(),affinityInitialFor(person.qq,person)),adjustment:{requested:next,capped:Math.abs(adjustment.value-next)>0.000001},label: affinityLabel(v), tier: rel.tier, tierLabel: rel.label });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          // 本机改动（2026-10-06）：闸门只拦 agent（防止她聊两句就跑），控制台管理写入放行
        if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st) && !!req.headers['x-agent-token']) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          // 记下 anyMessage 何时被打开/关闭（游戏唤醒保险据此判断"开太久了"）
          if (next.triggers?.anyMessage === true) {
            if (st.wakeConfig?.triggers?.anyMessage !== true || !st.wakeConfig?.anyMessageSince) next.anyMessageSince = Date.now();
            else next.anyMessageSince = st.wakeConfig.anyMessageSince;
          } else {
            delete next.anyMessageSince;
          }
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0,
              continuitySummary: {
                sharedEvents: normalizeContinuity(st.continuity).sharedEvents.length,
                openCommitments: normalizeContinuity(st.continuity).commitments.filter(x => !['completed', 'cancelled'].includes(x.status)).length
              }
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        // ── 自测端点（本机改动 2026-10-06）──────────────────────────────────
        // 目的：用**真实的**判定函数做内部测试，验证"配置的概率/静默是否真的生效"，
        // 而不是靠观察线上流量（线上会被排队、被更高优先级唤醒覆盖，统计不准）。
        // 只读：不唤醒、不改状态、不发消息。仅控制台可用。
        if (req.method === 'POST' && url.pathname === '/api/debug/group-rehearsal') {
          if (req.headers['x-agent-call'] !== undefined || req.headers['x-agent-token']) { sendJson({ ok: false }, 403); return; }
          const body = await readBody();
          if (body.action === 'start') {
            const group = String(body.groupId || '');
            if (!/^\d+$/.test(group) || !allowed('group', Number(group), cfg)) { sendJson({ ok: false, error: '测试群未获允许' }, 403); return; }
            if (currentMode !== 'reserved2' || !dshReady || socialV2.paused || groupRehearsals.size || EPHEMERAL_GROUP_KEYS.size >= 20) { sendJson({ ok: false, error: '排演未就绪或已有批次' }, 409); return; }
            let key;
            do { key = 'group:' + String(8000000000000 + crypto.randomInt(1000000000)); } while (state.sessions[key] || socialV2.conversations.has(key) || EPHEMERAL_GROUP_KEYS.has(key));
            const test = { outputs: [], requests: new Map(), expiresAt: Date.now() + 20 * 60000, styleFixtures:body.styleFixtures===true,continuous:body.styleFixtures===true&&body.continuous===true,privateScene:body.privateScene===true };
            EPHEMERAL_GROUP_KEYS.add(key); groupRehearsals.set(key, test);
            test.timer = setTimeout(() => { void finishGroupRehearsal(key); }, 20 * 60000); test.timer.unref?.();
            try { await ensureSession(key); const st=getSocialV2State(key);st.bootstrapSent = true;
              // Operator opt-in copies only public reading, never real chats.
              if(body.backgroundNotes===true){const journal=leisureOf().journal();st.experience={sources:journal.sources,records:journal.records.map(r=>({...r,visibility:'conversation'}))};const publicState=readJsonSafe(leisureFile,{},true);test.publicLeisureState={items:(publicState.items||[]).map(({cached,...i})=>i),notes:publicState.notes||[]};}
            }
            catch { await finishGroupRehearsal(key); sendJson({ ok: false, error: '创建隔离上下文失败' }, 502); return; }
            sendJson({ ok: true, key, expiresAt: test.expiresAt, capturedOnly: true }); return;
          }
          const key = String(body.key || ''), test = groupRehearsals.get(key);
          if (!test || Date.now() >= test.expiresAt) { sendJson({ ok: false, error: '排演已结束' }, 409); return; }
          if (body.action === 'finish') { await finishGroupRehearsal(key); sendJson({ ok: true }); return; }
          const st = getSocialV2State(key);
          if (body.action === 'results') { sendJson({ ok: true, outputs: test.outputs, reactions:test.reactions||[],offeredThroughSeq:Math.max(0,...st.modelSeenSeqs),busy: isConversationBusyV2(key, st), waiting:activeWaits.has(key), unread: st.unread.length, experience: normalizeExperience(st.experience), continuity: normalizeContinuity(st.continuity) }); return; }
          if (body.action === 'state') {
            if (isConversationBusyV2(key,st)) { sendJson({ok:false,error:'排演繁忙'},409); return; }
            if(body.energy!==undefined){st.patience = Math.max(0,Math.min(100,Number(body.energy)||0)); st.patienceAt=Date.now();}
            if(body.affinity!==undefined)test.affinity=Math.max(0,Math.min(100,Number(body.affinity)||0));
            sendJson({ok:true}); return;
          }
          if (body.action === 'fresh-context') {
            if (isConversationBusyV2(key,st) || test.injecting) { sendJson({ok:false,error:'排演繁忙'},409); return; }
            await resetSessionContext(key,{preserveMemory:true,archivePrevious:true});
            test.freshBoundarySeq=st.lastUnreadSeq; test.freshStartedAt=Date.now(); st.unread=[];
            await ensureSession(key); st.bootstrapSent=true; sendJson({ok:true,savedRecords:normalizeExperience(st.experience).records.length}); return;
          }
          if (body.action === 'idle') {
            const id=String(body.requestId||'');
            if(!test.styleFixtures||!/^[a-z0-9-]{1,40}$/.test(id)){sendJson({ok:false,error:'仅限聊天隔离排演'},400);return;}
            if(test.requests.has(id)){sendJson({ok:true,...test.requests.get(id),duplicate:true});return;}
            if(test.injecting||isConversationBusyV2(key,st)||st.unread.length||test.requests.size>=16||socialV2.paused||!dshReady){sendJson({ok:false,error:'排演繁忙或未收尾'},409);return;}
            test.injecting=true;
            try{const result={throughSeq:st.lastUnreadSeq,outputStart:test.outputs.length,idleOpportunity:true};test.requests.set(id,result);
              await deliverPrompt(key,'',{wakeReason:'proactiveCheck',silent:true});sendJson({ok:true,...result});return;
            }finally{test.injecting=false;}
          }
          const id = String(body.requestId || ''), messages = body.messages;
          if (body.action !== 'messages' || !/^[a-z0-9-]{1,40}$/.test(id) || !Array.isArray(messages) || !messages.length || messages.length > 5
              || messages.some(m => !['A','B','C','D'].includes(m.actor) || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 500 || m.text.startsWith('/'))) {
            sendJson({ ok: false, error: '模拟输入不合法' }, 400); return;
          }
          if (test.requests.has(id)) { sendJson({ ok: true, ...test.requests.get(id), duplicate: true }); return; }
          if (test.injecting || (!test.continuous&&isConversationBusyV2(key, st)) || test.requests.size >= 16 || socialV2.paused || !dshReady) { sendJson({ ok: false, error: '当前排演繁忙或达到上限' }, 409); return; }
          test.injecting = true;
          try {
            for (const m of messages) {
              const actorId = '77770000' + String(m.actor.charCodeAt(0));
              appendSocialV2Message(key, '模拟' + m.actor, m.text, m.text, false, false, String(-10000 - st.lastUnreadSeq), [], actorId, [],
                { directToAi: m.directToAi === true, addressedToOther: m.addressedToOther === true });
            }
            const result = { throughSeq: st.lastUnreadSeq, outputStart: test.outputs.length,reactionStart:test.reactions?.length||0 };
            test.requests.set(id, result); // Idempotence, including uncertain prompt acknowledgement.
            if(!test.continuous||!isConversationBusyV2(key,st))await deliverPrompt(key, '', { wakeReason: 'atMention', silent: true });
            sendJson({ ok: true, ...result }); return;
          } finally { test.injecting = false; }
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/private-dialogue-test') {
          const body = await readBody(), key = String(body.key ?? '').trim();
          const owner = String(cfg.ownerQQ ?? ''), runId = String(body.runId ?? '');
          if (!/^\d+$/.test(owner) || key !== `private:${owner}`) { sendJson({ ok: false, error: '仅限管理员已有私聊' }, 403); return; }
          if (!/^acceptance-[a-z0-9-]{1,64}$/.test(runId)) { sendJson({ ok: false, error: 'runId 格式不正确' }, 400); return; }
          let test = privateDialogueTests.get(key);
          if (test && Date.now() >= test.expiresAt) { finishPrivateDialogueTest(key); test = null; }
          if (body.action === 'finish') {
            if (test && test.runId !== runId) { sendJson({ ok: false, error: '验收批次不匹配' }, 409); return; }
            finishPrivateDialogueTest(key); sendJson({ ok: true, finished: true }); return;
          }
          if (currentMode !== 'reserved2' || !v2SessionAllowed(key) || socialV2.paused || !dshReady || !state.sessions[key] || pending.has(key)) {
            sendJson({ ok: false, error: '私聊未就绪，或有待处理审批/提问' }, 409); return;
          }
          const st = getSocialV2State(key);
          if (body.action === 'start') {
            if (test || isConversationBusyV2(key, st) || st.unread.length) { sendJson({ ok: false, error: '私聊当前繁忙或已有验收' }, 409); return; }
            test = { runId, owner, expiresAt: Date.now() + 20 * 60 * 1000, startSeq: st.lastUnreadSeq, lastSeq: st.lastUnreadSeq,
              originalQuiet: expressionTargets(st.expressionQuietTargets).includes(owner), responses: new Map(),
              oldMemoryIds: new Set([...normalizeContinuity(st.continuity).sharedEvents, ...normalizeContinuity(st.continuity).commitments].map(x => x.id)) };
            test.timer = setTimeout(() => finishPrivateDialogueTest(key), 20 * 60 * 1000); test.timer.unref?.();
            privateDialogueTests.set(key, test);
            sendJson({ ok: true, started: true, expiresAt: test.expiresAt }); return;
          }
          if (body.action === 'fresh-context') {
            if (!test || test.runId !== runId) { sendJson({ ok: false, error: '请先启动相同批次的验收' }, 409); return; }
            if (test.contextSwitch) { sendJson({ ok: true, ...test.contextSwitch }); return; }
            if (test.contextSwitching || test.injecting || isConversationBusyV2(key, st) || st.unread.length || test.expiresAt - Date.now() < 60000) {
              sendJson({ ok: false, error: '当前繁忙、有未读或验收即将到期，不能切换上下文' }, 409); return;
            }
            if (st.recentMessages.some(m => !m.isSelf && m.seq > test.lastSeq && !String(m.messageId || '').startsWith(`${runId}:`))) {
              sendJson({ ok: false, error: '检测到真实私聊来信，请停止自动验收' }, 409); return;
            }
            const original = { sessionId: state.sessions[key], policy: state.sessionPolicies[key], token: st.agentToken,
              bootstrapSent: st.bootstrapSent, msgSinceReset: st.msgSinceReset, modelSeenSeqs: new Set(st.modelSeenSeqs || []) };
            test.contextSwitching = true;
            test.freshBoundarySeq = st.lastUnreadSeq; test.freshStartedAt = Date.now();
            try {
              await resetSessionContext(key, { preserveMemory: true, archivePrevious: false });
              const newSessionId = await ensureSession(key);
              test.contextSwitch = { previousSessionId: original.sessionId, newSessionId,
                previousSessionRetained: true, savedMemoryPreserved: true, oldChatReplaySuppressed: true, boundarySeq: test.freshBoundarySeq };
              sendJson({ ok: true, ...test.contextSwitch }); return;
            } catch (error) {
              if (state.sessions[key] && state.sessions[key] !== original.sessionId) {
                await resetSessionContext(key, { preserveMemory: true });
              }
              state.sessions[key] = original.sessionId; state.sessionPolicies[key] = original.policy;
              reverse.set(original.sessionId, key); st.agentToken = original.token; rememberAgentToken(key, original.token);
              st.bootstrapSent = original.bootstrapSent; st.msgSinceReset = original.msgSinceReset; st.modelSeenSeqs = original.modelSeenSeqs;
              delete test.freshBoundarySeq; delete test.freshStartedAt; saveState(); saveSocialV2State();
              sendJson({ ok: false, error: '创建新上下文失败，已恢复原会话映射和保存的记忆' }, 502); return;
            } finally { test.contextSwitching = false; }
          }
          if (body.action !== 'message' || !test || test.runId !== runId) { sendJson({ ok: false, error: '请先启动相同批次的验收' }, 409); return; }
          const requestId = String(body.requestId ?? ''), content = String(body.text ?? '').trim();
          if (!/^[a-z0-9-]{1,40}$/.test(requestId) || !content || content.length > 500 || content.startsWith('/')) { sendJson({ ok: false, error: '测试消息或 requestId 不合法' }, 400); return; }
          if (test.responses.has(requestId)) { sendJson(test.responses.get(requestId)); return; }
          if (test.injecting) { sendJson({ ok: false, error: '上一条测试输入尚未登记完成' }, 409); return; }
          if (test.responses.size >= 12) { sendJson({ ok: false, error: '本批次最多 12 条测试输入' }, 409); return; }
          if (st.recentMessages.some(m => !m.isSelf && m.seq > test.lastSeq && !String(m.messageId || '').startsWith(`${runId}:`))) {
            sendJson({ ok: false, error: '检测到真实私聊来信，请停止自动验收' }, 409); return;
          }
          const before = st.lastUnreadSeq, messageId = `${runId}:${requestId}`;
          const existingName = personOf(owner, null, false)?.name || owner;
          test.injecting = true;
          try {
          await handleIncoming('private', owner, { post_type: 'message', message_type: 'private',
            user_id: owner, self_id: await getSelfId(), time: Math.floor(Date.now() / 1000), message_id: messageId,
            sender: { user_id: owner, nickname: existingName }, message: [{ type: 'text', data: { text: content } }] }, cfg);
          const input = st.recentMessages.find(m => m.messageId === messageId && !m.isSelf);
          if (!input || input.seq !== before + 1) { sendJson({ ok: false, error: '消息未进入正常收信路径' }, 409); return; }
          test.lastSeq = input.seq;
          const response = { ok: true, seq: input.seq, receivedAt: input.time, normalPrivatePath: true };
          test.responses.set(requestId, response); sendJson(response); return;
          } finally { test.injecting = false; }
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/selftest') {
          const body = await readBody();
          const key = String(body.key ?? (testScope()[0] || 'group:0')).trim();
          const n = Math.max(1, Math.min(20000, Number(body.n ?? 3000)));
          const customText = typeof body.text === 'string' && body.text ? body.text : null;
          // 注入测试消息（仅控制台）：把一条合成消息塞进某会话的未读，并按需唤醒。
          // 用途是内部端到端行为测试（例如"改完人格后她说话是不是正常了"），不依赖真实用户发言。
          if (body.injectMessage !== undefined && body.key) {
            const k = String(body.key).trim();
            if (!/^(group|private):\d+$/.test(k)) { sendJson({ ok: false, error: 'key 格式不对' }, 400); return; }
            const stX = getSocialV2State(k);
            const text = String(body.injectMessage ?? '').slice(0, 500);
            const kind = k.startsWith('group:') ? 'group' : 'private';
            const id = k.split(':')[1];
            const msg = {
              time: Date.now(), userId: body.fromUserId ?? (kind === 'private' ? Number(id) : 999999),
              sender: body.fromName ?? '自检', card: body.fromName ?? '自检',
              text, plain: text, isSelf: false, testInjected: true
            };
            appendSocialV2Message(k, msg.sender, text, text, false, false, 'test-' + ((Number(stX.lastUnreadSeq) || 0) + 1), [], msg.userId, []);
            const seq = stX.lastUnreadSeq;
            // 本机改动（2026-10-07）：注入的消息也要走"累计关系"这一步，
            // 否则自检路径和真实消息路径行为不一致（测不出关系自动升级）。
            try {
              personTouch(msg.userId, msg.sender, Date.now());
              // 本机改动（2026-10-07 用户要求）：自检注入造出来的人打上标记，
              // 从此不进控制台面板（否则面板里会冒出一堆"自测号"）。
              const pTest = personOf(msg.userId, msg.sender, true);
              // 只给【保留测试号段 7777xxxxx】打标记 —— 之前对谁都打，
              // 结果我冒用真人 QQ 做自测时把真人档案也标记成了测试数据（差点误删）。
              if (pTest && /^7777\d{5}$/.test(String(msg.userId ?? ''))) { pTest.testData = true; savePersons(); }
            } catch {}
            // 本机改动（2026-10-07）：注入消息也要走好感度分类，否则自检与真实路径不一致
            try { affinityTouchByMessage(msg.userId, msg.sender, text, true); } catch {}
            // 本机改动：注入也要走耐心判定，保证自检与真实路径一致
            try { const stP = getSocialV2State(k); patienceOnIncoming(stP, Date.now()); saveSocialV2State(); } catch {}
            saveSocialV2State();
            log(`[自检] 注入测试消息 ${k}：“${text.slice(0, 40)}”`);
            if (body.wake !== false) scheduleWakeV2(k, kind === 'private' ? 'private' : 'question');
            sendJson({ ok: true, key: k, seq, text, woke: body.wake !== false });
            return;
          }
          // 测试用：把 lastIncomingAt 往前推 N 分钟（制造"已冷场"）
          if (body.ageLastIncoming) {
            const k = String(body.ageLastIncoming.key ?? '').trim();
            const mins = Math.max(0, Number(body.ageLastIncoming.minutes ?? 30));
            const stX = getSocialV2State(k);
            stX.lastIncomingAt = Date.now() - mins * 60 * 1000;
            saveSocialV2State();
            sendJson({ ok: true, mode: 'ageLastIncoming', key: k, ageMinutes: mins });
            return;
          }
          // 测试用：设置/清零主动开口每日计数
          if (body.setProactiveDay) {
            const k = String(body.setProactiveDay.key ?? '').trim();
            const stX = getSocialV2State(k);
            if (body.setProactiveDay.count === null) delete stX.proactiveDay;
            else stX.proactiveDay = { key: localDayKey(), count: Math.max(0, Number(body.setProactiveDay.count) || 0) };
            saveSocialV2State();
            sendJson({ ok: true, mode: 'setProactiveDay', proactiveDay: stX.proactiveDay ?? null });
            return;
          }
          // ── 她的梗 ────────────────────────────────────────────────
// ── 称呼判定自测（本机改动 2026-10-07）────────────────────────────────
        if (body.addrScore !== undefined && req.method === 'POST') {
          const b2 = body.addrScore ?? {};
          const key2 = String(b2.key ?? '').trim();
          if(!/^(group|private):\d+$/.test(key2)){sendJson({ok:false,error:'自检需要明确指定会话'},400);return;}
          const stP = getSocialV2State(key2);
          if (b2.inject) {
          stP.recentMessages = stP.recentMessages ?? [];
          stP.recentMessages.push({ isSelf: b2.inject.isSelf === true, text: String(b2.inject.text ?? ''), time: Date.now() - Number(b2.inject.agoMs ?? 0), userId: b2.inject.userId ?? '0', seq: -1 });
          }
          const ev = { user_id: b2.fromUserId ?? '0', sender: { card: b2.fromName ?? '测试成员' }, raw_message: String(b2.text ?? '') };
          const r2 = addresseeScore(stP, key2, ev);
          sendJson({ ok: true, mode: 'addrScore', score: r2.score, reasons: r2.reasons, text: String(b2.text ?? '') });
          return;
        }
                  if (body.memes !== undefined) {
            const cmd = String(body.memes);
            if (cmd === 'scan') { const a = memeScanRecent(); sendJson({ ok: true, mode: 'memes', added: a, state: loadMemes() }); return; }
            if (cmd === 'add') {
              const m = loadMemes();
              const t = String(body.text || '').trim();
              if (t) { m.global.push({ text: t, usage: Number(body.usage) || 1, source: '手动', firstAt: Date.now(), lastAt: Date.now() }); saveMemes(); }
              sendJson({ ok: true, mode: 'memes', state: m }); return;
            }
            if (cmd === 'nickname') { sendJson({ ok: true, mode: 'memes', nickname: memeNicknameFor(body.qq, body.name, { force: true }) }); return; }
            if (cmd === 'candidates') { const p2 = personOf(body.qq, body.name, false); sendJson({ ok: true, mode: 'memes', candidates: nicknameCandidatesV2(body.name, p2, body.qq), words: topWordsOf(body.qq, 5) }); return; }
            if (cmd === 'setNickname') {
              // 本机改动（2026-10-07 用户要求）：手动改她给某人起的外号
              const q = String(body.qq ?? '').trim();
              const t = String(body.text ?? '').trim().slice(0, 20);
              const m = loadMemes();
              if (!q) { sendJson({ ok: false, error: '需要 qq' }, 400); return; }
              if (!Array.isArray(m.byTarget[q])) m.byTarget[q] = [];
              const old = m.byTarget[q].find((x) => x.kind === 'nickname');
              if(!t)m.byTarget[q]=m.byTarget[q].filter(x=>x.kind!=='nickname');
              else if (old) { old.text = t; old.manual = true; old.updatedAt = Date.now(); }
              else m.byTarget[q].push({ text: t, kind: 'nickname', usage: 0, since: Date.now(), mood: '手动', manual: true });
              saveMemes();
              log('[梗] 手动改外号 ' + q + ' → ' + t);
              sendJson({ ok: true, mode: 'memes', qq: q, nickname: t,nicknameInfo:consoleNicknameV2(q),message:consoleNicknameV2(q).peer?'备用外号已保存，本人的称呼约定仍优先':'备用外号已'+(t?'保存':'清除') });
              return;
            }
            if (cmd === 'remove') {
              const m = loadMemes();
              m.global = m.global.filter((x) => x.text !== String(body.text || ''));
              if (body.qq) m.byTarget[String(body.qq)]=(m.byTarget[String(body.qq)]||[]).filter(x=>x.kind!=='nickname');
              saveMemes(); sendJson({ ok: true, mode: 'memes', state: m }); return;
            }
            if (cmd === 'reset') { memesState = { global: [], byTarget: {} }; saveMemes(); sendJson({ ok: true, mode: 'memes', state: memesState }); return; }
            await refreshContactCache();
            const mState = loadMemes();
            const nickNames = {};
            const targets=[...new Set([...Object.keys(mState.byTarget??{}),...normalizePersonContinuity(socialV2.personContinuity).contracts.filter(r=>r.kind==='peerAlias'||r.kind==='selfAlias').map(r=>r.target)])];
            for (const q of targets) nickNames[q] = displayNameForPerson(q, null);
            sendJson({ ok: true, mode: 'memes', state: mState, names: nickNames,nicknames:targets.map(q=>consoleNicknameV2(q)),mood: memesMoodText() });
            return;
          }
          // ── 今日状态 ──────────────────────────────────────────────
          if (body.dailyState !== undefined) {
            const cmd = String(body.dailyState);
            if (cmd === 'reroll') { dailyStateCache = null; try { fs.rmSync(DAILY_STATE_FILE, { force: true }); } catch {} }
            const s = dailyState();
            const m = dailyStateMeta();
            sendJson({ ok: true, mode: 'dailyState', state: s, meta: m, wakeFactor: dailyStateWakeFactor(), mood: dailyStateMoodText(), all: DAILY_STATES.map((x) => ({ id: x.id, label: x.label, weight: x.weight })) });
            return;
          }
          // ── 追番（调试/控制台用）────────────────────────────────────
          if (body.anime !== undefined) {
            const cmd = String(body.anime);
            if (cmd === 'status') {
              const a = loadAnime();
              sendJson({ ok: true, mode: 'anime', watching: a.watching, queue: a.queue.slice(0, 20), queueCount: a.queue.length, finished: a.finished.slice(-5), today: animeSummaryV2(a).advancedToday, day: a.day, catalogCount: animeCatalog().length, mood: animeMoodText(), automation:animeAutomationStatusV2() });
              return;
            }
            if (cmd === 'advance') { sendJson({ ok: true, mode: 'anime', result: animeAdvance('自检') }); return; }
            if (cmd === 'recommend') { sendJson({ ok: true, mode: 'anime', result: animeRecommend(body.title, body.qq, body.name, body.total) }); return; }
            if (cmd === 'reset') {
              animeState = { watching: [], queue: [], finished: [], day: '', advancedToday: 0 };
              saveAnime();
              sendJson({ ok: true, mode: 'anime', result: 'reset' });
              return;
            }
          }
          // 看当前作息系数 + 24 小时表 + 某会话的耐心
          if (body.rhythm !== undefined) {
            const nowD = new Date();
            const table = [];
            for (let hh = 0; hh < 24; hh += 1) {
              const d = new Date(nowD); d.setHours(hh, 0, 0, 0);
              table.push({ hour: hh, factor: Number(rhythmHourFactor(d).toFixed(2)) });
            }
            const tlk = dailyTalkative();
            const out = {
              talkative: { date: localDayKeyStr(), value: tlk, mood: talkativeMoodText() },
              enabled: cfg.socialV2?.rhythm?.enabled !== false,
              now: { hour: nowD.getHours(), factor: Number(rhythmHourFactor(nowD).toFixed(2)), sleeping: rhythmIsSleeping(nowD), delayMultiplier: rhythmDelayMultiplier(), mood: rhythmMoodText(nowD) },
              weekendShift: cfg.socialV2?.rhythm?.weekendShift !== false,
              table
            };
            if (typeof body.rhythm === 'string' && body.rhythm.includes(':')) {
              const stA = getSocialV2State(body.rhythm);
              const peerA = peerOfConversation(body.rhythm, stA);
              const perA = peerA.qq ? personOf(peerA.qq, peerA.name, false) : null;
              out.relation = { ...relationOf(peerA.qq, peerA.name), who: peerA.name || peerA.qq || null, proactiveFactor: relationProactiveFactor(peerA.qq, peerA.name) };
              out.affinity = perA ? { value: Math.round(affinityNow(perA)), label: affinityLabel(affinityNow(perA)), factor: Number(affinityFactorOf(perA).toFixed(3)), mood: affinityMoodText(peerA.qq, peerA.name) } : null;
              out.activity = { ...activityStats(stA), boost: activityBoost(stA), finalFactor: Number(activityFactorFor(stA, { key: body.rhythm }).toFixed(3)), mood: activityMoodText(stA, { key: body.rhythm }) };
              const stR = getSocialV2State(body.rhythm);
              out.patience = { value: Math.round(patienceNow(stR)), level: patienceLevel(stR), factor: patienceFactor(stR), mood: patienceMoodText(stR) };
            }
            sendJson({ ok: true, mode: 'rhythm', result: out });
            return;
          }
          // 直接返回"她真实收到的唤醒提示词"（用于精确验证注入内容）
          if (body.buildPrompt) {
            const k = String(body.buildPrompt).trim();
            const text = buildWakePromptV2(k, body.reason || 'timeout');
            sendJson({ ok: true, mode: 'buildPrompt', key: k, length: text.length, prompt: text });
            return;
          }
          // 跑一次主动机会判定（dryRun 默认 true）
          if (body.proactiveCheck !== undefined) {
            const out = proactiveCheckTick(String(body.proactiveCheck).trim(), { dryRun: body.dryRun !== false });
            sendJson({ ok: true, mode: 'proactiveCheck', result: out });
            return;
          }
          // 忙标志诊断：看清一个会话"到底被什么判成繁忙"
          if (body.busyFlags !== undefined) {
            const k = String(body.busyFlags).trim();
            const stX = getSocialV2State(k);
            const sid = state.sessions[k];
            const q = promptQueues.get(k);
            sendJson({
              ok: true, mode: 'busyFlags', key: k,
              flags: busyFlagReport(k, stX),
              busy: isConversationBusyV2(k, stX),
              turnStartAgoMs: sid && v2TurnStartAt.has(sid) ? Date.now() - Number(v2TurnStartAt.get(sid) || 0) : null,
              hasCollector: sid ? collectors.has(sid) : false,
              queueRunning: q?.running ?? null,
              queueLen: Array.isArray(q?.queue) ? q.queue.length : null,
              pendingWakeTimer: !!stX?.pendingWakeTimer,
              pendingWakeReasons: (stX?.pendingWakeReasons ?? []).length,
              lastAiReplyAt: stX?.lastAiReplyAt ?? null,
              lastIncomingAt: stX?.lastIncomingAt ?? null
            });
            return;
          }
          // 手动跑一次游戏唤醒保险
          if (body.runGameGuard) {
            const out = await gameWakeGuardTick(body.force !== false);
            sendJson({ ok: true, mode: 'runGameGuard', triggered: out });
            return;
          }
          // 成员校验试跑：给一个 QQ 号，看它会不会被自动放行（默认 dryRun 不写入）
          if (body.checkPrivateMember !== undefined) {
            const r = await autoAddPrivateFromGroups(String(body.checkPrivateMember), { dryRun: body.dryRun !== false });
            sendJson({ ok: true, mode: 'checkPrivateMember', result: r, allowPrivate: (cfg.allow?.private ?? []).map(String) });
            return;
          }
          // 段解析模式：直接喂合成消息段，验证 segmentsToText（含分享卡片）的接线
          if (Array.isArray(body.segments)) {
            const text = await segmentsToText(body.segments, { includeReply: false });
            sendJson({ ok: true, mode: 'segments', text, length: text.length });
            return;
          }
          const st = getSocialV2State(key);
          const selfId = String((await getSelfId().catch(() => '')) ?? '');
          const mkPlain = (text) => ({ self_id: selfId, user_id: 999999, message: [{ type: 'text', data: { text } }], sender: { nickname: '自测', card: '' } });
          const mkAt = (text) => ({ self_id: selfId, user_id: 999999, message: [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text } }], sender: { nickname: '自测', card: '' } });

          // ① 普通消息：统计唤醒原因分布（含概率抽签）
          const plain = {};
          for (let i = 0; i < n; i++) {
            const r = evaluateWakeTriggerV2(key, st, mkPlain('今天天气不错啊'), 'group', '今天天气不错啊', '今天天气不错啊', false);
            plain[r ?? '(不唤醒)'] = (plain[r ?? '(不唤醒)'] ?? 0) + 1;
          }
          // ② @ 她：应 100% 命中
          let atHit = 0;
          for (let i = 0; i < 200; i++) {
            const r = evaluateWakeTriggerV2(key, st, mkAt('喂'), 'group', '喂', '喂', false);
            if (r === 'atMention') atHit += 1;
          }
          // ③ 静默时间：三种情形各算一次（真实函数）
          const quietOf = (recent) => {
            const fake = { ...st, recentMessages: recent, lastIncomingAt: Date.now() };
            return replyTimingV2(fake).quietMs;
          };
          const quiet = {
            正常: quietOf([{ isSelf: false, tail: customText ?? '在吗', plain: customText ?? '在吗', time: Date.now() }]),
            像没说完: quietOf([{ isSelf: false, tail: '我觉得这个', plain: '我觉得这个', time: Date.now() }]),
            短时间连发3条: quietOf([1, 2, 3].map(() => ({ isSelf: false, tail: '嗯', plain: '嗯', time: Date.now() })))
          };
          sendJson({
            ok: true, key, n,
            wakeConfigProbability: st.wakeConfig?.triggers?.probability,
            plainWakeReasons: plain,
            概率命中率: plain['probability'] ? (plain['probability'] / n) : 0,
            atMention命中: atHit + '/200',
            quietMs: quiet,
            配置: { defaultQuietMs: cfg.socialV2?.wait?.defaultQuietMs, unfinishedQuietMs: cfg.socialV2?.wait?.unfinishedQuietMs, minQuietAfterNewMs: cfg.socialV2?.wait?.minQuietAfterNewMs }
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/recover') {
          const body = await readBody(), key = canonicalV2Key(body.key);
          if (!key || !historyRecoveryAllowedV2(key)) { sendJson({ok:false,error:'仅能补收已有且获授权的二代会话'},403); return; }
          try { sendJson({ok:true,...await recoverConversationV2(key,{dryRun:body.dryRun!==false})}); }
          catch { sendJson({ok:false,error:'补收失败，原消息和读水位保留；查看补收诊断'},502); }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          let faceIds;
          try {faceIds=normalizeFaceIds(body.faceIds,faceCatalogV2());}catch(error){sendJson({ok:false,error:error.message},400);return;}
          if(faceIds.length&&isRawString&&!rawMessages.trim())messages.push('');
          if(faceIds.length&&messages.length!==1){sendJson({ok:false,error:'带 faceIds 时只能发一个气泡；messages="" 可只发表情'},400);return;}
          if(faceIds.length&&privateDialogueTests.has(key)){sendJson({ok:false,error:'当前文字对话验收不发送原生表情'},403);return;}
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId, faceIds);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 好感度面板接口（控制台用；本机改动 2026-10-07）────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/affinity') {
          await refreshContactCache();   // 先确保显示名缓存可用
          const stP = loadPersons();
          const list = Object.values(stP.people ?? {}).filter((p) => !p || p.testData !== true).map((p) => {
            const v = Math.round(affinityNow(p));
            const rel = relationOf(p.qq, p.name);
            // 名字是占位符（"私聊"等）时，显示成 QQ 或真实昵称 —— 否则面板上认不出是谁
            let dispName = p.name;
            if (((__s) => !__s || ['私聊','群聊','对方','未知','自检',''].includes(__s) || /^\d+$/.test(__s) || /^QQ /i.test(__s))(String(dispName ?? ''))) dispName = p.qq ? ('QQ ' + p.qq) : (dispName || '未知');
            return {
              qq: p.qq, name: displayNameForPerson(p.qq, p.name), cardName: dispName, id: p.id,
              affinity: v, label: affinityLabel(v), factor: Number(affinityFactorOf(p).toFixed(3)),
              tier: rel.tier, tierLabel: rel.label, tierSource: rel.source,
              msgCount: Number(p.msgCount) || 0,
              firstSeenAt: Number(p.firstSeenAt) || 0,
              lastSeenAt: Number(p.lastSeenAt) || 0,
              facts: Array.isArray(p.facts) ? p.facts.slice(-3) : [],
              log: Array.isArray(p.affinityLog) ? p.affinityLog.slice(-5).reverse() : []
            };
          }).sort((a, b) => b.affinity - a.affinity);
          sendJson({ ok: true, count: list.length, list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/affinity') {
          const b = await readBody();
          // 从聊天记录补齐人物名单（本机改动 2026-10-07）：档案只记"功能上线后说过话的人"，
          // 历史群友不在里面 —— 这里扫各会话 recentMessages 补进来（并补句数，关系分档才准）。
          // 删除某个人物档案（本机改动 2026-10-07）—— 脏数据/测试号可以直接删掉
          if (b.remove === true) {
            const stP = loadPersons();
            const qq = String(b.qq ?? '').trim();
            const name = String(b.name ?? '').trim();
            const ids = [];
            for (const [id, p] of Object.entries(stP.people ?? {})) {
              if ((qq && String(p.qq) === qq) || (name && String(p.name) === name)) ids.push(id);
            }
            for (const id of ids) delete stP.people[id];
            savePersons();
            log('[好感度] 控制台删除人物：' + (name || qq) + '（' + ids.length + ' 条）');
            sendJson({ ok: true, removed: ids.length, ids });
            return;
          }
          if (b.backfill === true) {
            let added = 0; let seen = 0;
            const touched = new Map();
            for (const [key, st] of socialV2.conversations ?? []) {
              for (const m of (st.recentMessages ?? [])) {
                if (!m || m.isSelf) continue;
                const qq = m.userId ? String(m.userId) : (String(key).startsWith('private:') ? String(key).split(':')[1] : null);
                const name = m.card || m.sender || null;
                if (!qq && !name) continue;
                const id = personKey(qq, name);
                if (!id) continue;
                seen += 1;
                const cur = touched.get(id) ?? { qq, name, count: 0, first: Number(m.time) || Date.now() };
                cur.count += 1;
                if (Number(m.time) && Number(m.time) < cur.first) cur.first = Number(m.time);
                if (!cur.name && name) cur.name = name;
                touched.set(id, cur);
              }
            }
            for (const [, info] of touched) {
              const person = personOf(info.qq, info.name, true);
              if (!person) continue;
              const before = Number(person.msgCount) || 0;
              if (info.count > before) person.msgCount = info.count;
              if (!person.firstSeenAt || info.first < person.firstSeenAt) person.firstSeenAt = info.first;
              if (!person.lastSeenAt) person.lastSeenAt = Date.now();
              person.autoTier = autoTierOf(person);
              if (before === 0) added += 1;
            }
            // 本机改动（2026-10-07）：顺手**根据历史聊天内容**算好感度 ——
            // 只看明确的好话/难听话（普通闲聊不累加，否则几百条记录会把人直接顶满），
            // 且整体限制在 ±cap 以内（历史只作为"底子"，后续实时互动再慢慢加）。
            const cap = Number(affinityCfg().backfillCap) || 25;
            const P = affinityCfg().patterns ?? {};
            const good = P.good ?? ['谢谢', '感谢', '厉害', '牛逼', '牛啊', '说得对', '哈哈', '笑死', '有意思', '可爱', '喜欢', '好玩', '赞', '专业', '靠谱', '辛苦了'];
            const bad = P.bad ?? ['傻逼', '弱智', '智障', '废物', '滚', '闭嘴', '有病', '恶心', '垃圾', '烦人', '别说了', '无聊', '菜', '蠢'];
            let affAdjusted = 0;
            for (const [key, st] of socialV2.conversations ?? []) {
              for (const m of (st.recentMessages ?? [])) {
                if (!m || m.isSelf) continue;
                const qq = m.userId ? String(m.userId) : (String(key).startsWith('private:') ? String(key).split(':')[1] : null);
                const name = m.card || m.sender || null;
                const person = personOf(qq, name, false);
                if (!person) continue;
                const text = String(m.text || m.plain || '');
                if (!text) continue;
                let d = 0;
                for (const w of good) if (text.includes(w)) { d += Number(affinityCfg().goodDelta) || 1.5; break; }
                for (const w of bad) if (text.includes(w)) { d -= Number(affinityCfg().badDelta) || 3; break; }
                if (!d) continue;
                const cur = Number(person.affinity);
                const base = Number.isFinite(cur) ? cur : affinityInitialFor(person.qq, person);
                const acc = Number(person.backfillAffinityDelta) || 0;
                const nextAcc = Math.max(-cap, Math.min(cap, acc + d));
                if (nextAcc === acc) continue;
                person.backfillAffinityDelta = nextAcc;
                person.affinity = Math.max(0, Math.min(100, base + (nextAcc - acc)));
                person.affinityAt = Date.now();
                if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
                if (person.affinityLog.length < 12) person.affinityLog.push({ at: Date.now(), delta: nextAcc - acc, to: person.affinity, reason: '历史记录回算：' + (d > 0 ? '好话' : '难听话') });
                affAdjusted += 1;
              }
            }
            savePersons();
            log('[好感度] 历史回算：调整 ' + affAdjusted + ' 次（上限 ±' + cap + '）');
            const total = Object.keys(loadPersons().people ?? {}).length;
            log('[好感度] 从聊天记录补齐：扫到 ' + seen + ' 条，新增 ' + added + ' 人，共 ' + total + ' 人');
            sendJson({ ok: true, backfill: true, scanned: seen, added, total });
            return;
          }
          const qq = String(b.qq ?? '').trim();
          const name = String(b.name ?? '').trim() || null;
          if (!qq && !name) { sendJson({ ok: false, error: '需要 qq 或 name' }, 400); return; }
          const person = personOf(qq || null, name, true);
          if (!person) { sendJson({ ok: false, error: '找不到这个人' }, 400); return; }
          const cur = affinityNow(person);
          let next;
          if (b.value !== undefined && b.value !== null && b.value !== '') next = Number(b.value);
          else next = cur + Number(b.delta ?? 0);
          if (!Number.isFinite(next)) { sendJson({ ok: false, error: 'value/delta 不合法' }, 400); return; }
          next = Math.max(0, Math.min(100, next));
          const reason = String(b.reason ?? '控制台手动调整').slice(0, 60);
          affinityAdjust(person.qq, person.name, next - cur, reason, Date.now());
          log('[好感度] 控制台：' + (person.name || person.qq) + ' ' + Math.round(cur) + ' → ' + Math.round(next) + '（' + reason + '）');
          const v = Math.round(affinityNow(person));
          const rel = relationOf(person.qq, person.name);
          sendJson({ ok: true, qq: person.qq, name: person.name, affinity: v, label: affinityLabel(v), tier: rel.tier, tierLabel: rel.label });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if(groupRehearsals.get(key)?.styleFixtures) {
            const labels={'fixture-laugh':'笑到拍桌','fixture-stare':'无语凝视','fixture-wave':'收尾挥手'};
            if(!labels[stickerId]){sendJson({ok:false,error:'请查询并使用模拟表情ID'},400);return;}
            captureSendGuard(key)();
            groupRehearsals.get(key).outputs.push({type:'sticker',stickerId,text:'[模拟表情：'+labels[stickerId]+']',time:Date.now()});
            recordSentMessagesV2(key,['[表情：'+labels[stickerId]+']']);getSocialV2State(key).lastAiReplyAt=Date.now();
            sendJson({ok:true,sent:1,failed:0,capturedOnly:true,simulation:true});return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            if(groupRehearsals.get(key)?.styleFixtures){sendJson({ok:true,simulation:true,stickers:[{id:'fixture-laugh',desc:'笑到拍桌',tags:['笑','离谱','接梗']},{id:'fixture-stare',desc:'无语凝视',tags:['无语']},{id:'fixture-wave',desc:'收尾挥手',tags:['晚安','告别']}],total:3});return;}
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          if(groupRehearsals.get(key)?.styleFixtures){sendJson({ok:true,simulation:true,stickers:[{id:'fixture-laugh',desc:'笑到拍桌',tags:['笑','离谱','接梗']},{id:'fixture-stare',desc:'无语凝视',tags:['无语']},{id:'fixture-wave',desc:'收尾挥手',tags:['晚安','告别']}],total:3});return;}
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          if (activeWaits.has(key) && Date.now() - activeWaits.get(key) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.set(key, Date.now());
          const finishWait = () => activeWaits.delete(key);
          req.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const offeredAtStart=new Set(st.modelSeenSeqs||[]);
          const waitPending=()=>{
            const visible=[...(v2ToolEnabled('getUnread')?st.unread:[]),...(v2ToolEnabled('getRecent')?privateTestRecent(key,st):[])];
            return [...new Map(visible.filter(m=>m&&!m.isSelf&&!m.historyOnly&&Number.isSafeInteger(m.seq)
              &&(replyWait?m.seq>baseline:m.seq>requestSeq||(m.seq>(st.lastReadThroughSeq||0)&&!offeredAtStart.has(m.seq)))).map(m=>[m.seq,m])).values()].sort((a,b)=>a.seq-b.seq);
          };
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          // Cancellation must be observed during a long poll, rather than only
          // after its full timeout. Pausing keeps unread messages and permissions.
          const waitStillAllowed=()=>!socialV2.paused&&socialV2.conversations.get(canonicalV2Key(key))===st&&
            (!req.headers['x-agent-token']||(currentMode==='reserved2'&&cfg.socialV2?.enabled!==false&&agentTokenOk(key,req.headers['x-agent-token'])&&v2SessionAllowed(key)&&v2ToolEnabled('waitMessages')));
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && waitStillAllowed() && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted && waitStillAllowed()) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (waitPending().length >= minNew) {
              arrived = true;
              lastNewAt = Math.min(Date.now(),Number(st.lastIncomingAt)||Date.now());
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted && waitStillAllowed()) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          if(socialV2.paused){finishWait();sendJson({ok:true,key,paused:true,arrived:false,timeout:false,waitedMs,newMessages:[],readThroughSeq:readThroughSeqV2(st),unreadCount:st.unread.length});return;}
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const pending = waitPending();
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          arrived=newMessages.length>0;
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length,
            conversation:currentConversationV2(key,st,newMessages)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = (req.headers['x-agent-token'] ? privateTestRecent(key, st) : st.recentMessages).filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/lookup') {
          const key=canonicalV2Key(url.searchParams.get('key')),token=req.headers['x-agent-token'];
          if(!key||!token||!agentTokenOk(key,token)||!v2SessionAllowed(key)||!v2ToolEnabled('socialLookup')){sendJson({ok:false,error:'会话查询未授权或已关闭'},403);return;}
          const st=getSocialV2State(key),sid=state.sessions[key],connection=bot.url;
          const allowed=()=>agentTokenOk(key,token)&&v2SessionAllowed(key)&&v2ToolEnabled('socialLookup')&&socialV2.conversations.get(key)===st&&state.sessions[key]===sid&&bot.url===connection;
          const action=url.searchParams.get('action')||'sharedInterests',query=url.searchParams.get('query')||'',limit=url.searchParams.get('limit');
          try {
            if(action==='sharedInterests'){
              const journals=EPHEMERAL_GROUP_KEYS.has(key)?[st.experience]:[leisureJournalFor(key),...[...socialV2.conversations].filter(([k])=>!EPHEMERAL_GROUP_KEYS.has(k)).map(([,s])=>s.experience)];
              sendJson({ok:true,...sharedConversationRecall(journals,{query,limit})});return;
            }
            if(EPHEMERAL_GROUP_KEYS.has(key))throw Error('隔离排演不查询真实通讯录');
            const selfIds=[...new Set([...socialV2.conversations.values()].map(s=>s.historyRecovery?.selfId).filter(Boolean))];
            if(selfIds.length!==1)throw Error('尚未确认单一QQ账号');
            const signal=AbortSignal.timeout(8000);
            const data=await readConversationContacts({key,kind:action,query,limit,owner:key==='private:'+String(cfg.ownerQQ),expectedSelf:selfIds[0],allowed,
              call:(name,args)=>bot.request(name,args,{signal,timeoutMs:2500})});
            if(!allowed())throw Error('会话授权已经变化');sendJson({ok:true,...data});
          } catch {sendJson({ok:false,error:'查询不可用：请确认当前会话范围、工具设置和QQ账号状态'},403);}
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (url.pathname === '/api/socialV2/experience' && ['GET','POST'].includes(req.method)) {
          const data=req.method==='GET'?Object.fromEntries(url.searchParams):await readBody(), key=String(data.key||'');
          if (!key || !agentTokenOk(key,req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('memory')) {sendJson({ok:false,error:'经历工具不可用或会话未授权'},403);return;}
          const st=getSocialV2State(key);
          if(req.method==='GET'){
            const own=normalizeExperience(st.experience), background=leisureJournalFor(key), journal=normalizeExperience({sources:[...own.sources,...background.sources],records:[...background.records,...own.records]}), count=Math.min(12,Math.max(1,Number(data.limit)||6));
            const records=journal.records.filter(r=>!data.q || (r.topic+r.position+r.reason).includes(String(data.q))).slice(-count);
            sendJson({ok:true,records,sources:journal.sources.map(({id,title,url,parts})=>({id,title,url,coverage:parts.map(p=>({kind:p.kind,coverage:p.coverage}))})),totalRecords:journal.records.length});return;
          }
          try {
            const previous=st.experience, background=leisureJournalFor(key), local=normalizeExperience({...previous,sources:[...normalizeExperience(previous).sources,...background.sources.filter(s=>Array.isArray(data.sourceIds)&&data.sourceIds.includes(s.id))]});
            // Public own opinions may be revised from another conversation only
            // with new evidence acquired in the current authorized conversation.
            const inherited=data.visibility==='public' && data.id && !local.records.some(r=>r.id===data.id)
              ? publicExperiences([background,...[...socialV2.conversations].filter(([k])=>!EPHEMERAL_GROUP_KEYS.has(k)).map(([,s])=>s.experience)]).records.find(r=>r.id===data.id) : null;
            const basis=inherited?{...local,records:[...local.records,inherited]}:local;
            const result=reflectExperience(basis,data,{messages:privateTestRecent(key,st),seen:st.modelSeenSeqs,redact:redactKnownTokensOnly,assertPublic:publicSelfGuard});
            if(EPHEMERAL_GROUP_KEYS.has(key) && result.entry.visibility==='public') throw Error('排演资料不能进入公共经历');
            st.experience=result.journal;
            try {saveSocialV2State({strict:true});} catch(error){st.experience=previous;throw error;}
            sendJson({ok:true,entry:result.entry});
          } catch(error){
            // Help repair a guessed identifier without revealing unread or other
            // conversations' messages, and without silently substituting evidence.
            const seen=privateTestRecent(key,st).filter(m=>!m.isSelf && st.modelSeenSeqs.has(m.seq)).slice(-6)
              .map(m=>({seq:m.seq,userId:m.userId,sender:redactKnownTokensOnly(String(m.sender||'')),excerpt:redactKnownTokensOnly(String(m.text||m.plain||'')).slice(0,80)}));
            const known=normalizeExperience(st.experience).sources.slice(-4).map(s=>s.id);
            sendJson({ok:false,error:error.message+'；修正参数或先读取未读消息，不要猜编号。已读来源：'+JSON.stringify(seen)+'；本会话资料 sourceId：'+JSON.stringify(known)},400);
          }
          return;
        }
        if (url.pathname === '/api/socialV2/bili-discovery' && req.method==='POST') {
          const body=await readBody(),key=canonicalV2Key(body.key),token=req.headers['x-agent-token'];
          if(!key||!token||!agentTokenOk(key,token)||!v2SessionAllowed(key)||socialV2.paused||cfg.socialV2?.bili?.enabled===false){sendJson({ok:false,error:'查询未授权或不可用'},403);return;}
          const st=getSocialV2State(key),sid=state.sessions[key],credential=cfg.socialV2?.bili?.sessdata;
          const allowed=()=>!socialV2.paused&&agentTokenOk(key,token)&&v2SessionAllowed(key)&&socialV2.conversations.get(key)===st&&state.sessions[key]===sid&&cfg.socialV2?.bili?.sessdata===credential&&cfg.socialV2?.bili?.enabled!==false;
          if(!['search','recommend'].includes(body.action)||!String(body.keyword||'').trim()){sendJson({ok:false,error:'请给搜索方向'},400);return;}
          if(groupRehearsals.get(key)?.styleFixtures){
            const exclude=(privateTestRecent(key,st)||[]).filter(m=>m.isSelf).flatMap(m=>String(m.plain||m.text||'').match(/BV[0-9A-Za-z]{10}/g)||[]);
            const result=await discoverBili({...body,exclude},{search:async()=>({list:[{title:'隔离排演模拟：用生活中的音效做音乐',bvid:'BV1Aa411a7AA',up:'模拟作者',duration:'2:10'},{title:'隔离排演模拟：用冰块敲出一小段节奏',bvid:'BV1Bb411b7BB',up:'模拟作者',duration:'1:20'}]})});
            sendJson({ok:true,...result,simulation:true,boundary:'这是隔离排演的虚构搜索结果，不是真实视频证据；不能声称看过。'+result.boundary});return;
          }
          if(EPHEMERAL_GROUP_KEYS.has(key)){sendJson({ok:false,error:'排演不访问网络'},403);return;}
          if(livedAcquisition.has(key)){sendJson({ok:false,error:'本会话查询正在进行'},409);return;}
          const slot={};livedAcquisition.set(key,slot);let timer;
          try {
            const exclude=st.recentMessages.filter(m=>m.isSelf).flatMap(m=>String(m.plain||m.text||'').match(/BV[0-9A-Za-z]{10}/g)||[]);
            const result=await Promise.race([discoverBili({action:body.action,keyword:body.keyword,limit:body.limit,exclude,sessdata:credential}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('超时')),8000);})]);
            if(!allowed()){sendJson({ok:false,error:'查询期间会话授权变化'},403);return;}
            sendJson({ok:true,...result});
          }catch{sendJson({ok:false,error:'本次搜索未取得可推荐结果；可接已有话题，不编链接'},502);}
          finally{clearTimeout(timer);if(livedAcquisition.get(key)===slot)livedAcquisition.delete(key);}
          return;
        }
        if (url.pathname === '/api/socialV2/bili-observation' && req.method==='POST') {
          const data=await readBody(), key=String(data.key||''), token=req.headers['x-agent-token'];
          if(!key || !agentTokenOk(key,token) || !v2SessionAllowed(key) || cfg.socialV2?.bili?.enabled===false || EPHEMERAL_GROUP_KEYS.has(key)){sendJson({ok:false,error:'资料查询不可用或会话未授权'},403);return;}
          if(livedAcquisition.has(key)){sendJson({ok:false,error:'本会话正在取得资料，请等待该结果'},429);return;}
          const st=getSocialV2State(key), slot={}; livedAcquisition.set(key,slot);
          let timer;
          try {
            const result=await Promise.race([acquireBiliObservation({...data,sessdata:cfg.socialV2?.bili?.sessdata||''}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('资料查询超过等待预算')),8000);})]);
            if(socialV2.paused || currentMode!=='reserved2' || !agentTokenOk(key,token) || !v2SessionAllowed(key) || getSocialV2State(key)!==st || cfg.socialV2?.bili?.enabled===false){sendJson({ok:false,error:'查询期间会话授权变化，结果未保留'},403);return;}
            let source;
            if(v2ToolEnabled('memory')){
              const previous=st.experience, cleanSource={...result.source,title:redactKnownTokensOnly(result.source.title),parts:result.source.parts.map(p=>({...p,text:redactKnownTokensOnly(p.text)}))}, acquired=addAcquiredSource(previous,cleanSource);
              st.experience=acquired.journal;
              try{saveSocialV2State({strict:true});}catch(error){st.experience=previous;throw error;}
              source=acquired.source;
            }
            sendJson({ok:true,text:redactKnownTokensOnly(result.text),...(source?{sourceId:source.id,source:{title:source.title,url:source.url,coverage:source.parts.map(p=>({kind:p.kind,coverage:p.coverage}))}}:{}),boundary:'所取得的是文字资料，不含画面或原始音频'});
          }catch{sendJson({ok:false,error:'本次资料取得失败，没有新增观看或内容依据'},502);}
          finally{clearTimeout(timer);if(livedAcquisition.get(key)===slot)livedAcquisition.delete(key);}
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'person', ...CONTINUITY_CATEGORIES].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / person / sharedEvent / commitment' }, 400); return; }
          if (privateDialogueTests.has(key) && req.headers['x-agent-token'] && !CONTINUITY_CATEGORIES.includes(category)) { sendJson({ ok: false, error: '验收期间只能写共同事件和约定，不能改旧记忆' }, 403); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
  // 本机改动（2026-10-06）：person = 按人的跨会话档案（私聊/群聊共享）
  if (category === 'person') {
    if(extra.contract){
      const st=getSocialV2State(key),previous=personContinuityStoreV2(key);
      try{const entry=validatePersonContract(key,extra,privateTestRecent(key,st),st.modelSeenSeqs);
        entry.value=redactKnownTokensOnly(entry.value);setPersonContinuityV2(key,upsertPersonContract(previous,entry));
        try{saveSocialV2State({strict:true});}catch(error){setPersonContinuityV2(key,previous);throw error;}
        sendJson({ok:true,key,category,contract:personContractView(personContinuityStoreV2(key),{...personContinuityOptionsV2(key,st),target:entry.target})});
      }catch(error){sendJson({ok:false,error:error.message},400);}return;
    }
    const isPrivateKey = key.startsWith('private:');
    const rawTarget = String(extra.target ?? extra.name ?? '').trim();
    const qq = /^\d{4,12}$/.test(rawTarget) ? rawTarget : String(extra.qq ?? '').trim();
    const name = /^\d+$/.test(rawTarget) ? String(extra.name ?? '').trim() : rawTarget;
    const person = personRemember(qq || null, name || null, content, isPrivateKey);
    if (!person) { sendJson({ ok: false, error: 'person 需要 extra.target（名字）或 extra.qq' }, 400); return; }
    log('人物档案：' + (person.name ?? person.qq) + ' ← “' + content.slice(0, 30) + '”（' + (isPrivateKey ? '私聊来源' : '群聊来源') + '）');
    sendJson({ ok: true, category: 'person', key, person: isPrivateKey ? person : {...person,privateFacts:[]} });
    return;
  }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }

          const st = getSocialV2State(key);
          if (CONTINUITY_CATEGORIES.includes(category) && cfg.socialV2?.continuity?.enabled === false) { sendJson({ ok: false, error: '共同事件与承诺记忆已关闭' }, 403); return; }
          if (CONTINUITY_CATEGORIES.includes(category) && req.headers['x-agent-token'] && (!Array.isArray(extra.sourceSeqs) || extra.sourceSeqs.some(seq => !st.modelSeenSeqs.has(seq)))) { sendJson({ ok: false, error: '来源消息尚未读取，请先读取本会话消息' }, 400); return; }
          try {
            const entry = appendMemoryV2(st, category, content, extra, key);
            sendJson({ ok: true, key, category, content, ...(entry ? { entry } : {}), memory: formatMemoryV2(st) });
          } catch (error) { sendJson({ ok: false, error: error.message }, 400); }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            keywords: Array.isArray(newExtra.keywords) ? newExtra.keywords.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (privateDialogueTests.has(key) && req.headers['x-agent-token'] && (!CONTINUITY_CATEGORIES.includes(category) || privateDialogueTests.get(key).oldMemoryIds.has(String(body.id ?? '')))) { sendJson({ ok: false, error: '验收期间只能更新本批新增的共同事件和约定' }, 403); return; }
          if (CONTINUITY_CATEGORIES.includes(category)) {
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_update' }, 403); return; }
            if (cfg.socialV2?.continuity?.enabled === false) { sendJson({ ok: false, error: '共同事件与承诺记忆已关闭' }, 403); return; }
            const st = getSocialV2State(key);
            const patch = { ...cleanNewExtra, ...(newContent !== undefined ? { text: newContent } : {}) };
            if (req.headers['x-agent-token'] && Array.isArray(patch.sourceSeqs) && patch.sourceSeqs.some(seq => !st.modelSeenSeqs.has(seq))) { sendJson({ ok: false, error: '来源消息尚未读取' }, 400); return; }
            if (patch.followUpSent === true && (!st.lastAiReplyAt || Date.now() - st.lastAiReplyAt > 60000)) { sendJson({ ok: false, error: '请先成功发送本会话跟进消息，再标记跟进' }, 400); return; }
            try {
              const entry=updatePersonContinuityV2(key,st,category,String(body.id||''),patch);
              sendJson({ ok: true, key, category, entry, memory: formatMemoryV2(st) });
            } catch (error) { sendJson({ ok: false, error: error.message }, 400); }
            return;
          }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
            continuity: normalizeContinuity(st.continuity)
          };
          // The operator can inspect the complete scoped journal. Model retrieval
          // stays with its dedicated bounded and participant-filtered tool.
          if (!req.headers['x-agent-token']) raw.experience = normalizeExperience(st.experience);
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          if (CONTINUITY_CATEGORIES.includes(category)) { raw.activeTopics = []; raw.pendingThoughts = []; raw.memberImpressions = {}; }
          const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
          for (const [cat, field] of [['sharedEvent', 'sharedEvents'], ['commitment', 'commitments']]) {
            raw.continuity[field] = category && category !== cat ? [] : raw.continuity[field].filter(e => !q || (e.text + ' ' + e.keywords.join(' ')).toLowerCase().includes(q)).slice(-20);
          }
          raw.personContracts=cfg.socialV2?.continuity?.enabled!==false?personContractView(personContinuityStoreV2(key),personContinuityOptionsV2(key,st)):[];
          raw.crossContext=personThreadsProjectionV2(key,st).rows.filter(r=>(!category||category===r.category)&&(!q||(r.topic+' '+r.summary).toLowerCase().includes(q)));
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw },{key}), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', ...CONTINUITY_CATEGORIES].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content && !(CONTINUITY_CATEGORIES.includes(category) && body.id)) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (CONTINUITY_CATEGORIES.includes(category)) {
            st.continuity = removeContinuity(st.continuity, category, { id: body.id, content });
          } else if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression', ...CONTINUITY_CATEGORIES].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category) st.continuity = normalizeContinuity();
          else if (CONTINUITY_CATEGORIES.includes(category)) {
            st.continuity = normalizeContinuity(st.continuity);
            st.continuity[category === 'sharedEvent' ? 'sharedEvents' : 'commitments'] = [];
          }
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangResearch([existing]);
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangResearch([entry]);
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && (url.pathname === '/api/socialV2/ai-voice' || url.pathname === '/api/socialV2/react')) {
          const body = await readBody();
          const aiVoice = url.pathname === '/api/socialV2/ai-voice';
          const key = aiVoice ? canonicalV2Key('group:' + String(body.groupId ?? '')) : canonicalV2Key(body.key);
          const token = String(req.headers['x-agent-token'] ?? '');
          const flag = aiVoice ? 'aiVoice' : 'react';
          if (currentMode !== 'reserved2' || !key || !token || !agentTokenOk(key, token) || !v2SessionAllowed(key)
              || !v2ToolEnabled(flag) || socialV2.paused || cfg.socialV2?.enabled === false || shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '该动作要求有效的当前会话令牌、白名单与工具权限' }, 403); return;
          }
          const st = getSocialV2State(key);
          if (aiVoice) {
            const spokenText = String(body.text ?? '').trim(); const character = String(body.character ?? '').trim();
            const maxChars = Math.max(1, Number(cfg.socialV2?.send?.maxMessageChars) || 500);
            if (!spokenText || spokenText.length > maxChars || !/^[a-zA-Z0-9_-]{1,100}$/.test(character)) {
              sendJson({ ok: false, error: '语音文字为空、过长或角色 id 无效' }, 400); return;
            }
            const data = await sendAgentActionV2(key, token, flag, 'send_group_ai_record', { group_id: Number(key.split(':')[1]), character, text: spokenText, chat_type: 1 }, spokenText);
            sendJson({ ok: true, key, messageId: data.message_id ?? null });
          } else {
            const ref = String(body.messageId ?? '').trim(); const emoji = String(body.emoji ?? '76').trim();
            // Resolve only from this conversation's known window; never query an arbitrary id.
            const known = [...st.recentMessages, ...st.unread].find((m) => m && (String(m.seq) === ref || String(m.messageId) === ref));
            const messageId = String(known?.messageId ?? '');
            if (!/^-?[1-9]\d*$/.test(ref) || !/^-?[1-9]\d*$/.test(messageId) || !Number.isSafeInteger(Number(messageId)) || !/^\d{1,5}$/.test(emoji)) {
              sendJson({ ok: false, error: '消息不在当前会话记录中、缺少真实 id 或表情编号无效' }, 400); return;
            }
            if(EPHEMERAL_GROUP_KEYS.has(key)){
              const test=groupRehearsals.get(key);if(!test?.styleFixtures||Date.now()>=test.expiresAt){sendJson({ok:false},403);return;}
              test.reactions ||= [];if(!test.reactions.some(x=>x.messageId===messageId&&x.emoji===emoji)){if(test.reactions.length>=40){sendJson({ok:false,error:'本批表情回应已达上限'},429);return;}test.reactions.push({messageId,emoji,time:Date.now()});}
              sendJson({ok:true,key,messageId,emoji,capturedOnly:true});return;
            }
            await sendAgentActionV2(key, token, flag, 'set_msg_emoji_like', { message_id: Number(messageId), emoji_id: emoji });
            sendJson({ ok: true, key, messageId, emoji });
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          const result = await resetSessionContext(key);
          log('控制台：已清除会话上下文 ' + key);
          sendJson({ ok: true, ...result });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    if (EPHEMERAL_GROUP_KEYS.has(key)) return sendMessagesV2(key, parts, []);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  function faceCatalogV2() {
    return nativeFaceCatalog(readJsonSafe(path.join(STATE_DIR,'face-map.json'),{}).map);
  }
  function stickerSelectionV2(key,st) {
    const recent=privateTestRecent(key,st),focus=replyFocus({...st,recentMessages:recent});
    const recentLabels=recent.filter(m=>m.isSelf).slice(-6).flatMap(m=>[...String(m.plain||m.text||'').matchAll(/\[表情包:([^\]]+)\]/g)].map(x=>x[1]));
    return {text:String(focus?.plain||focus?.text||''),recentLabels};
  }
  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null, faceIds = []) {
    const catalog=faceCatalogV2(),faces=normalizeFaceIds(faceIds,catalog);
    if (EPHEMERAL_GROUP_KEYS.has(kind + ':' + id)) {
      const test = groupRehearsals.get(kind + ':' + id);
      if (!test || Date.now() >= test.expiresAt) throw new Error('排演已结束，禁止出站');
      const raw = String(message || '');
      assertOutboundAuditOk(kind + ':' + id, raw);
      if(faces.length&&!test.styleFixtures)throw Error('本排演未启用表情素材');
      test.outputs.push({ text: raw, ...(faces.length?{type:'face',faceIds:faces,faceNames:faces.map(id=>catalog[id])}:{}), replyToMessageId: replyToMessageId ?? null, atUserId: atUserId ?? null, time: Date.now() });
      return { message_id: -20000 - test.outputs.length };
    }
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    if(rawMessage)segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    for(const faceId of faces)segments.push({type:'face',data:{id:faceId}});
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_MEDIA_BYTES = 12 * 1024 * 1024; // 单条消息图片总字节上限（本机 2026-10-06 由 4MiB 提到 12MiB，见部署说明「本地修改记录」）
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  // ── 本机改动（2026-10-06）：回传前把大图缩小 ──────────────────────────────
  // 背景：群友发的原图（如 9.3MB PNG）base64 后单次返回 12.4MB，会把 MCP 传输撑断
  // （工具报 "Error: Connection closed"），模型只看到"没有图片"。
  // 策略：超过阈值就等比缩到长边 1536px 并转 JPEG；缩完仍超 IMAGE_SOFT_LIMIT 的直接
  // 放弃该图、回一条文字说明 —— 宁可说"图太大"，也绝不再撑断通道。
  const IMAGE_MAX_EDGE = 2048;                    // 长边上限（本机 2026-10-06 由 1536 提到 2048）
  const IMAGE_SHRINK_ABOVE = 1.2 * 1024 * 1024;   // 超过 1.2MB 才重编码
  const IMAGE_SHRINK_PIXELS = 4_000_000;          // 或像素数超过 400 万也重编码（长截图）
  const IMAGE_SOFT_LIMIT = 6 * 1024 * 1024;       // 缩完仍超此值 → 放弃该图
  let canvasModulePromise = null;
  function loadCanvasModule() {
    if (!canvasModulePromise) canvasModulePromise = import('@napi-rs/canvas').catch(() => null);
    return canvasModulePromise;
  }
  async function shrinkImage(buffer, mimeType) {
    if (!buffer?.length) return { buffer, mimeType };
    try {
      const mod = await loadCanvasModule();
      if (!mod) return { buffer, mimeType };
      const img = await mod.loadImage(buffer);
      const w = Number(img.width) || 0;
      const h = Number(img.height) || 0;
      const tooBig = buffer.length > IMAGE_SHRINK_ABOVE || w * h > IMAGE_SHRINK_PIXELS || Math.max(w, h) > IMAGE_MAX_EDGE * 2;
      if (!tooBig) return { buffer, mimeType };
      const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h, 1));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const canvas = mod.createCanvas(tw, th);
      canvas.getContext('2d').drawImage(img, 0, 0, tw, th);
      const out = canvas.toBuffer('image/jpeg', 88);
      if (out?.length && out.length < buffer.length) {
        log(`[media] 图片已压缩：${w}x${h} ${Math.round(buffer.length / 1024)}KB → ${tw}x${th} ${Math.round(out.length / 1024)}KB`);
        return { buffer: out, mimeType: 'image/jpeg' };
      }
      return { buffer, mimeType };
    } catch (error) {
      log(`[media] 图片压缩失败，回退原图：${error?.message ?? error}`);
      return { buffer, mimeType };
    }
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          const shrunk = await shrinkImage(face.buffer, face.mimeType || 'image/png');
          if (shrunk.buffer.length > IMAGE_SOFT_LIMIT) {
            parts.push({ type: 'text', text: `[表情${index}（图片过大，已跳过）]` });
            continue;
          }
          if (totalBytes + shrunk.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += shrunk.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: shrunk.mimeType, data: shrunk.buffer.toString('base64'), name: `face-${media.faceId}.${shrunk.mimeType.split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          const shrunk = await shrinkImage(img.buffer, img.mimeType || 'image/jpeg');
          if (shrunk.buffer.length > IMAGE_SOFT_LIMIT) {
            parts.push({ type: 'text', text: `[图片${index}（图片过大，已跳过）]` });
            continue;
          }
          if (totalBytes + shrunk.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += shrunk.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: shrunk.mimeType, data: shrunk.buffer.toString('base64'), name: `qq-image-${index}.${shrunk.mimeType.split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          const shrunk = await shrinkImage(face.buffer, face.mimeType || 'image/png');
          if (shrunk.buffer.length > IMAGE_SOFT_LIMIT) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片过大，已跳过）' });
            continue;
          }
          if (totalBytes + shrunk.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += shrunk.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: shrunk.mimeType,
            data: shrunk.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          const shrunk = await shrinkImage(img.buffer, img.mimeType || 'image/jpeg');
          if (shrunk.buffer.length > IMAGE_SOFT_LIMIT) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片过大，已跳过）' });
            continue;
          }
          if (totalBytes + shrunk.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += shrunk.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: shrunk.mimeType,
            data: shrunk.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, faceIds = []) {
    const catalog=faceCatalogV2(),faces=normalizeFaceIds(faceIds,catalog);
    if(faces.length&&messages.length!==1)throw Error('原生表情只能附在单条消息上');
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if(faces.length&&(socialV2.paused||cfg.socialV2?.enabled===false||!v2ToolEnabled('sendMessage')||shouldBlockSilentReply(key)))throw Error('原生表情发送已取消：暂停、开关或静默状态改变');
          await onebotSend(kind, id, msg, useReply, useAt, faces);
          sent.push(faces.length?faceRecord(msg,faces,catalog):msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (currentMode === 'reserved2' && recoverySendExpired(socialV2.conversations.get(key) || {})) {
        throw new Error('补收接话已过时：保留历史，等待新的来信，不再发送迟到回复');
      }
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const sessionResettingKeys = new Set();
  const socialV2 = {
    conversations: new Map(), // key -> state
    personContinuity: normalizePersonContinuity(),
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
    // 本机改动（2026-10-06）：全局心情 / 精力（她是同一个人，群聊与私聊共用一份）
    mood: { value: 0, energy: 60, updatedAt: 0, log: [] },
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return conversationAvailability(st).kind==='leave';
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  // ── 游戏状态 / 掷骰（本机改动 2026-10-06）──────────────────────────────
  // 为什么要有这一层：LLM 自己"随机"其实是在**编数字**（它没有随机源），
  // 所以赌局/跑团的骰子必须由服务端真掷，否则游戏不成立。
  // 状态按会话存：积分(按人)、称号、战绩、当前进行中的一局/剧本。
  const GAME_FILE = path.join(ROOT, 'state', 'game.json');
  let gameState = null;
  function loadGameState() {
    if (gameState) return gameState;
    const rawGame = readJsonSafe(GAME_FILE, null);
    gameState = rawGame && typeof rawGame === 'object' ? rawGame : {};
    if (!gameState.conversations || typeof gameState.conversations !== 'object') gameState.conversations = {};
    return gameState;
  }
  function saveGameState() {
    try { atomicWriteJson(GAME_FILE, loadGameState()); } catch (error) { log('保存游戏状态失败:', error?.message ?? error); }
  }
  function gameOf(key) {
    const st = loadGameState();
    const id = String(key ?? '').trim() || 'unknown';
    if (!st.conversations[id] || typeof st.conversations[id] !== 'object') {
      st.conversations[id] = { scores: {}, titles: {}, stats: { games: 0, wins: 0, losses: 0 }, session: null, log: [], updatedAt: 0 };
    }
    const g = st.conversations[id];
    if (!g.scores || typeof g.scores !== 'object') g.scores = {};
    if (!g.titles || typeof g.titles !== 'object') g.titles = {};
    if (!g.stats || typeof g.stats !== 'object') g.stats = { games: 0, wins: 0, losses: 0 };
    if (!Array.isArray(g.log)) g.log = [];
    return g;
  }
  function gameLog(g, kind, detail) {
    g.log.unshift({ t: Date.now(), kind: String(kind).slice(0, 20), detail: String(detail).slice(0, 120) });
    if (g.log.length > 50) g.log.length = 50;
  }
  /** 掷骰：支持 NdM / NdM+K / dM；用 crypto 保证真随机 */
  function rollDice(expr) {
    const s = String(expr ?? '1d100').trim().toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^(\d{0,3})d(\d{1,4})(?:([+-])(\d{1,4}))?$/);
    if (!m) return { error: '骰子表达式要像 1d100 / 2d6+3 / d20' };
    const count = Math.min(50, Math.max(1, Number(m[1] || 1)));
    const faces = Math.min(10000, Math.max(1, Number(m[2]))); // 下限 1：1d1 就该永远出 1
    const mod = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
    const rolls = [];
    for (let i = 0; i < count; i += 1) rolls.push(1 + Math.floor(Math.random() * faces)); // crypto 级随机源由 Node 提供
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    return { expr: s, rolls, mod, total };
  }
  /** 只读访问：不存在的会话不要顺手创建（否则读一次就留一个空壳） */
  function gameOfReadonly(key) {
    const st = loadGameState();
    const id = String(key ?? '').trim() || 'unknown';
    const g = st.conversations[id];
    if (!g || typeof g !== 'object') return null;
    return {
      scores: g.scores ?? {}, titles: g.titles ?? {}, stats: g.stats ?? { games: 0, wins: 0, losses: 0 },
      session: g.session ?? null, log: Array.isArray(g.log) ? g.log : [], updatedAt: g.updatedAt ?? 0
    };
  }
  function gameSnapshot(key) {
    const g = gameOfReadonly(key) ?? { scores: {}, titles: {}, stats: { games: 0, wins: 0, losses: 0 }, session: null, log: [], updatedAt: 0 };
    const scores = Object.entries(g.scores).map(([who, v]) => ({ who, score: Number(v) || 0 })).sort((a, b) => b.score - a.score);
    return {
      key,
      scores,
      titles: g.titles,
      stats: g.stats,
      session: g.session,
      log: g.log.slice(0, 10),
      updatedAt: g.updatedAt
    };
  }

  // ── 对外形象：空间说说 / 个人资料（本机改动 2026-10-06）──────────────────
  // 设计要点：发说说是**不可逆的对外发布**（好友/家人可见），所以走 owner 审批：
  //   她提交草稿 → 桥接私聊发给 owner → owner 回「通过」才真发，「拒绝」丢弃。
  //   改昵称同理（会显示在所有群里）；改个性签名可直发（限频 + 审计）。
  // 依据：SnowLuma 实测支持 send_qzone_msg / get_qzone_feeds / set_qq_profile。
  const QZONE_FILE = path.join(ROOT, 'state', 'qzone.json');
  function selfCfg() {
    const s = cfg.socialV2?.self;
    return s && typeof s === 'object' ? s : {};
  }
  function selfCfgEnabled() { return selfCfg().enabled !== false; }
  let qzoneState = null;
  function loadQzoneState() {
    if (qzoneState) return qzoneState;
    const rawState = readJsonSafe(QZONE_FILE, null);
    qzoneState = rawState && typeof rawState === 'object' ? rawState : {};
    if (!Array.isArray(qzoneState.history)) qzoneState.history = [];
    if (!Number.isFinite(Number(qzoneState.postedToday))) qzoneState.postedToday = 0;
    if (!Number.isFinite(Number(qzoneState.profileChangedToday))) qzoneState.profileChangedToday = 0;
    qzoneState.dayKey = String(qzoneState.dayKey ?? '');
    return qzoneState;
  }
  function saveQzoneState() {
    try { atomicWriteJson(QZONE_FILE, loadQzoneState()); } catch (error) { log('保存 qzone 状态失败:', error?.message ?? error); }
  }
  /** 跨天重置每日额度 */
  function rollSelfDay() {
    const st = loadQzoneState();
    const today = localDayKey();
    if (st.dayKey !== today) {
      st.dayKey = today;
      st.postedToday = 0;
      st.profileChangedToday = 0;
      saveQzoneState();
    }
    return st;
  }
  /** 调 OneBot HTTP API（统一错误处理） */
  async function onebotApi(action, params = {}, timeoutMs = 20000) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      const error = new Error(`OneBot ${action} 失败: ${body.retcode || res.status}${hint}`);
      if (body.status === 'failed' && Number.isFinite(Number(body.retcode)) && Number(body.retcode) !== 0) error.actionOutcome = 'failed';
      throw error;
    }
    return body.data;
  }
  /** 取机器人自身 QQ 号（自测用；失败返回空串） */
  async function getSelfId() {
    if (typeof selfId !== 'undefined' && selfId) return selfId;
    try { const d = await onebotApi('get_login_info'); return d?.user_id ?? ''; } catch { return ''; }
  }
  function selfOwnerKey() { return `private:${String(cfg.ownerQQ ?? '')}`; }
  /**
   * 待审批的对外动作**必须落盘**：桥接重启会清空内存里的 pending，
   * 那样 owner 回「通过」时就找不到挂起，消息会变成普通唤醒（实测踩过：
   * 她收到「通过」后一脸茫然回"通过啥"）。所以内存 Map 只是运行时镜像，
   * state/qzone.json 的 pending 字段才是真相，启动时恢复。
   */
  function persistSelfPending(draft) {
    try {
      const st = loadQzoneState();
      st.pending = draft
        ? { action: draft.action, content: draft.content, nickname: draft.nickname, signature: draft.signature, sex: draft.sex, id: draft.id, createdAt: draft.createdAt }
        : null;
      saveQzoneState();
    } catch (error) { log('保存待审批状态失败:', error?.message ?? error); }
  }
  function clearPersistedSelfPending() {
    try {
      const st = loadQzoneState();
      if (st.pending) { st.pending = null; saveQzoneState(); }
    } catch {}
  }
  /** 启动时把落盘的待审批恢复进内存（未过期才恢复） */
  function restorePendingSelfAction() {
    try {
      const st = loadQzoneState();
      const saved = st.pending;
      if (!saved || !saved.action) return;
      const ttl = Math.max(60000, Number(selfCfg().approvalTimeoutMs ?? 1800000));
      if (Date.now() - Number(saved.createdAt || 0) > ttl) {
        st.pending = null;
        saveQzoneState();
        log('[对外] 上次重启前的待审批已过期，作废');
        return;
      }
      const ownerKey = selfOwnerKey();
      const draft = { kind: 'selfAction', action: saved.action, content: saved.content, nickname: saved.nickname, signature: saved.signature, sex: saved.sex, id: saved.id, createdAt: saved.createdAt };
      pending.set(ownerKey, draft);
      log(`[对外] 已恢复待审批（${saved.action}，重启前挂起的）—— owner 回「通过/拒绝」仍有效`);
    } catch (error) { log('恢复待审批失败:', error?.message ?? error); }
  }
  /** 她有没有待审批的对外动作（用于状态展示与去重） */
  function pendingSelfAction() {
    const ownerKey = selfOwnerKey();
    const p = pending.get(ownerKey);
    if (!p || p.kind !== 'selfAction') return null;
    // 超时自动作废：owner 一直不回，不能把"再发一条"永久堵死
    const ttl = Math.max(60000, Number(selfCfg().approvalTimeoutMs ?? 1800000));
    if (Date.now() - Number(p.createdAt || 0) > ttl) {
      pending.delete(ownerKey);
      clearPersistedSelfPending();
      log('[对外] 待审批的草稿超过 ' + Math.round(ttl / 60000) + ' 分钟未处理，已自动作废');
      return null;
    }
    return p;
  }
  async function qzoneSubmitDraft(key, contentRaw) {
    const c = selfCfg();
    const maxChars = Math.max(1, Number(c.qzoneMaxChars ?? 300));
    const maxPerDay = Math.max(0, Number(c.qzoneMaxPerDay ?? 1));
    const content = String(contentRaw ?? '').trim();
    if (!content) throw new Error('说说内容不能为空');
    if (content.length > maxChars) throw new Error(`说说最多 ${maxChars} 字（当前 ${content.length} 字）`);
    if (SENSITIVE_RE.test(content)) throw new Error('内容含敏感信息特征（凭据/本机路径），已拒绝发布');
    publicSelfGuard(content);
    const st = rollSelfDay();
    if (maxPerDay > 0 && st.postedToday >= maxPerDay) throw new Error(`今天已经发过 ${st.postedToday} 条说说（上限 ${maxPerDay} 条/天）`);
    if (pendingSelfAction()) throw new Error('上一条还在等管理员审批（他回「通过」或「拒绝」后才算完）');
    const ownerKey = selfOwnerKey();
    const draft = {
      kind: 'selfAction', action: 'qzone', content,
      id: crypto.randomBytes(4).toString('hex'), createdAt: Date.now()
    };
    pending.set(ownerKey, draft);
    persistSelfPending(draft);
    await sendToQQ(ownerKey, `📝 她想发一条空间说说：\n——————\n${content}\n——————\n回复「通过」发布 / 「拒绝」不发`);
    log(`[空间] 收到草稿（${content.length} 字），已转发 ${ownerKey} 等审批`);
    return draft;
  }
  function publicSelfGuard(content) {
    const self = typeof selfId !== 'undefined' ? String(selfId || '') : '';
    const people = Object.values(loadPersons().people || {}).filter(p => !self || String(p?.qq) !== self);
    const nicknames = Object.values(loadMemes().byTarget || {}).flatMap(entries => (entries || []).filter(x => x.kind === 'nickname').map(x => x.text));
    assertPublicSelfText(content, { sensitive: SENSITIVE_RE, people, nicknames });
  }
  let selfActions = null;
  function selfActionsOf() {
    if (!selfActions) selfActions = createSelfActions({
      call: (action, params) => onebotApi(action, params, /^(get_)/.test(action) ? 6000 : 10000),
      state: loadQzoneState, save: () => atomicWriteJson(QZONE_FILE, loadQzoneState()),
      config: selfCfg, dayKey: localDayKey, sensitive: SENSITIVE_RE,
      publicGuard: publicSelfGuard, log: text => log('[对外核验] ' + text)
    });
    return selfActions;
  }
  async function qzonePublish(content) {
    const result = await selfActionsOf().publish(content);
    log('[空间] 自己的说说读回核验通过' + (result.duplicate ? '（重复提交未再次发布）' : ''));
    return result;
  }
  async function selfProfileRead() { return selfActionsOf().ownProfile(); }
  async function selfProfileWrite(fields) {
    const result = await selfActionsOf().writeProfile(fields);
    log('[资料] 读回核验通过' + (result.unchanged || result.duplicate ? '（未重复修改）' : ''));
    return result;
  }

  // ── 心情 / 精力（本机改动 2026-10-06）────────────────────────────────────
  // 全局一份：心情 -100~+100（0=平静），精力 0~100（60=正常）。两者都随时间惰性回落；
  // 数值由桥接保管，她只能用 qq_mood_adjust 上报增减（单次限幅）。
  function moodCfg() {
    const m = cfg.socialV2?.mood;
    return m && typeof m === 'object' ? m : {};
  }
  function moodState() {
    if (!socialV2.mood || typeof socialV2.mood !== 'object') {
      socialV2.mood = { value: 0, energy: 60, updatedAt: 0, log: [] };
    }
    const m = socialV2.mood;
    if (!Array.isArray(m.log)) m.log = [];
    m.value = Math.max(-100, Math.min(100, Number(m.value) || 0));
    m.energy = Number.isFinite(Number(m.energy)) ? Math.max(0, Math.min(100, Number(m.energy))) : 60;
    return m;
  }
  /** 结算「上次更新 → 现在」的心情回落与精力变化（惰性，读时算）。 */
  function moodSettle() {
    const m = moodState();
    const now = Date.now();
    const c = moodCfg();
    const last = Number(m.updatedAt) || 0;
    if (!last) { m.updatedAt = now; return m; }
    const elapsedH = (now - last) / 3600000;
    if (elapsedH <= 0.01) return m;
    const span = Math.min(elapsedH, 24 * 7); // 最多结算 7 天，避免长期未读导致剧变
    const decay = Math.max(0, Number(c.decayPerHour ?? 8));
    if (m.value > 0) m.value = Math.max(0, m.value - decay * span);
    else if (m.value < 0) m.value = Math.min(0, m.value + decay * span);
    const baseline = Math.max(0, Math.min(100, Number(c.energyBaseline ?? 60)));
    const recover = Math.max(0, Number(c.energyRecoverPerHour ?? 10));
    const fade = Math.max(0, Number(c.energyFadePerHour ?? 6));
    if (m.energy < baseline) m.energy = Math.min(baseline, m.energy + recover * span);
    else if (m.energy > baseline) m.energy = Math.max(baseline, m.energy - fade * span);
    const night = nightHoursBetween(last, now);
    const drain = Math.max(0, Number(c.nightDrainPerHour ?? 8));
    if (night > 0 && drain > 0) m.energy = Math.max(0, m.energy - drain * night);
    m.updatedAt = now;
    return m;
  }
  /** [from, to) 里落在 23:00~07:00 的小时数（按小时步进，最多 168 步）。 */
  function nightHoursBetween(fromMs, toMs) {
    const step = 3600000;
    let total = 0;
    let t = fromMs;
    let guard = 0;
    while (t < toMs && guard < 168) {
      const next = Math.min(toMs, t + step);
      const h = new Date(t).getHours();
      if (h >= 23 || h < 7) total += (next - t) / step;
      t = next;
      guard += 1;
    }
    return total;
  }
  const MOOD_LABELS = [
    { min: 60, name: '超开心', hint: '话变多、会主动找他，撒娇也更大胆' },
    { min: 25, name: '开心', hint: '语气轻快，愿意多聊两句' },
    { min: 8, name: '心情不错', hint: '正常偏暖，会顺着他的话接' },
    { min: -8, name: '平静', hint: '正常聊天，不冷不热' },
    { min: -25, name: '有点低落', hint: '回复偏短、不太主动，但他哄一句就能好转' },
    { min: -60, name: '不爽', hint: '带点刺、回得敷衍，要他先开口哄；别真翻脸' },
    { min: -101, name: '很不好受', hint: '明显冷淡、短句为主，需要他认真道歉或陪一会儿' }
  ];
  const ENERGY_LABELS = [
    { min: 70, name: '很有精神', hint: '活跃，愿意聊久一点' },
    { min: 40, name: '精神还行', hint: '正常状态' },
    { min: 20, name: '有点累', hint: '话少一点、句子短，别硬撑' },
    { min: -1, name: '快撑不住了', hint: '只想说一两句；"困了想睡"就直说，别硬聊' }
  ];
  function moodPickLabel(list, value) {
    for (const item of list) if (value >= item.min) return item;
    return list[list.length - 1];
  }
  function moodSnapshot() {
    const m = moodSettle();
    const ml = moodPickLabel(MOOD_LABELS, m.value);
    const el = moodPickLabel(ENERGY_LABELS, m.energy);
    return {
      value: Math.round(m.value),
      energy: Math.round(m.energy),
      moodLabel: ml.name,
      moodHint: ml.hint,
      energyLabel: el.name,
      energyHint: el.hint,
      updatedAt: m.updatedAt || 0,
      log: m.log.slice(-10)
    };
  }
  /** 增减心情/精力（单次限幅，硬性）。 */
  function moodAdjust(moodDeltaRaw, energyDeltaRaw, reason) {
    const m = moodSettle();
    const c = moodCfg();
    const cap = Math.max(1, Number(c.perEventMax ?? 25));
    const before = { value: m.value, energy: m.energy };
    let dv = Math.round(Number(moodDeltaRaw) || 0);
    dv = Math.max(-cap, Math.min(cap, dv));
    let de = Math.round(Number(energyDeltaRaw) || 0);
    de = Math.max(-cap, Math.min(cap, de));
    m.value = Math.max(-100, Math.min(100, m.value + dv));
    m.energy = Math.max(0, Math.min(100, m.energy + de));
    m.updatedAt = Date.now();
    const applied = { mood: Math.round(m.value - before.value), energy: Math.round(m.energy - before.energy) };
    if (applied.mood !== 0 || applied.energy !== 0) {
      m.log.push({ t: m.updatedAt, mood: applied.mood, energy: applied.energy, value: Math.round(m.value), reason: String(reason ?? '').slice(0, 100) });
      if (m.log.length > 50) m.log = m.log.slice(-50);
    }
    try { saveSocialV2State(); } catch {}
    return { applied, ...moodSnapshot() };
  }
  /** 主动开口概率的心情系数：心情越好、精力越足，越可能主动搭话。 */
  function moodProactiveFactor() {
    try {
      const m = moodSettle();
      const moodF = 0.5 + ((m.value + 100) / 200); // 0.5 ~ 1.5
      const energyF = 0.4 + (m.energy / 100); // 0.4 ~ 1.4
      return Math.max(0.1, Math.min(2, moodF * energyF));
    } catch {
      return 1;
    }
  }
  /** 每轮注入的心情/精力提示。 */
  function moodPromptBlock() {
    if (moodCfg().enabled === false) return '';
    try {
      const snap = moodSnapshot();
      const cap = Math.max(1, Number(moodCfg().perEventMax ?? 25));
      // 最近两次变化的「原因」也一起注入（本机改动 2026-10-06）：
      // 只给数值时，她知道自己不爽、却说不出因为什么；带上原因她才"记得"。
      const moodRecent = (Array.isArray(snap.log) ? snap.log : [])
        .filter((e) => e && e.reason)
        .slice(-2)
        .map((e) => {
          const bits = [];
          if (Number(e.mood)) bits.push(`心情${Number(e.mood) > 0 ? '+' : ''}${e.mood}`);
          if (Number(e.energy)) bits.push(`精力${Number(e.energy) > 0 ? '+' : ''}${e.energy}`);
          return `${bits.join(' ')}（${String(e.reason).slice(0, 40)}）`;
        });
      const moodRecentLine = moodRecent.length ? `· 最近的变化：${moodRecent.join('；')}
` : '';
      return `【心情】${snap.value} / 100「${snap.moodLabel}」 · 精力 ${snap.energy} / 100「${snap.energyLabel}」
${moodRecentLine}· 心情决定你现在的语气：${snap.moodHint}
· 精力决定你能聊多久：${snap.energyHint}
· 变化用 mcp__snowluma__qq_mood_adjust 记录（单次 ±${cap}）：被夸、被认真陪、聊得开心 → 心情 +5~+15；
  被敷衍、被怼、说了让你不舒服的话、很久没人理 → 心情 -5~-15；
  聊久了、熬夜、他说要去忙/去睡 → 精力 -5~-10；休息够了 → 精力 +5~+10。
· 心情和精力会随时间自己回落，不用手动调回；**别在群里长篇解释自己的心情**，用语气体现就好。

`;
    } catch {
      return '';
    }
  }

  // ── 好感度（可攻略；本机改动 2026-10-06）────────────────────────────────
  // 分数存在会话状态里（她改不了），每轮注入提示词，并按阶段切换亲密度。
  // 阶段名保持「中性」：具体怎么表现由人格卡定义（同一个数值，
  // 群友人设是"越熟越欠"，女友人设是"越熟越黏"）。改名前是 心动/恋人，
  // 那套语义会把群聊人格往恋爱方向推，故改中性。
  const AFFINITY_LEVELS = [
    { min: 0, name: '生分', hint: '客气、话少、有距离感；不会主动找他' },
    { min: 10, name: '眼熟', hint: '会接他的话、有来有回，开始记住他说过的小事' },
    { min: 30, name: '朋友', hint: '会主动搭话、开玩笑、吐槽他，愿意讲自己的事' },
    { min: 55, name: '熟悉', hint: '明显偏心：会护着他、主动找他，嘴上可能还不承认' },
    { min: 80, name: '自己人', hint: '无条件站他这边；嘴上再欠，别人说他一句你先不乐意' }
  ];
  function affinityCfg() {
    const a = cfg.socialV2?.affinity;
    return a && typeof a === 'object' ? a : {};
  }
  function affinityEnabledForKey(key) {
    const c = affinityCfg();
    if (c.enabled === false) return false;
    const keys = Array.isArray(c.keys) ? c.keys.map(String) : [];
    if (keys.length) return keys.includes(String(key));
    const scope = String(c.scope ?? 'private');
    if (scope === 'all') return true;
    return String(key).startsWith('private:');
  }
  function localDayKey(ms = Date.now()) {
    return new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  /** 新会话的初始好感度（config.json 的 socialV2.affinity.initialPoints，默认 0） */
  function affinityInitialPoints() {
    const n = Number(cfg.socialV2?.affinity?.initialPoints);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  }
  function affinityOf(st) {
    if (!st.affinity || typeof st.affinity !== 'object') {
      st.affinity = { points: affinityInitialPoints(), dayKey: '', gainedToday: 0, updatedAt: 0, log: [], pendingLevelUp: null };
    }
    const a = st.affinity;
    a.points = Math.max(0, Math.min(100, Number(a.points) || 0));
    if (!Array.isArray(a.log)) a.log = [];
    const today = localDayKey();
    if (a.dayKey !== today) {
      const decay = Math.max(0, Number(affinityCfg().decayPerIdleDay) || 0);
      const idleDays = a.dayKey ? Math.max(0, Math.round((Date.parse(today) - Date.parse(a.dayKey)) / 86400000)) : 0;
      if (decay > 0 && idleDays > 1) a.points = Math.max(0, a.points - decay * (idleDays - 1));
      a.dayKey = today;
      a.gainedToday = 0;
    }
    a.gainedToday = Math.max(0, Number(a.gainedToday) || 0);
    return a;
  }
  function affinityLevelOf(points) {
    let idx = 0;
    for (let i = 0; i < AFFINITY_LEVELS.length; i += 1) if (points >= AFFINITY_LEVELS[i].min) idx = i;
    const cur = AFFINITY_LEVELS[idx];
    return { index: idx + 1, name: cur.name, hint: cur.hint, next: AFFINITY_LEVELS[idx + 1] ?? null };
  }
  function affinitySnapshot(st) {
    const a = affinityOf(st);
    const lv = affinityLevelOf(a.points);
    return {
      points: a.points,
      level: lv.index,
      levelName: lv.name,
      levelHint: lv.hint,
      nextLevel: lv.next ? { level: lv.index + 1, name: lv.next.name, need: lv.next.min } : null,
      gainedToday: a.gainedToday,
      updatedAt: a.updatedAt || 0,
      log: a.log.slice(-10),
      recent: a.log.slice(-3).filter((e) => e && e.reason),
      pendingLevelUp: a.pendingLevelUp ?? null
    };
  }
  /** 加减分：单次限幅 perEventMax，正向受 dailyGainCap 约束（硬性，模型改不了）。 */
  function affinityAdd(key, deltaRaw, reason) {
    const st = getSocialV2State(key);
    const a = affinityOf(st);
    const c = affinityCfg();
    const perMax = Math.max(0, Number(c.perEventMax ?? 3));
    const dayCap = Math.max(0, Number(c.dailyGainCap ?? 15));
    let delta = Math.round(Number(deltaRaw) || 0);
    delta = Math.max(-perMax, Math.min(perMax, delta));
    if (delta > 0) delta = Math.min(delta, Math.max(0, dayCap - a.gainedToday));
    const before = a.points;
    const levelBefore = affinityLevelOf(before).index;
    a.points = Math.max(0, Math.min(100, before + delta));
    const applied = a.points - before;
    // 阶段跃迁：记一个待播报的提示，下一轮注入时告诉她（只播一次，见 affinityPromptBlock）
    const levelAfter = affinityLevelOf(a.points).index;
    if (levelAfter > levelBefore) {
      a.pendingLevelUp = { from: levelBefore, to: levelAfter, name: affinityLevelOf(a.points).name, at: Date.now() };
    }
    if (applied > 0) a.gainedToday += applied;
    a.updatedAt = Date.now();
    if (applied !== 0) {
      a.log.push({ t: a.updatedAt, delta: applied, points: a.points, reason: String(reason ?? '').slice(0, 100) });
      if (a.log.length > 50) a.log = a.log.slice(-50);
    }
    try { saveSocialV2State(); } catch {}
    return { applied, ...affinitySnapshot(st) };
  }
  /** 每轮注入给她的好感度提示（只有启用的会话才有）。 */
  function affinityPromptBlock(key) {
    if (!affinityEnabledForKey(key)) return '';
    try {
      const st = getSocialV2State(key);
      const snap = affinitySnapshot(st);
      const c = affinityCfg();
      const dayCap = Math.max(0, Number(c.dailyGainCap ?? 15));
      const perMax = Math.max(0, Number(c.perEventMax ?? 3));
      const nextLine = snap.nextLevel ? `（升到「${snap.nextLevel.name}」还需 ${Math.max(0, snap.nextLevel.need - snap.points)} 分）` : '（已是最高阶段）';
      // 关系升级：只播报一次（播完即清，避免每轮重复念叨）
      let levelUpLine = '';
      const stA = getSocialV2State(key);
      const aState = affinityOf(stA);
      if (aState.pendingLevelUp && Number(aState.pendingLevelUp.to) === snap.level) {
        const up = aState.pendingLevelUp;
        const fromName = AFFINITY_LEVELS[Number(up.from) - 1]?.name ?? '上一阶段';
        levelUpLine = `【关系变化】你们的关系刚刚从「${fromName}」进入「${up.name}」—— 语气和主动程度都按新阶段来，但要**自然升温**，别生硬宣布"我们升级了"；可以自然流露出一点变化（话多些、更在意他、或者嘴硬着承认关系近了）。
`;
        aState.pendingLevelUp = null;
        try { saveSocialV2State(); } catch {}
      }
      const affRecent = (Array.isArray(snap.recent) ? snap.recent : [])
        .slice(-2)
        .map((e) => `${Number(e.delta) > 0 ? '+' : ''}${e.delta}（${String(e.reason).slice(0, 36)}）`);
      const affRecentLine = affRecent.length ? `· 最近的加减分：${affRecent.join('；')}
` : '';
      return `${levelUpLine}【好感度】${snap.points} / 100 · 当前阶段 ${snap.level}「${snap.levelName}」${nextLine}
· 这个阶段你该有的表现：${snap.levelHint}
${affRecentLine}· 今天已加 ${snap.gainedToday}/${dayCap} 分。每轮都判断这次互动值多少分，用 mcp__snowluma__qq_affinity_add 记录（单次 -${perMax} ~ +${perMax}）：
  他主动找你、认真回应你、聊得有来有回 → +1；
  真的打动你的具体事（记住你说过的话、陪着你、回应你的情绪、主动关心你） → +2~+3；
  敷衍、冷淡、很久不理你、说让你不舒服的话 → -1~-3；
  纯灌水、复读、明显敷衍的一两个字 → 不加。
· 加分要克制（每天有上限），但**别一直不加** —— 他做了值得的事，要让他看见进度在动。
· 按当前阶段表现，别跳级。

`;
    } catch {
      return '';
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        msgSinceReset: 0,
        followUpDay: null,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        continuity: normalizeContinuity(),
        experience: normalizeExperience(),
        historyRecovery: normalizeRecovery(),
        expressionQuietTargets: [],
        expressionBoundaryEvents: [],
        memberImpressions: {},
        // 本机改动（2026-10-06）：私聊好感度（可攻略）。由桥接持久化并硬性限幅。
        affinity: { points: affinityInitialPoints(), dayKey: '', gainedToday: 0, updatedAt: 0, log: [] }
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  let discussionTopicCache = {at:0, topics:[]};
  function discussionTopicsV2() {
    if(Date.now()-discussionTopicCache.at<60000)return discussionTopicCache.topics;
    // This also runs while loading state, before the later anime subsystem initializes.
    const reading=readJsonSafe(leisureFile,{})||{},anime=readJsonSafe(path.join(STATE_DIR,'anime.json'),{})||{};
    const materials=[...(reading.items||[]),...(reading.notes||[]),...animeCatalogItems(readJsonSafe(path.join(STATE_DIR,'anime-catalog.json'),null)).map(r=>({...r,kind:'anime'})),
      ...['watching','queue','finished'].flatMap(k=>(anime[k]||[]).map(r=>({...r,kind:'anime'}))),
      ...['Python','JavaScript','数据结构','算法','二叉树','哈希表','C++','Git','Linux'].map(title=>({title,kind:'study'}))];
    discussionTopicCache={at:Date.now(),topics:discussionTopics(materials)};
    return discussionTopicCache.topics;
  }
  function observeDiscussionV2(key,st) {
    if(cfg.socialV2?.continuity?.enabled===false||privateDialogueTests.has(key))return;
    const store=personContinuityStoreV2(key);
    setPersonContinuityV2(key,{...store,recaps:captureDiscussionRecaps(store.recaps,{key,messages:privateTestRecent(key,st),topics:discussionTopicsV2()})});
  }
  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.personContinuity = normalizePersonContinuity(raw?.personContinuity);
      socialV2.paused = raw?.paused === true;
      socialV2.mood = {
        value: Math.max(-100, Math.min(100, Number(raw?.mood?.value) || 0)),
        energy: Number.isFinite(Number(raw?.mood?.energy)) ? Math.max(0, Math.min(100, Number(raw.mood.energy))) : 60,
        updatedAt: Number(raw?.mood?.updatedAt) || 0,
        log: Array.isArray(raw?.mood?.log) ? raw.mood.log.slice(-50) : []
      };
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            msgSinceReset: Math.max(0, Math.floor(Number(val.msgSinceReset) || 0)),
            followUpDay: val.followUpDay && typeof val.followUpDay === 'object' ? { key: String(val.followUpDay.key ?? ''), count: Math.max(0, Number(val.followUpDay.count) || 0) } : null,
            proactiveDay: val.proactiveDay && typeof val.proactiveDay === 'object' ? { key: String(val.proactiveDay.key ?? ''), count: Number(val.proactiveDay.count) || 0 } : null,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            continuity: normalizeContinuity(val.continuity),
            experience: normalizeExperience(val.experience),
            historyRecovery: normalizeRecovery(val.historyRecovery),
            expressionQuietTargets: expressionTargets(val.expressionQuietTargets),
            expressionBoundaryEvents: expressionBoundaryEvents(val.expressionBoundaryEvents),
          reviewStatus: val.reviewStatus || null,
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            // Match the persisted representation; otherwise the first startup save drops affinity.
            affinity: val.affinity && typeof val.affinity === 'object' && !Array.isArray(val.affinity)
              ? {
                  points: Math.max(0, Math.min(100, Number(val.affinity.points) || 0)),
                  dayKey: String(val.affinity.dayKey || ''),
                  gainedToday: Math.max(0, Number(val.affinity.gainedToday) || 0),
                  updatedAt: Number(val.affinity.updatedAt) || 0,
                  log: Array.isArray(val.affinity.log) ? val.affinity.log.slice(-50) : [],
                  pendingLevelUp: val.affinity.pendingLevelUp && typeof val.affinity.pendingLevelUp === 'object'
                    ? { from: Number(val.affinity.pendingLevelUp.from) || 1, to: Number(val.affinity.pendingLevelUp.to) || 1,
                        name: String(val.affinity.pendingLevelUp.name || ''), at: Number(val.affinity.pendingLevelUp.at) || 0 }
                    : null
                }
              : undefined,
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        for(const [key,st] of socialV2.conversations)if(isSessionAllowedInCurrentMode(key)){
          for(const msg of st.recentMessages||[])observePersonContractsV2(key,msg);
          observeDiscussionV2(key,st);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State({ strict = false } = {}) {
    try {
      const obj = { paused: socialV2.paused, mood: socialV2.mood, personContinuity: normalizePersonContinuity(socialV2.personContinuity), conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        if (EPHEMERAL_GROUP_KEYS.has(key)) continue;
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          patience: st.patience, patienceAt: st.patienceAt,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          // 本机改动（2026-10-06）：主动开口的每日计数要落盘，否则一重启上限就失效
          msgSinceReset: Math.max(0, Math.floor(Number(st.msgSinceReset) || 0)),
          followUpDay: st.followUpDay && typeof st.followUpDay === 'object' ? st.followUpDay : null,
          proactiveDay: st.proactiveDay && typeof st.proactiveDay === 'object' ? st.proactiveDay : null,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          continuity: normalizeContinuity(st.continuity),
          experience: normalizeExperience(st.experience),
          historyRecovery: normalizeRecovery(st.historyRecovery),
          expressionQuietTargets: expressionTargets(st.expressionQuietTargets),
          expressionBoundaryEvents: expressionBoundaryEvents(st.expressionBoundaryEvents),
          reviewStatus: st.reviewStatus || null,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          affinity: st.affinity && typeof st.affinity === 'object'
            ? {
                points: Math.max(0, Math.min(100, Number(st.affinity.points) || 0)),
                dayKey: String(st.affinity.dayKey || ''),
                gainedToday: Math.max(0, Number(st.affinity.gainedToday) || 0),
                updatedAt: Number(st.affinity.updatedAt) || 0,
                log: Array.isArray(st.affinity.log) ? st.affinity.log.slice(-50) : [],
                pendingLevelUp: st.affinity.pendingLevelUp && typeof st.affinity.pendingLevelUp === 'object'
                  ? {
                      from: Number(st.affinity.pendingLevelUp.from) || 1,
                      to: Number(st.affinity.pendingLevelUp.to) || 1,
                      name: String(st.affinity.pendingLevelUp.name || ''),
                      at: Number(st.affinity.pendingLevelUp.at) || 0
                    }
                  : null
              }
            : undefined,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
      if (strict) throw error;
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    // 本机改动（2026-10-06）：这两处原本硬编码 12000 —— 它们是"对方可能还在打字"的保守值，
    // 但对体感延迟影响很大。改成可配（config.socialV2.wait.unfinishedQuietMs，默认 4000）。
    const guardMs = Math.max(0, Number(cfg.socialV2?.wait?.unfinishedQuietMs ?? 4000));
    if (looksLikeUnfinished(text)) return guardMs;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return guardMs;
    return defaultMs;
  }

  function formatMemoryV2(st, context = {}) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    if (cfg.socialV2?.continuity?.enabled !== false) {
      const continuity = formatContinuity(st.continuity, { messages: st.recentMessages || [], ...context });
      if (continuity) lines.push(continuity);
    }
    const recap = reviewHint(st); if (recap) lines.push(recap);
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}, key = '') {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    if (CONTINUITY_CATEGORIES.includes(cat)) {
      const cleanExtra = { ...extra,
        crossContext:extra.crossContext?{...extra.crossContext,topic:redactKnownTokensOnly(String(extra.crossContext.topic||'')),summary:redactKnownTokensOnly(String(extra.crossContext.summary||''))}:undefined,
        participants: Array.isArray(extra.participants) ? extra.participants.map(p => redactKnownTokensOnly(String(p))) : [],
        keywords: Array.isArray(extra.keywords) ? extra.keywords.map(p => redactKnownTokensOnly(String(p))) : [] };
      const messages = (st.recentMessages || []).map(m => ({ ...m, text: redactKnownTokensOnly(String(m.text || m.plain || '')) }));
      const result = appendContinuity(st.continuity, cat, text, cleanExtra, { messages });
      key=key||[...socialV2.conversations].find(([,v])=>v===st)?.[0]||'';
      const beforeStore=personContinuityStoreV2(key);
      const nextStore=upsertPersonThread(beforeStore,{key,category:cat,entry:result.entry,crossContext:privateDialogueTests.has(key)?undefined:cleanExtra.crossContext,messages,seen:st.modelSeenSeqs});
      const previous=st.continuity;st.continuity = result.journal;
      setPersonContinuityV2(key,nextStore);
      try{saveSocialV2State({strict:true});}catch(error){st.continuity=previous;setPersonContinuityV2(key,beforeStore);throw error;}
      return result.entry;
    }
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  function reviewTick(now = Date.now()) {
    if (socialV2.paused || cfg.socialV2?.review?.enabled === false) return { reviewed: 0, skipped: true };
    const options = cfg.socialV2?.review || {};
    const day = new Date(now).toLocaleDateString('en-CA');
    const hour = Math.max(0, Math.min(23, Number(options.hour ?? 5) || 0));
    let reviewed = 0; const originals = [];
    for (const [key, st] of socialV2.conversations) {
      if (EPHEMERAL_GROUP_KEYS.has(key)) continue;
      const patch = reviewConversation(st, { now, day, hour });
      if (!patch) continue;
      originals.push({ st, pendingThoughts: st.pendingThoughts, activeTopics: st.activeTopics, reviewStatus: st.reviewStatus });
      Object.assign(st, patch); reviewed++;
    }
    if (reviewed) {
      try { saveSocialV2State({ strict: true }); }
      catch (error) { for (const item of originals) Object.assign(item.st, { pendingThoughts: item.pendingThoughts, activeTopics: item.activeTopics, reviewStatus: item.reviewStatus }); throw error; }
      log('[本地复盘] 已整理 ' + reviewed + ' 个会话的待办与过期记录；未调用模型或发送消息');
    }
    return { reviewed, kind: 'local-evidence-recap' };
  }
  function reviewSnapshot() {
    const records = [...socialV2.conversations].filter(([key]) => !EPHEMERAL_GROUP_KEYS.has(key)).map(([,st]) => st.reviewStatus).filter(Boolean);
    return { enabled: cfg.socialV2?.review?.enabled !== false, kind: 'local-evidence-recap',
      reviewedConversations: records.length, lastRunAt: Math.max(0, ...records.map(r => Number(r.at) || 0)) };
  }
  loadSocialV2State();
  restorePendingSelfAction(); // 恢复重启前挂起的对外审批（发说说/改昵称）
  startBusyWatchdog();        // 卡死看门狗：清理陈旧的"繁忙"标志并补发积压唤醒
  startGameGuard();           // 游戏唤醒保险：忘还原 anyMessage 时自动兜住
  void startupWakeRecovery();
  setInterval(() => { try { reviewTick(); } catch (error) { log('[本地复盘] 整理失败:', error?.message ?? error); } }, 10 * 60 * 1000).unref?.();
  setInterval(()=>{void leisureOf().run().then(r=>{if(r.ok)log('[兴趣与日常] 已处理实际取得的片段并保存笔记');}).catch(()=>log('[兴趣与日常] 后台活动暂不可用，聊天照常'));},5*60*1000).unref?.();
  setInterval(()=>{animeAutoAdvanceToday();},60*1000).unref?.();
  setTimeout(()=>{animeAutoAdvanceToday();},5000).unref?.();
  setInterval(() => { void sessionResetTick().catch((error) => log('会话重置检查异常:', error?.message ?? error)); }, 10 * 60 * 1000).unref?.();
  log("[会话重置] 定时器已挂（每 10 分钟检查；配置小时=" + (cfg.socialV2?.sessionReset?.hour ?? 4) + "）");  // 启动救援：恢复落盘的待补发唤醒 + 捞起没人管的未读

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '', addressing = {}) {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      directToAi: addressing.directToAi === true,
      addressedToOther: addressing.addressedToOther === true,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: eventTimeMs(addressing.sentAt) || Date.now(),
      receivedAt: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint(key);
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => {
      if (!opts.wakeReason) return false;
      if (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false) return true;
      if (opts.wakeReason === 'historyRecovery') {
        const st = socialV2.conversations.get(key);
        if (!st) return true;
        pruneHistoryUnreadV2(key,st);
        return !st.unread.some(m=>m.recovered&&!m.historyOnly);
      }
      return false;
    };
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (wakeBlocked()) return skipWake();
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint(key);
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint(k);
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  const roleHintCache = new Map(); // cacheKey -> 人格卡原文（本机改动：支持群/私聊多张卡并存）
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent(key) {
    try {
      const rs = readRoleState(key);
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      const cached = roleHintCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache.set(cacheKey, raw);
      if (roleHintCache.size > 8) roleHintCache.delete(roleHintCache.keys().next().value);
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode, key) {
    const selected = selectRoleText(roleRawContent(key), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint(key) {
    return roleHintForMode('v1', key);
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2(key, scene = 'chat') {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2', key);
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return conversationRole(kept.join('\n'),{scene}).text;
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  // ── 群成员主动私聊 → 自动加入私聊白名单（本机改动 2026-10-06）────────────
  // 场景：开「谁是卧底」要私聊发身份牌，可那些群友不在 allow.private 里 → 发不出去。
  // 规则：**只对 cfg.allow.groups 里的群成员生效**（用网关成员列表校验，走缓存），
  //       开关 config.allow.autoAddPrivateFromGroups（false 可关）。
  async function autoAddPrivateFromGroups(userId, opts = {}) {
    if (cfg.allow?.autoAddPrivateFromGroups === false) return { added: false, reason: '开关已关' };
    const uid = String(userId ?? '').trim();
    if (!/^\d{4,12}$/.test(uid)) return { added: false, reason: '不是合法 QQ 号' };
    const groups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.map(String) : [];
    if (!groups.length) return { added: false, reason: '没有配置任何群' };
    if ((cfg.allow?.private ?? []).map(String).includes(uid)) return { added: false, reason: '已在白名单' };
    for (const gid of groups) {
      let isMember = false;
      try { isMember = (await assertGroupMember(gid, uid)) === null; } catch { isMember = false; }
      if (!isMember) continue;
      if (opts.dryRun) return { added: false, dryRun: true, group: gid, reason: '是群成员（试跑，未写入）' };
      cfg.allow.private = [...new Set([...(cfg.allow.private ?? []).map(Number), Number(uid)])];
      try {
        // 用项目自己的读写助手：只改 allow.private，其余原样保留
        const configFile = path.join(ROOT, 'config.json');
        const file = readConfigObject(configFile);
        file.allow = { ...(file.allow ?? {}), private: cfg.allow.private };
        atomicWriteJson(configFile, file);
        log(`白名单：群 ${gid} 成员 ${uid} 主动私聊，已加入 allow.private（开游戏时能给他发身份牌了）`);
      } catch (error) {
        log(`白名单：${uid} 已临时放行，但写配置失败（重启后会失效）：${error?.message ?? error}`);
      }
      return { added: true, group: gid };
    }
    return { added: false, reason: '不是任何已配置群的成员' };
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], addressing = {}) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      directToAi: addressing.directToAi === true,
      addressedToOther: addressing.addressedToOther === true,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: eventTimeMs(addressing.sentAt) || Date.now(),
      receivedAt: Date.now()
    };
    observeExpressionPreference(st, msg);
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    observePersonContractsV2(key,msg);
    observeDiscussionV2(key,st);
    rememberMessage(st, messageId);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // Offline recovery uses read-only OneBot history, never command/event replay.
  const historyRecoveryFlights = new Map();
  const historyRecoveryQueue = new Set();
  let historyRecoveryRunning = false;
  function historyRecoveryAllowedV2(key) {
    return currentMode === 'reserved2' && cfg.socialV2?.enabled !== false && cfg.socialV2?.recovery?.enabled !== false
      && !socialV2.paused && !shouldBlockSilentReply(key) && !EPHEMERAL_GROUP_KEYS.has(key)
      && !sessionResettingKeys.has(key) && socialV2.conversations.has(key) && isSessionAllowedInCurrentMode(key);
  }
  function pruneHistoryUnreadV2(key,st) {
    const now=Date.now(),newer=Math.max(0,...st.recentMessages.filter(m=>!m.isSelf&&!m.recovered).map(m=>Number(m.time)||0));
    const stale=st.unread.filter(m=>m.recovered&&(m.historyOnly||now-m.time>recoveryReplyWindow(key)||m.time<=st.lastAiReplyAt||newer>m.time));
    if(!stale.length)return;
    const ids=new Set(stale.map(m=>m.messageId)),previous={unread:st.unread,recentMessages:st.recentMessages,lastReadThroughSeq:st.lastReadThroughSeq};
    st.unread=st.unread.filter(m=>!m.recovered||!ids.has(m.messageId));
    st.recentMessages=st.recentMessages.map(m=>m.recovered&&ids.has(m.messageId)?{...m,historyOnly:true}:m);
    if(!st.unread.length)st.lastReadThroughSeq=st.lastUnreadSeq;
    try{saveSocialV2State({strict:true});}catch(error){Object.assign(st,previous);throw error;}
  }
  function importHistoryV2(key, events, selfId, {dryRun=false,limited=false,checked=false}={}) {
    if (!historyRecoveryAllowedV2(key)) throw Error('Recovery authorization changed');
    const st = getSocialV2State(key), now = Date.now();
    const plan = planHistory(st,events,{key,selfId,now});
    const result = {imported:plan.messages.length,historyOnly:plan.messages.filter(m=>!m.pending).length,pending:plan.messages.filter(m=>m.pending).length,limited,dryRun};
    if (dryRun) return result;
    const previous = {recentMessages:st.recentMessages,unread:st.unread,historyRecovery:st.historyRecovery,
      lastUnreadSeq:st.lastUnreadSeq,lastReadThroughSeq:st.lastReadThroughSeq,lastIncomingAt:st.lastIncomingAt};
    try {
      const rows = plan.messages.map(m=>({seq:++st.lastUnreadSeq,messageId:m.id,
        sender:key.startsWith('private:')?'私聊':String(m.event.sender?.card||m.event.sender?.nickname||'群成员'),
        userId:String(m.event.user_id),text:truncateText(m.text,200),plain:truncateText(m.text,200),tail:truncateTextTail(m.text,200),
        quoteTargetIsSelf:false,isOwner:String(m.event.user_id)===String(cfg.ownerQQ),isSelf:false,
        directToAi:m.direct,addressedToOther:false,media:[],hasMedia:false,forwardIds:[],hasForward:false,
        time:m.at,receivedAt:now,recovered:true,historyOnly:!m.pending}));
      const recentLimit = Math.max(1,Number(cfg.socialV2?.context?.recentLimit)||100), unreadLimit = Math.max(1,Number(cfg.socialV2?.context?.unreadLimit)||30);
      st.recentMessages = [...st.recentMessages,...rows].sort((a,b)=>a.time-b.time).slice(-recentLimit);
      st.unread = [...st.unread,...rows.filter(m=>!m.historyOnly)].slice(-unreadLimit);
      if (!st.unread.length) st.lastReadThroughSeq = st.lastUnreadSeq;
      st.lastIncomingAt = Math.max(st.lastIncomingAt||0,...rows.map(m=>m.time));
      const r = normalizeRecovery(st.historyRecovery);
      st.historyRecovery = {...r,selfId:plan.selfId,floorAt:checked&&!limited?Math.max(plan.floor,now-RECOVERY_OVERLAP_MS):plan.floor,
        lastCheckedAt:checked?now:r.lastCheckedAt,lastImportedAt:rows.length?now:r.lastImportedAt,
        imported:r.imported+rows.length,historyOnly:r.historyOnly+result.historyOnly,limited,error:null,
        replyUntilAt:plan.replyUntilAt||r.replyUntilAt,
        seenIds:[...new Set([...r.seenIds,...rows.map(m=>m.messageId)])].slice(-256)};
      saveSocialV2State({strict:true});
    } catch(error) { Object.assign(st,previous); throw error; }
    if(result.imported) {
      appendActivity(`${key} [补收] 历史 ${result.imported} 条，仅作上下文 ${result.historyOnly} 条，近期候选 ${result.pending} 条`);
      if(result.pending) scheduleWakeV2(key,'historyRecovery');
    }
    return result;
  }
  async function recoverConversationV2(key,{dryRun=false}={}) {
    if(historyRecoveryFlights.has(key))return {busy:true,dryRun};
    if(!historyRecoveryAllowedV2(key))throw Error('Recovery not authorized');
    const st=getSocialV2State(key),token=st.agentToken,sid=state.sessions[key],url=bot.url;
    const receipt={};historyRecoveryFlights.set(key,receipt);
    const stillAllowed=()=>historyRecoveryAllowedV2(key)&&socialV2.conversations.get(key)===st&&st.agentToken===token&&state.sessions[key]===sid&&bot.url===url;
    try {
      const signal=AbortSignal.timeout(12000), options={signal,timeoutMs:4000};
      const login=await bot.request('get_login_info',{},options);
      if(login.status!=='ok'||(login.retcode!=null&&login.retcode!==0)||!login.data?.user_id)throw Error('history-unavailable');
      const selfId=String(login.data.user_id),kind=key.split(':')[0],id=Number(key.split(':')[1]);
      const events=[];let anchor=0,limited=false;
      for(let page=0;page<3;page++) {
        if(!stillAllowed())throw Error('Recovery authorization changed');
        const reply=await bot.request(kind==='private'?'get_friend_msg_history':'get_group_msg_history',
          {[kind==='private'?'user_id':'group_id']:id,message_id:anchor,count:50,reverse_order:true},options);
        if(reply.status!=='ok'||(reply.retcode!=null&&reply.retcode!==0)||!Array.isArray(reply.data?.messages))throw Error('history-unavailable');
        const batch=reply.data.messages;
        if(batch.some(m=>m.message_type!==kind||eventTimeMs(m.time)==null||m.message_id==null
          ||(kind==='group'?String(m.group_id)!==String(id):![String(id),selfId].includes(String(m.user_id)))))throw Error('history-unavailable');
        events.push(...batch);
        const older=batch.map(m=>({id:m.message_id,at:eventTimeMs(m.time)})).filter(m=>m.at!=null).sort((a,b)=>a.at-b.at)[0];
        limited=batch.length>=50&&!!older&&older.at>historyFloor(st);
        if(!limited||String(older.id)===String(anchor))break;
        anchor=older.id;
      }
      if(!stillAllowed())throw Error('Recovery authorization changed');
      return importHistoryV2(key,events,selfId,{dryRun,limited,checked:true});
    } catch(error) {
      if(!dryRun&&stillAllowed()) {
        const old=st.historyRecovery;st.historyRecovery={...normalizeRecovery(old),error:error.message==='identity-mismatch'?'identity-mismatch':'history-unavailable'};
        try{saveSocialV2State({strict:true});}catch{st.historyRecovery=old;}
      }
      throw error;
    } finally { if(historyRecoveryFlights.get(key)===receipt)historyRecoveryFlights.delete(key); }
  }
  function queueHistoryRecoveryV2(reason='periodic') {
    for(const [key,st] of socialV2.conversations) {
      if(historyRecoveryAllowedV2(key)&&(reason!=='periodic'||Date.now()-normalizeRecovery(st.historyRecovery).lastCheckedAt>=RECOVERY_INTERVAL_MS))historyRecoveryQueue.add(key);
    }
    if(historyRecoveryRunning)return;
    historyRecoveryRunning=true;
    void (async()=>{
      try {
        for(const key of historyRecoveryQueue) {
          historyRecoveryQueue.delete(key);if(!historyRecoveryAllowedV2(key))continue;
          try{await recoverConversationV2(key);}catch{log(`[补收] ${key} 查询失败，保留历史，稍后重试`);}
        }
      } finally {historyRecoveryRunning=false;}
    })();
  }
  setInterval(()=>queueHistoryRecoveryV2('periodic'),RECOVERY_INTERVAL_MS).unref?.();

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    observeDiscussionV2(key,st);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if(tr.nameMention&&personSelfAliasMentionV2(key,event?.user_id,plainContent))return 'nameMention';
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0) {
      // 本机改动（2026-10-06）：普通消息概率再乘「作息 × 耐心」—— 深夜/午休/没耐心时更不容易醒
      // 本机改动（2026-10-07）：再按"发消息这个人的关系"微调（熟人更容易被理，生人更容易被晾）
      const stRel = getSocialV2State(key);
      const peerRel = peerOfConversation(key, stRel);
      const relInfo = relationOf(peerRel.qq, peerRel.name);
      const relPerson = peerRel.qq ? personOf(peerRel.qq, peerRel.name, false) : null;
      const affFactor = affinityFactorOf(relPerson);
      const rhythmK = Math.min(1.5, activityWakeFactor(stRel, { key }) * relInfo.factor * affFactor * dailyStateWakeFactor());
      // 本机改动（2026-10-07）：加"是不是在跟我说"的判定
      let baseProb = Number(tr.probability);
      let addrNote = '';
      try {
        const addr = addresseeScore(stRel, key, event);
        if (addr.score < 0) { baseProb = Math.min(baseProb, 0.02); addrNote = '判定:不接（' + addr.reasons.join('；') + '）'; }
        else if (addr.score > baseProb) { baseProb = addr.score; addrNote = '判定:接（' + addr.reasons.join('；') + '）'; }
        else addrNote = '判定:' + addr.score.toFixed(2) + '（' + (addr.reasons.join('；') || '无线索') + '）';
      } catch (e) { addrNote = '判定出错:' + (e?.message ?? e); }
      const effProb = Math.max(0, Math.min(1, baseProb * rhythmK));
      // 本机改动：可选的抽签日志（config.socialV2.wake.logProbabilityRolls）——
      // 只有把"抽签"本身记下来，才能核实"配置的概率是否真的生效"（只看唤醒日志会被
      // 排队/被更高优先级覆盖而低估）。
      const hit = Math.random() < effProb;
      if (!cfg.socialV2?.wake?.logProbabilityRolls) log('[称呼判定] ' + key + ' ' + addrNote + ' → p=' + effProb.toFixed(3) + ' ' + (hit ? '命中' : '未命中'));
      if (cfg.socialV2?.wake?.logProbabilityRolls) {
        log(`[频率] ${key} ${addrNote} 概率=${baseProb.toFixed(2)}×作息/活跃${rhythmK.toFixed(2)}（关系:${relInfo.label}×${relInfo.factor} 好感×${affFactor.toFixed(2)}）=${effProb.toFixed(4)} → ${hit ? '命中' : '未命中'}`);
      }
      if (hit) return 'probability';
    }
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = privateTestRecent(key, st).filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  function currentConversationV2(key,st,messages) {
    // Only messages already offered to this model may shape a refresh. In
    // particular, paged reads must not leak unoffered messages or acknowledge them.
    const seen=new Set([...st.modelSeenSeqs||[],...messages.map(m=>m.seq)]);
    const recent=privateTestRecent(key,st).filter(m=>m.isSelf||seen.has(m.seq)||(v2ToolEnabled('getRecent')&&m.seq<=st.lastReadThroughSeq));
    const current=expressionStateV2(key,{...st,recentMessages:recent,unread:st.unread.filter(m=>seen.has(m.seq))});
    const turn=conversationTurnHint(current,messages);
    const move=conversationMove(current,{key:groupRehearsals.get(key)?.privateScene?'private:fixture':key,stickers:stickerEnabled()});
    return {...turn,participation:move.participation||null,hint:turn.hint+'\n'+move.text+'\n'+personRecallHintV2(key,current)+'\n'+personThreadsHintV2(key,current)+'\n'+leisureHintFor(key,String(replyFocus(current)?.plain||replyFocus(current)?.text||''),{invite:move.participation==='invite',recentMessages:current.recentMessages,target:replyFocus(current)?.userId,now:Date.now()}),
      expressionHint:v2ToolEnabled('sendMessage')&&(!EPHEMERAL_GROUP_KEYS.has(key)||groupRehearsals.get(key)?.styleFixtures)?chatExpressionHint(current,{catalog:faceCatalogV2(),stickers:stickerEnabled()}):''};
  }

  function livedContextV2(key, st, reason = '') {
    const recent=privateTestRecent(key,st), focus=replyFocus({...st,recentMessages:recent}) || {}, target=String(key).startsWith('private:')?String(key).split(':')[1]:String(focus.userId||'');
    const text=String(focus.plain||focus.text||'');
    const shared=EPHEMERAL_GROUP_KEYS.has(key)?[]:[...socialV2.conversations].filter(([k])=>!EPHEMERAL_GROUP_KEYS.has(k)).map(([,s])=>s.experience);
    const own=normalizeExperience(st.experience), common=publicExperiences(shared),background=leisureJournalFor(key);
    const merged={sources:[...own.sources,...background.sources],records:[...new Map([...background.records,...common.records,...own.records].sort((a,b)=>a.updatedAt-b.updatedAt).map(r=>[r.id,r])).values()]};
    const selected=selectExperiences(merged,{text,target,limit:4});
    const interested=selected.some(r=>r.kind==='interest' && (text.includes(r.topic)||r.topic.includes(text)) && text);
    const energy=cfg.socialV2?.mood?.enabled===true?Math.min(patienceNow(st),moodSettle().energy):patienceNow(st);
    const now=new Date(),activity=activityContext({now,enabled:rhythmCfg().enabled!==false,factor:rhythmHourFactor(now),sleeping:rhythmIsSleeping(now)});
    const rehearsal=groupRehearsals.get(key);
    const move=conversationMove(expressionStateV2(key,{...st,recentMessages:recent}),{key,stickers:stickerEnabled()&&(!EPHEMERAL_GROUP_KEYS.has(key)||rehearsal?.styleFixtures===true)});
    const scoreHint=rehearsal?.affinity!==undefined?'【模拟关系指标】本批模拟角色的好感度都为 '+rehearsal.affinity+'/100；具体相处方式仍看各人的经历与边界。\n':'';
    return recoveryHint(st)+personContractsHintV2(key,st)+'\n'+personThreadsHintV2(key,st,reason)+'\n'+personRecallHintV2(key,st,reason)+'\n'+EXPERIENCE_POLICY+'\n'+SELF_HISTORY_HINT+'\n'+OPINION_RETENTION_HINT+'\n'+scoreHint+activity+'\n'+communicationHint({energy,interested})+'\n'+experienceContext(merged,{text,target,limit:4})+'\n'
      +leisureHintFor(key,text,{invite:move.participation==='invite',recentMessages:recent,target:focus.userId,now:Date.now()})+'\n'+CONVERSATION_BASE+'\n'+move.text+'\n'
      +((!EPHEMERAL_GROUP_KEYS.has(key)||groupRehearsals.get(key)?.styleFixtures===true)&&v2ToolEnabled('sendMessage')?chatExpressionHint(expressionStateV2(key,{...st,recentMessages:recent}),{catalog:faceCatalogV2(),stickers:stickerEnabled()}):'')+'\n';
  }
  const livedAcquisition = new Map();

  function personContinuityStoreV2(key) {
    if(EPHEMERAL_GROUP_KEYS.has(key)){const test=groupRehearsals.get(key);if(!test)return normalizePersonContinuity();return test.personContinuity ||= normalizePersonContinuity();}
    return socialV2.personContinuity;
  }
  function setPersonContinuityV2(key,value) {
    if(EPHEMERAL_GROUP_KEYS.has(key)){const test=groupRehearsals.get(key);if(test)test.personContinuity=value;}
    else socialV2.personContinuity=value;
  }
  function personContinuityOptionsV2(key,st) {
    const recent=privateTestRecent(key,st),focus=replyFocus({...st,recentMessages:recent});
    const target=key.startsWith('private:')?key.split(':')[1]:String(focus?.userId||'');
    return {key,target,allowed:source=>source===key||!EPHEMERAL_GROUP_KEYS.has(key)&&!EPHEMERAL_GROUP_KEYS.has(source)&&isSessionAllowedInCurrentMode(source)};
  }
  function observePersonContractsV2(key,msg) {
    if(msg.addressedToOther||cfg.socialV2?.continuity?.enabled===false)return;
    const entries=capturePersonContracts(key,msg);if(!entries.length)return;
    let store=personContinuityStoreV2(key);for(const r of entries)store=upsertPersonContract(store,{...r,value:redactKnownTokensOnly(r.value)});
    setPersonContinuityV2(key,store);
  }
  function personContractsHintV2(key,st){
    if(cfg.socialV2?.continuity?.enabled===false)return '';
    return personContractHint(personContinuityStoreV2(key),personContinuityOptionsV2(key,st));
  }
  function personRecallOptionsV2(key,st,reason='') {
    const threads=personContinuityStoreV2(key).threads.filter(row=>{
      const origin=socialV2.conversations.get(row.sourceKey);
      return !!origin&&normalizeContinuity(origin.continuity)[row.category==='sharedEvent'?'sharedEvents':'commitments'].some(entry=>entry.id===row.id);
    });
    return {...personContinuityOptionsV2(key,st),messages:privateTestRecent(key,st),reason,threads,originExists:source=>socialV2.conversations.has(source)||EPHEMERAL_GROUP_KEYS.has(key)};
  }
  function personRecallStateV2(key,st,reason='') {
    if(cfg.socialV2?.continuity?.enabled===false||privateDialogueTests.has(key))return {requested:false,rows:[],status:'idle'};
    return discussionRecall(personContinuityStoreV2(key).recaps,personRecallOptionsV2(key,st,reason));
  }
  function personRecallHintV2(key,st,reason='') {
    if(cfg.socialV2?.continuity?.enabled===false||privateDialogueTests.has(key))return '';
    return discussionRecallHint(personContinuityStoreV2(key).recaps,personRecallOptionsV2(key,st,reason));
  }
  function hasPersonAliasV2(key,target){
    const options={...personContinuityOptionsV2(key,getSocialV2State(key)),target:String(target)};
    return personContractView(personContinuityStoreV2(key),options).some(r=>r.kind==='peerAlias');
  }
  function personSelfAliasMentionV2(key,target,value){
    const options={...personContinuityOptionsV2(key,getSocialV2State(key)),target:String(target)};
    return personContractView(personContinuityStoreV2(key),options).some(r=>r.kind==='selfAlias'&&r.state==='active'&&r.value.length>=2&&String(value).includes(r.value));
  }

  function personThreadsOptionsV2(key,st,reason=''){
    return {...personContinuityOptionsV2(key,st),messages:privateTestRecent(key,st),reason,
      originExists:row=>{const origin=socialV2.conversations.get(row.sourceKey);return !!origin&&normalizeContinuity(origin.continuity)[row.category==='sharedEvent'?'sharedEvents':'commitments'].some(e=>e.id===row.id);}};
  }
  function personThreadsProjectionV2(key,st,reason=''){
    if(cfg.socialV2?.continuity?.enabled===false||privateDialogueTests.has(key))return {rows:[],ambiguous:false};
    return personThreadProjection(personContinuityStoreV2(key),personThreadsOptionsV2(key,st,reason));
  }
  function personThreadsHintV2(key,st,reason=''){
    if(cfg.socialV2?.continuity?.enabled===false||privateDialogueTests.has(key))return '';
    const options=personThreadsOptionsV2(key,st,reason),hint=personThreadHint(personContinuityStoreV2(key),options);
    const last=[...options.messages].reverse().find(m=>!m.isSelf&&String(m.userId)===options.target),text=String(last?.plain||last?.text||'');
    const saveHint=v2ToolEnabled('memory')&&/下次|接着|继续|我觉得|认为|说好|答应|约定|完成|改成|不聊|取消/.test(text)?'\n【有实际进展才留接续摘要】沿用 sharedEvent/commitment 和本人已读 sourceSeqs；extra.crossContext={target:"'+options.target+'",topic:原话的确切主题,summary:已聊进度和仍待解决的一点,scope:"person"}。私密或仅私聊用 private，明确公开许可才用 public；无新进展不存，有旧 id 就更新。':'';
    return hint+saveHint;
  }
  function updatePersonContinuityV2(key,st,category,id,patch){
    if(patch.crossContext)patch={...patch,crossContext:{...patch.crossContext,topic:redactKnownTokensOnly(String(patch.crossContext.topic||'')),summary:redactKnownTokensOnly(String(patch.crossContext.summary||''))}};
    const field=category==='sharedEvent'?'sharedEvents':'commitments',beforeStore=personContinuityStoreV2(key);
    const row=beforeStore.threads.find(r=>r.id===id),isLocal=normalizeContinuity(st.continuity)[field].some(e=>e.id===id);
    if(!isLocal&&(!row||row.category!==category||!personThreadsProjectionV2(key,st).rows.some(r=>r.id===id)))throw Error('找不到当前允许接续的记忆');
    const origin=isLocal?st:socialV2.conversations.get(row.sourceKey),previous=origin.continuity;
    const messages=privateTestRecent(key,st).map(m=>({...m,sourceKey:key,text:redactKnownTokensOnly(String(m.text||m.plain||''))}));
    if(row||patch.crossContext){
      if(!Array.isArray(patch.sourceSeqs)||!patch.sourceSeqs.length||patch.sourceSeqs.some(seq=>!st.modelSeenSeqs.has(seq)))throw Error('跨场景进展需要本轮本人已读 sourceSeqs');
      // Ensure every changed record carries current-scene provenance even for status-only updates.
      patch={...patch,text:patch.text??patch.crossContext?.summary??normalizeContinuity(previous)[field].find(e=>e.id===id)?.text};
    }
    const result=updateContinuity(previous,category,id,patch,{messages});
    let nextStore=upsertPersonThread(beforeStore,{key,category,entry:result.entry,crossContext:privateDialogueTests.has(key)?undefined:patch.crossContext,messages,seen:st.modelSeenSeqs});
    origin.continuity=result.journal;setPersonContinuityV2(key,nextStore);
    try{saveSocialV2State({strict:true});}catch(error){origin.continuity=previous;setPersonContinuityV2(key,beforeStore);throw error;}
    return isLocal?result.entry:personThreadProjection(nextStore,personThreadsOptionsV2(key,st)).rows.find(r=>r.id===id)||{id,category,status:result.entry.status};
  }

  function personAffinityViewV2(key, st) {
    if(affinityCfg().enabled===false)return null;
    const peer=peerOfConversation(key,{...st,recentMessages:privateTestRecent(key,st)}),p=peer.qq?personOf(peer.qq,peer.name,false):null;
    if(!p)return null;
    return {kind:'person',target:peer.qq,points:Math.round(affinityNow(p)),label:affinityLabel(affinityNow(p)),relation:relationOf(peer.qq,peer.name).label,meaning:'粗略指标；具体相处方式看经历、偏好与边界'};
  }

  function buildWakePromptV2(key, reason) {
    if (groupRehearsals.has(key)) return rehearsalPrompt(key, reason);
    const roleState = readRoleState(key);
    const backbone = currentRoleHintV2(key).match(/^## 性格主轴[^\n]*\n([\s\S]*?)(?=^## |$)/m)?.[1]?.trim().slice(0, 1800) || '';
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n${backbone ? `【稳定性格】${backbone}\n` : ''}\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st, { reason, messages: privateTestRecent(key, st) });
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 本机改动（2026-10-06）：作息 + 耐心 → 变成她的"状态"，语气跟着变（这是"潜移默化"的一半）
    const rhythmLine = (() => {
      try {
        const originalStR = getSocialV2State(key);
        const stR = { ...originalStR, recentMessages: privateTestRecent(key, originalStR) };
        // 本机改动（2026-10-07）：被活跃度"吵醒"时不要再附带"你已经睡了"那句（重复且矛盾）
        const peerR = peerOfConversation(key, stR);
        const relWho = (peerR.qq ? personOf(peerR.qq, peerR.name, false)?.name : null) || peerR.name || peerR.qq;
        const relTierNow = relationOf(peerR.qq, peerR.name);
        const nickNow = memeNicknameFor(peerR.qq, relWho,{key});
        const relText = negativeToneText(relTierNow.tier, relWho)
          || (relTierNow.tier !== 'normal' ? '【关系】' + relWho + '：' + relTierNow.label : '');
        const affText = affinityMoodText(peerR.qq, peerR.name);
        const actText = activityMoodText(stR, { key });
        const rhythmText = (actText && rhythmIsSleeping()) ? '' : rhythmMoodText();
        // Random simulated episode increments are not content acquisition.
        const memesText = memesMoodText(stR,key);
        const qzText = qzoneMaterialText();
        const cardText = cardHintText(stR ?? stP ?? getSocialV2State(key));
        const askingActivity=dailyActivityContextNeeded(String(replyFocus(stR)?.plain||replyFocus(stR)?.text||''));
        const bits = [actText, rhythmText, talkativeMoodText(), askingActivity?'':dailyStateMoodText(), relText, affText, askingActivity?'':animeMoodText(), memesText, qzText, cardText, ticsText(stR,key)].filter(Boolean);
  // 本机改动 2026-10-08（自迭代第1轮）：**多人名机械提示**
  //   起因：她一条消息里对着两个人说话+夹两件事 → 对方回了个"？"（分不清在跟谁说）
  //   为什么不用卡片：卡片是静态前缀、100+条规则里容易被淹没 ⚠️（今天验证过很多次）
  //   挂在这里是因为：有 st ✅ 读得到 recentMessages ✅ 而且**每次唤醒都会跑** ✅
  try {
    const __recent = privateTestRecent(key, st);
    let __lastIn = null;
    for (let __i = __recent.length - 1; __i >= 0; __i -= 1) { const __m = __recent[__i]; if (__m && !__m.isSelf && (__m.text || __m.plain)) { __lastIn = __m; break; } }
    if (__lastIn) {
      const __txt = String(__lastIn.text || __lastIn.plain || "");
      const __ppl = Object.values(loadPersons().people ?? {}).filter((x) => x && x.testData !== true);
      // 连**外号**一起匹配（很多人平时叫的是外号，比如"鱼鱼"而不是全名"叱咤月海鱼鱼猫"）
    let __memes = null;
    try { __memes = loadMemes(); } catch {}
    const __hits = new Map();   // qq -> 显示用的名字（**按人去重**：一个人无论全名还是外号都只算一次 ✅）
    for (const __p of __ppl) {
      const __qq = String(__p.qq ?? "");
      const __nick = ((__memes?.byTarget?.[__qq] ?? []).find((x) => x.kind === "nickname")?.text) ?? "";
      const __cands = [String(__p.name ?? ""), String(__nick)].filter((n) => n.length >= 2 && __txt.includes(n));
      if (__cands.length) __hits.set(__qq, __cands[0]);
    }
    const __hit = [...__hits.values()];
      if (__hit.length >= 2) {
        bits.push("【注意·刚才那条提到了 " + __hit.length + " 个人（" + __hit.slice(0, 3).join("、") + "）】要回的话**一条消息只对一个人说** ✅ 要接两个人的话就分两条（或用 qq_reply 引用）✅ 别把两件事塞进一句 ✅");
      }
    }
  } catch {}
        return bits.length ? `【你现在的状态】${bits.join(' ')}\n\n` : '';
      } catch { return ''; }
    })();
    // 本机改动（2026-10-06）：把"按人的跨会话记忆"注入提示词 ——
    //   私聊：注入对方的人物档案（含私聊来源，允许她心里有数）
    //   群聊：注入"最后说话那个人"的公开档案（私聊来源不注入，避免当众说漏）
    const personLine = (() => {
      try {
        const recentMsgs = privateTestRecent(key, st);
        const lastOther = replyFocus({...st,recentMessages:recentMsgs});
        const isPrivate = key.startsWith('private:');
        const peerQq = isPrivate ? key.split(':')[1] : (lastOther?.userId ?? null);
        const peerName = isPrivate ? null : (lastOther?.card || lastOther?.sender || null);
        const block = peerQq || peerName ? personBlock(peerQq, peerName, { allowPrivate: isPrivate }) : '';
        if (!block) return '';
        const hint = isPrivate
          ? '（这是你跨会话记住的他，私聊和群里共用同一份印象）'
          : '（群里记住的印象；带"私聊里知道的"那部分是私下的，别当众说出来）';
        return block + hint + '\n\n';
      } catch { return ''; }
    })();

    // Legacy conversation affinity is retained on disk, but no longer instructs the model.
    const affinityLine = livedContextV2(key, st, reason);
    const moodLine = ''; // Mood is scoped to concrete experiences; legacy disabled mood stays disabled.
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【自然交流】说话具体，少用保证、绝对等空泛评价。可以有自己的偏好、拒绝不合适的请求；直接求助和已答应的事认真处理。不了解就说明，不用装傻或答非所问体现性格。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8,stickerSelectionV2(key,st))}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【参与分寸】先判断消息在对谁说、话题是否公开。直接找你时及时回应；公开话题有相关内容可接一句，别人一问一答或私事不抢话。没有新的意思、对方已结束或拒绝时可以安静，不按轮次强制冒泡。\n\n';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...privateTestRecent(key, st)].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 拼装顺序按「稳定性」排（本机改动 2026-10-06，为缓存命中率）：
    //   ① 稳定块（角色卡/令牌/反AI味/积极性/表情包/记忆）放最前 —— 跨轮次逐字一致，长期命中缓存；
    //   ② 易变块（好感度/心情/首回复节奏/参与度/此刻状态/当前唤醒）放后面 —— 它们每轮都可能变，
    //      放在前面会让"后面所有块"一起缓存失效（旧顺序里好感度排第 3，正好踩这个坑）；
    //   ③ 硬流程规则（沉睡前强制等待）仍然收尾，保持原有的收束作用。
    const base = roleLine + tokenLine + personLine + rhythmLine + antiAiLine + proactiveLine + stickerLine + memoryLine + affinityLine + moodLine + replyLine + participationLine + statusLine + wakeLine + preSleepLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'historyRecovery') {
      return `${base}【断线恢复接话】${key}\n下面是断线后补到的历史消息，不是对方刚说的话。原时间保留，先看间隔、后续发言与是否结束；只接仍近期、直接找你且未回应的一段，可以自然承认刚才没接上。不要逐条补答、补过时问候或重开已结束话题，也不要编造离线期间活动。允许安静收尾，补收不等于必须发言。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}${PROACTIVE_CONVERSATION}\n${leisureHintFor(key,'',{share:true,recentMessages:privateTestRecent(key,st),now:Date.now()})}\n没有内容时 qq_mark_read 或 qq_set_wake_config 收尾。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，先确认话题公开且你有相关内容；别人之间的一问一答不插进去，没有内容可以安静收尾。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState(key);
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    if (sessionResettingKeys.has(key)) return;
    const st = getSocialV2State(key);
    pruneHistoryUnreadV2(key,st);
    if (reason === 'historyRecovery') {
      // A queued recovery may age out while another turn is running.
      const valid = st.unread.filter(m => m.recovered && !m.historyOnly && Date.now()-m.time <= recoveryReplyWindow(key) && m.time > st.lastAiReplyAt);
      if (!valid.length) {
        st.unread = st.unread.filter(m => !m.recovered);
        st.recentMessages = st.recentMessages.map(m => m.recovered ? {...m,historyOnly:true} : m);
        saveSocialV2State(); return;
      }
      st.historyRecovery = {...normalizeRecovery(st.historyRecovery),wakeAt:Date.now(),replyUntilAt:Math.max(...valid.map(m=>m.time))+recoveryReplyWindow(key)};
    }
    const seq = st.lastUnreadSeq || 0;
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      // 本机改动（2026-10-06）：暂存唤醒**按优先级合并**。
      // 一次唤醒本来就会把未读全部读一遍，所以队列里堆一堆重复唤醒没有意义 ——
      // 群里刷屏时旧写法会积压很多条（每条要等一个回合结束才补发一条），看起来就是"卡住"。
      // 现在只保留"优先级不低于新来的"那些 + 新来的这条，上限 5。
      {
        const pr = WAKE_PRIORITY[reason] ?? 10;
        const kept = st.pendingWakeReasons.filter((r) => r && (WAKE_PRIORITY[r.reason] ?? 10) > pr);
        if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) kept.push({ reason, seq });
        else kept.push({ reason, seq });
        st.pendingWakeReasons = kept.slice(0, 5);
        persistPendingWakes();
      }
      if (false) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      // 本机改动（2026-10-06）：@ / 提问 / 私聊**不能丢**。
      // 旧逻辑一律"跳过"，于是群里刷屏撞上限时，@ 她也毫无反应（实测反馈："群聊的@没回复"）。
      // 现在：高优先级原因改为"排队 + 稍后重试"，低优先级的才跳过（省钱）。
      const MUST_KEEP = new Set(['atMention', 'nameMention', 'question', 'private', 'speaker', 'historyRecovery']);
      const isHighPriority = MUST_KEEP.has(reason) || String(reason).startsWith('speaker:') || String(reason).startsWith('keyword:');
      if (isHighPriority) {
        if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
        if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
          st.pendingWakeReasons.push({ reason, seq });
          persistPendingWakes();
        }
        log(`[reserved2] 唤醒频率超限：${key}（${reason}）是高优先级 → 改为排队重试（不丢）`);
        setTimeout(() => {
          try {
            const st2 = getSocialV2State(key);
            const idx = (st2.pendingWakeReasons ?? []).findIndex((r) => r && r.reason === reason && r.seq === seq);
            if (idx >= 0) {
              st2.pendingWakeReasons.splice(idx, 1);
              persistPendingWakes();
              log(`[reserved2] 频率超限重试：${key}（${reason}）`);
              scheduleWakeV2(key, reason);
            }
          } catch (error) { log('频率超限重试失败:', error?.message ?? error); }
        }, 20000 + Math.floor(Math.random() * 15000)).unref?.();
      } else {
        log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      }
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return;
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    // 本机改动（2026-10-06）：困的时候回复更慢
    delay = Math.round(delay * rhythmDelayMultiplier());
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  // ── 卡死看门狗（本机改动 2026-10-06）────────────────────────────────────
  // 症状：唤醒投递失败时，忙标志（pendingWakeKeys / promptQueues.running / v2TurnStartAt）
  //   可能没被清掉 → 该会话**永远**被判"繁忙" → 新消息一路暂存，而"补发"只在回合结束时才做
  //   → 没有任何回合会结束 → 表现就是"她永远不回你"（实测：20:41 的消息 + 手动唤醒都被吞）。
  // 做法：每 45 秒扫一遍；有暂存唤醒、且最近活动已过去很久、且**没有真正在跑的回合**（用
  //   v2TurnStartAt 的时间戳判断，超过阈值即视为陈旧）→ 清掉陈旧标志并立刻补发一条。
  //   如果确实有回合在跑（时间戳很新），就不动它 —— 那可能是合法的长等待（wait 工具最长 10 分钟）。
  function busyFlagReport(key, st) {
    const out = [];
    if (st && st.pendingWakeTimer) out.push('pendingWakeTimer');
    if (pendingWakeKeys.has(key)) out.push('pendingWakeKeys');
    const q = promptQueues.get(key);
    if (q && q.running) out.push('queue.running');
    if (q && Array.isArray(q.queue) && q.queue.length) out.push('queue.len=' + q.queue.length);
    const sid = state.sessions[key];
    if (sid) {
      if (v2TurnStartAt.has(sid)) out.push('turnStartAt=' + Math.round((Date.now() - Number(v2TurnStartAt.get(sid) || 0)) / 1000) + 's前');
      if (collectors.has(sid)) out.push('collectors');
    }
    return out;
  }
  function clearStaleBusyFlags(key, st) {
    if (st && st.pendingWakeTimer) { try { clearTimeout(st.pendingWakeTimer); } catch {} st.pendingWakeTimer = null; }
    pendingWakeKeys.delete(key);
    const q = promptQueues.get(key);
    if (q && q.running) q.running = false;
  }
  async function busyWatchdogTick() {
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const stuckMs = Math.max(60000, Number(cfg.socialV2?.busyStuckMs ?? 300000));
    const now = Date.now();
    for (const key of socialV2.conversations.keys()) {
      let st;
      try { st = getSocialV2State(key); } catch { continue; }
      const queued = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons : [];
      if (!queued.length) continue;
      const lastAct = Math.max(Number(st.lastAiReplyAt ?? 0), Number(st.lastIncomingAt ?? 0));
      if (!lastAct || now - lastAct < stuckMs) continue;

      const sid = state.sessions[key];
      const turnAge = sid && v2TurnStartAt.has(sid) ? now - Number(v2TurnStartAt.get(sid) || 0) : Infinity;
      const flags = busyFlagReport(key, st);
      if (!flags.length || turnAge >= stuckMs) {
        // 要么不忙了，要么那些标志已经陈旧 → 清掉并补发
        if (flags.length) {
          // Stop stale work before clearing busy markers; otherwise an old turn can
          // keep sending while its replacement starts. Failed cancellation retries later.
          if (sid) {
            try { await api.stopSessionWork(sid); }
            catch (error) { log('[reserved2] 看门狗停止旧回合失败 ' + key + ':', error?.message ?? error); continue; }
            if (state.sessions[key] !== sid) continue;
            collectors.delete(sid);
          }
          drainPromptQueue(key, '陈旧回合已由看门狗停止');
          disarmPendingWakeLease(key);
          log(`[reserved2] ⚠️ 看门狗：${key} 已卡住超过 ${Math.round(stuckMs / 60000)} 分钟，陈旧标志=${flags.join('+')} → 清除并补发`);
          clearStaleBusyFlags(key, st);
          if (sid) v2TurnStartAt.delete(sid);
        } else {
          log(`[reserved2] 看门狗：${key} 已空闲但有积压唤醒，直接补发`);
        }
        const item = queued.shift();
        try { scheduleWakeV2(key, item?.reason ?? 'timeout'); } catch (error) { log('看门狗补发失败:', error?.message ?? error); }
      } else {
        // 真有回合在跑：只记录，不动
        log(`[reserved2] 看门狗：${key} 有积压唤醒但回合仍在跑（${flags.join('+')}），继续等`);
      }
    }
  }
  // 用 var：调用点在前面（main 启动时），let 会触发 TDZ 导致启动即崩（踩过一次）
  // ── 游戏唤醒保险（本机改动 2026-10-06）────────────────────────────────
  // 开「谁是卧底」时要把群设成 anyMessage（每条都唤醒），结束时必须还原。
  // 靠模型自觉不可靠 —— 忘了还原 = 那个群此后每句话都烧钱。
  // 保险：anyMessage 开太久、或 game session 太旧 → 自动还原 + 清 session + 告警。
  function safeWakeConfigDefault() {
    return {
      mode: 'diving', infinite: true, sleepUntil: null,
      triggers: { atMention: true, nameMention: true, question: true, poke: true, anyMessage: false, probability: 0.15, keywords: [], speakerIds: [] },
      batchWindowMs: Number(cfg.socialV2?.wake?.batchWindowMs) || 2000
    };
  }
  async function gameWakeGuardTick(force = false) {
    const anyMax = Math.max(60000, Number(cfg.socialV2?.game?.anyMessageMaxMs ?? 7200000));
    const sessMax = Math.max(60000, Number(cfg.socialV2?.game?.sessionMaxMs ?? 14400000));
    const now = Date.now();
    const st = loadGameState();
    const out = [];
    for (const [key, g] of Object.entries(st.conversations ?? {})) {
      let conv;
      try { conv = getSocialV2State(key); } catch { continue; }
      if (!conv?.wakeConfig) continue;
      const anyOn = conv.wakeConfig.triggers?.anyMessage === true;
      const since = Number(conv.wakeConfig.anyMessageSince ?? 0);
      const sess = g.session;
      const started = Number(sess?.startedAt ?? 0);
      const sessStale = started > 0 && now - started > sessMax;
      const anyTooLong = anyOn && ((since > 0 && now - since > anyMax) || (!since && started > 0 && now - started > anyMax));
      if (!sessStale && !(anyOn && (anyTooLong || force))) continue;
      const backup = sess?.state?.wakeBackup;
      const base = safeWakeConfigDefault();
      const restored = backup && typeof backup === 'object' && backup.triggers ? backup : base;
      conv.wakeConfig = { ...base, ...restored, triggers: { ...base.triggers, ...(restored.triggers ?? {}) } };
      delete conv.wakeConfig.anyMessageSince;
      saveSocialV2State();
      if (sess) { g.session = null; saveGameState(); }
      const why = sessStale ? `游戏局超过 ${Math.round(sessMax / 60000)} 分钟未结束` : `anyMessage 开了超过 ${Math.round(anyMax / 60000)} 分钟`;
      log(`⚠️ 游戏唤醒保险：${key} ${why} → 已还原唤醒配置${backup ? '（用她存的原配置）' : '（用安全默认值）'}，并清空进行中的一局`);
      out.push({ key, why, usedBackup: !!backup });
      try {
        await sendToQQ(selfOwnerKey(), `⚠️ 游戏唤醒保险触发：${key}\n原因：${why}\n已自动还原该群的唤醒配置（否则那个群会每条消息都唤醒她）。`);
      } catch {}
    }
    return out;
  }
  // ── 待补发唤醒落盘 + 启动救援（本机改动 2026-10-06）────────────────────
  // 起因：@ 她时若她正忙，唤醒会被"暂存"，而那个队列**只在内存里** —— 桥接一重启就整条消失，
  // 于是出现"@ 了却没反应"。现在：队列落盘；启动时恢复并补发；另外给"有未读但模型没见过"的
  // 会话补一次唤醒（重启后 modelSeenSeqs 是空的，未读会一直躺着没人管）。
  const PENDING_WAKES_FILE = path.join(ROOT, 'state', 'pending-wakes.json');
  function persistPendingWakes() {
    try {
      const out = {};
      for (const [key, st] of socialV2.conversations ?? []) {
        if (EPHEMERAL_GROUP_KEYS.has(key)) continue;
        const q = Array.isArray(st?.pendingWakeReasons) ? st.pendingWakeReasons.filter((r) => r && r.reason) : [];
        if (q.length) out[key] = q.slice(0, 5);
      }
      if (Object.keys(out).length) atomicWriteJson(PENDING_WAKES_FILE, { at: Date.now(), queue: out });
      else { try { fs.rmSync(PENDING_WAKES_FILE, { force: true }); } catch {} }
    } catch (error) { log('保存待补发唤醒失败:', error?.message ?? error); }
  }
  async function startupWakeRecovery() {
    let saved = null;
    try { saved = readJsonSafe(PENDING_WAKES_FILE, null); } catch {}
    const restore = saved?.queue && typeof saved.queue === 'object' ? saved.queue : {};
    let n = 0;
    const keys = new Set([...Object.keys(restore), ...(socialV2.conversations ? [...socialV2.conversations.keys()] : [])]);
    for (const key of keys) {
      let st;
      try { st = getSocialV2State(key); } catch { continue; }
      if (!st) continue;
      const queued = Array.isArray(restore[key]) ? restore[key].filter((r) => r && r.reason) : [];
      if (queued.length) {
        if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
        for (const r of queued) {
          if (!st.pendingWakeReasons.some((x) => x && x.reason === r.reason && x.seq === r.seq)) st.pendingWakeReasons.push(r);
        }
        st.pendingWakeReasons = st.pendingWakeReasons.slice(0, 5);
      }
      const unseen = Array.isArray(st.unread) ? st.unread.length : 0;
      const hasQueued = Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length > 0;
      if (!hasQueued && unseen < 2) continue;
      const reason = hasQueued ? (st.pendingWakeReasons[0].reason || 'timeout') : 'timeout';
      // 本机改动（2026-10-07 一致性修复）：深夜重启不许把她拉起来处理积压 ——
      // 只把积压"记着"，等她醒了（作息脱离睡觉时段）自然会处理。
      // 例外：私聊和 @ 属于"必须能叫醒"，照旧。
      const highPrio = ['private', 'atMention', 'question', 'nameMention'].includes(String(reason))
        || String(key).startsWith('private:') || String(reason).startsWith('speaker:');
      if (rhythmIsSleeping() && !highPrio) {
        log('启动救援：' + key + ' 有积压，但现在是睡觉时段（' + reason + '）→ 先记着，等她醒');
        continue;
      }
      setTimeout(() => {
        try {
          const why = hasQueued ? '落盘的待补发唤醒' : String(unseen) + ' 条未读没人管';
          log('启动救援：' + key + ' 有' + why + ' → 补一次唤醒（' + reason + '）');
          scheduleWakeV2(key, reason);
        } catch (error) { log('启动救援调度失败:', error?.message ?? error); }
      }, 3000 + n * 4000);
      n += 1;
    }
    try { fs.rmSync(PENDING_WAKES_FILE, { force: true }); } catch {}
    if (n) log('启动救援：共为 ' + n + ' 个会话安排了补唤醒');
  }

  var gameGuardTimer = null;
  function startGameGuard() {
    if (gameGuardTimer) return;
    gameGuardTimer = setInterval(() => { void gameWakeGuardTick().catch(() => {}); }, 90000);
    gameGuardTimer.unref?.();
    log('[reserved2] 游戏唤醒保险已启动（每 90 秒检查一次）');
  }

  var busyWatchdogTimer = null;
  function startBusyWatchdog() {
    if (busyWatchdogTimer) return;
    busyWatchdogTimer = setInterval(() => { void busyWatchdogTick().catch(() => {}); }, 45000);
    busyWatchdogTimer.unref?.();
    log('[reserved2] 卡死看门狗已启动（每 45 秒检查一次）');
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid && (v2TurnStartAt.has(sid) || collectors.has(sid))) return true;
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    historyRecovery: 45,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  function scheduleWakeV2(key, reason) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return;
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || sessionResettingKeys.has(key)) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      // 本机改动（2026-10-06）：暂存唤醒**按优先级合并**。
      // 一次唤醒本来就会把未读全部读一遍，所以队列里堆一堆重复唤醒没有意义 ——
      // 群里刷屏时旧写法会积压很多条（每条要等一个回合结束才补发一条），看起来就是"卡住"。
      // 现在只保留"优先级不低于新来的"那些 + 新来的这条，上限 5。
      {
        const pr = WAKE_PRIORITY[reason] ?? 10;
        const kept = st.pendingWakeReasons.filter((r) => r && (WAKE_PRIORITY[r.reason] ?? 10) > pr);
        if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) kept.push({ reason, seq });
        else kept.push({ reason, seq });
        st.pendingWakeReasons = kept.slice(0, 5);
        persistPendingWakes();
      }
      if (false) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  function setupSleepTimerV2(key) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return;
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  // ── 主动机会判定（本机改动 2026-10-06：从定时器里抽出来，便于自测 + 每日上限）
  function proactiveActivityV2(p = cfg.socialV2?.proactive ?? {}, st = null) {
    // Current rhythm is independent of the retired mood module. Never enable
    // that old module to make the new setting work; low per-chat capacity still wins.
    const m = moodCfg().enabled === true && moodCfg().proactiveLink !== false ? moodSettle() : {value: 0, energy: 60};
    const energy = st ? Math.min(m.energy, patienceNow(st)) : m.energy;
    return proactiveActivityProfile(p,
      {energy, mood: m.value, rhythmFactor: rhythmHourFactor(), dailyFactor: dailyStateProactiveFactor()});
  }
  function proactiveCheckTick(key, opts = {}) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return;
    // 测试模式硬隔离（本机改动）：加速时只对 scope 内会话主动搭话，绝不碰真实群/私聊
    if (typeof testActive === 'function' && testActive() && !testAppliesTo(key)) return;
    const dryRun = opts.dryRun === true;
    // 测试模式覆盖（本机改动）：scope 内的会话用加速参数（其它会话不受影响）
    const pRaw = cfg.socialV2?.proactive ?? {};
    const p = (typeof testAppliesTo === 'function' && typeof testCfg === 'function' && testAppliesTo(key))
      ? { ...pRaw, ...(testCfg().overrides?.proactive ?? {}) }
      : pRaw;
    const st = getSocialV2State(key);
    if (cfg.socialV2?.proactive?.enabled === false) return { key, ok: false, why: 'proactive 已关' };
    try { ensureWakeableV2(st, { key }); } catch {}
    const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
    const idle = Date.now() - (st.lastIncomingAt || 0);
    const probBase = Number(p.probability);
    let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
    if (cfg.socialV2?.mood?.proactiveLink !== false) prob = Math.min(1, prob * moodProactiveFactor());
    const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
    if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
    if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
    const hour = new Date().getHours();
    // 本机改动（2026-10-06）：改用作息曲线（含深夜/午休），不再硬编码"23-8 点 ×0.3"
    prob *= rhythmHourFactor();
    prob *= dailyTalkative();   // 本机改动：话痨的日子更愿意主动开口
    prob *= dailyStateProactiveFactor();   // 今日状态（出门了/有点忙 → 不主动）
    const pPro = peerOfConversation(key, st);
    prob *= relationProactiveFactor(pPro.qq, pPro.name);   // 熟人更愿意找，生人不主动
    prob *= affinityFactorOf(pPro.qq ? personOf(pPro.qq, pPro.name, false) : null);   // 好感高更愿意找
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
    if (aiCount >= 5) prob *= 0.3;
    // 每日上限：一天最多主动开口几次（防止"每两小时来一句"烦人）
    const activity = proactiveActivityV2(p, st);
    const dailyMax = activity.dailyMax;
    const today = localDayKey();
    if (!st.proactiveDay || st.proactiveDay.key !== today) st.proactiveDay = { key: today, count: 0 };
    const used = Number(st.proactiveDay.count || 0);
    // 本机改动 2026-10-08（用户要求）：**追问 ≠ 主动开新话题**
    //   她说完话、对方一直没回 → 这是"等回音"，可以再敲一下（不占"主动开口"的额度）
    //   对方说完话、冷场了 → 这才是"主动开新话题"（占额度，每天 2 次）
    // ── "等回音" vs "对话结束"（本机改动 2026-10-08，用户提的两个风险）：
    //   风险1：说了"晚安"之后还当成"等他回音" → 第二天继续敲 = 乱敲 ❌
    //   风险2：__waiting 永远为真 → "主动开新话题"通道**永远用不到** ❌
    //   修法：① 最后一条是收尾话 → 视为对话结束（不追问 ✅ 也不算等回音 ✅）
    //         ② 她说完好几个小时都没人回（6h）→ 不再是"等回音"，回归"主动开口" ✅
    const __lastMsg = (st.recentMessages ?? [])[(st.recentMessages ?? []).length - 1];
    const __END_RE = /(晚安|睡了|睡觉|去睡|歇了|下了|拜拜|再见|明天见|明天聊|改天|先忙|去忙|吃饭去|不聊了|回聊|摸鱼去|上班去|上课去|写作业|复习去)/;
    const __ended = __END_RE.test(String(__lastMsg?.text ?? ""));
    const __waitRaw = Number(st.lastAiReplyAt || 0) > Number(st.lastIncomingAt || 0);
    // A casual invitation is optional. Silence must not turn it into a reminder
    // wake. Explicit, due commitments keep their existing bounded follow-up path.
    const __optionalQuestion=participationQuestion(st,{key,now:Date.now(),maxAgeMs:6*3600000});
    const __agreedFollowUp=cfg.socialV2?.continuity?.enabled!==false&&normalizeContinuity(st.continuity).commitments.some(e=>e.owner==='other'&&!['completed','cancelled'].includes(e.status)&&e.dueAt&&e.dueAt<=Date.now()&&e.followUpCount<2&&(!e.lastFollowUpAt||Date.now()-e.lastFollowUpAt>=86400000));
    if(__waitRaw&&!__ended&&__optionalQuestion&&!__agreedFollowUp)return {key,ok:false,why:'闲聊邀请允许不答，不因等回音催问'};
    const __waiting = __waitRaw && !__ended && (Date.now() - Number(st.lastAiReplyAt || 0)) < 6 * 3600 * 1000;
    // Increased availability is for fresh contact, never more silent-response nudges.
    if (!__waiting) prob *= activity.probabilityMultiplier;
    prob = Math.min(1, Math.max(0, prob));
    const __endedNote = __ended ? "（最后是收尾话 → 对话已结束）" : (__waitRaw && !__waiting ? "（她说完超过6小时 → 不再算等回音）" : "");
    const __followMax = Number(p.followUpMaxPerDay ?? 3);
    if (!st.followUpDay || st.followUpDay.key !== today) st.followUpDay = { key: today, count: 0 };
    const __followUsed = Number(st.followUpDay.count || 0);
    const capReached = __waiting ? (__followMax > 0 && __followUsed >= __followMax) : (dailyMax > 0 && used >= dailyMax);
    const roll = Math.random();
    const contactGap = __waiting ? Math.max(activity.minContactGapMs, 90 * 60000) : activity.minContactGapMs;
    const sinceOwnReply = st.lastAiReplyAt ? Math.max(0, Date.now() - Number(st.lastAiReplyAt)) : Infinity;
    const info = { key, idleMin: Math.round(idle / 60000), idleThresholdMin: Math.round(idleThreshold / 60000), prob: Number(prob.toFixed(3)), roll: Number(roll.toFixed(3)), used, dailyMax, dailyBaseMax:activity.dailyBaseMax, energetic:activity.energetic, contactGapMin:contactGap/60000, capReached, busy: isConversationBusyV2(key, st) };
    if (capReached) return { ...info, ok: false, why: __waiting ? ('今日追问已用完（' + __followUsed + '/' + __followMax + '）') : ('已达今日主动上限（' + used + '/' + dailyMax + '）') };
    if (idle < idleThreshold * (__waiting ? 1.5 : 1)) return { ...info, ok: false, why: '还没冷场够（' + info.idleMin + '/' + Math.round(idleThreshold * (__waiting ? 1.5 : 1) / 60000) + ' 分钟' + (__waiting ? '·追问' : '') + '）' };
    if (sinceOwnReply < contactGap) return { ...info, ok: false, why: '留出联系间隔（' + Math.round(sinceOwnReply/60000) + '/' + info.contactGapMin + ' 分钟）' };
    if (info.busy) return { ...info, ok: false, why: '会话正忙' };
    if (!(roll < prob)) return { ...info, ok: false, why: '抽签没过（' + info.roll + ' >= ' + info.prob + '）' };
    if (dryRun) return { ...info, ok: true, why: '命中（试跑，未真正唤醒）' };
    if (__waiting) st.followUpDay.count = __followUsed + 1; else st.proactiveDay.count = used + 1;
    saveSocialV2State();
    log('[reserved2] ' + (__waiting ? '追问一下（对方没回）' : '主动开口') + '：' + key + '（' + (__waiting ? '今日追问 ' + st.followUpDay.count + '/' + __followMax : '今日主动 ' + st.proactiveDay.count + '/' + dailyMax) + '，p=' + info.prob + '）');
    void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log('[reserved2] proactive 唤醒异常 ' + key + ':', error?.message ?? error));
    return { ...info, ok: true, why: '已唤醒（主动开口）' };
  }

  // ── 跨会话人物记忆（本机改动 2026-10-06）──────────────────────────────
  // 起因：原来的 memberImpressions 挂在"会话"上 —— 私聊里记住的人，群里完全用不上
  // （同一个人两份记忆，各说各的）。这里加一份**按人**的全局档案，私聊/群聊共享。
  // 隐私边界：私聊来源的内容只进 privateFacts，注入到群聊时会被标注"别当众说出来"。
  const PERSONS_FILE = path.join(ROOT, 'state', 'persons.json');
  let personsState = null;
  function loadPersons() {
    if (personsState) return personsState;
    const rawP = readJsonSafe(PERSONS_FILE, null);
    personsState = rawP && typeof rawP === 'object' ? rawP : {};
    if (!personsState.people || typeof personsState.people !== 'object') personsState.people = {};
    return personsState;
  }
  function savePersons() {
    try { atomicWriteJson(PERSONS_FILE, loadPersons()); } catch (error) { log('保存人物档案失败:', error?.message ?? error); }
  }
  // 绑定**一律按 QQ**（本机改动 2026-10-07，用户要求）：
  // 同一个人在不同群/私聊的显示名可能完全不同，只有 QQ 是唯一标识 ——
  // 所以只要拿到 QQ 就用 qq:<号> 作为唯一键；拿不到 QQ 才退回按名字（极少见，且会被合并）。
  function personKey(qq, name) {
    const q = String(qq ?? '').trim();
    if (/^\d{4,12}$/.test(q)) return 'qq:' + q;
    const nm = String(name ?? '').trim();
    return nm ? 'name:' + nm : '';
  }
  // 把"按名字"的旧条目合并进对应的 QQ 条目（同名/同名片视为同一人）
  function personOf(qq, name, create = true) {
    const id = personKey(qq, name);
    if (!id) return null;
    const stP = loadPersons();
    if (!stP.people[id]) {
      if (!create) return null;
      stP.people[id] = {
        id,
        qq: /^\d+$/.test(String(qq ?? '')) ? String(qq) : null,
        name: String(name ?? '').trim() || null,
        facts: [],
        privateFacts: [],
        interactionCount: 0,
        lastSeenAt: 0,
        updatedAt: 0
      };
    }
    const person = stP.people[id];
    if (!Array.isArray(person.facts)) person.facts = [];
    if (!Array.isArray(person.privateFacts)) person.privateFacts = [];
    return person;
  }
  // 记一条人物记忆；fromPrivate 决定进 privateFacts 还是 facts
  function personRemember(qq, name, content, fromPrivate = false) {
    const person = personOf(qq, name, true);
    if (!person) return null;
    const text = String(content ?? '').trim().slice(0, 200);
    if (!text) return null;
    if (name && !person.name) person.name = String(name).trim();
    const list = fromPrivate ? person.privateFacts : person.facts;
    if (!list.includes(text)) list.push(text);
    if (list.length > 12) list.splice(0, list.length - 12);
    person.interactionCount = (Number(person.interactionCount) || 0) + 1;
    person.lastSeenAt = Date.now();
    person.updatedAt = Date.now();
    savePersons();
    return person;
  }
  // 生成"关于某人"的注入块（跨会话）
  function personBlock(qq, name, opts = {}) {
    const person = personOf(qq, name, false);
    if (!person) return '';
    const bits = [];
    const facts = Array.isArray(person.facts) ? person.facts : [];
    if (facts.length) bits.push(facts.slice(-4).join('；'));
    if (opts.allowPrivate) {
      const priv = Array.isArray(person.privateFacts) ? person.privateFacts : [];
      if (priv.length) bits.push('（私聊里知道的：' + priv.slice(-2).join('；') + ' —— 心里有数就行，别当众说出来）');
    }
    if (!bits.length) return '';
    const label = person.name ? person.name : (person.qq ? 'QQ ' + person.qq : '这个人');
    return '【我对' + label + '的印象（跨会话）】' + bits.join(' ');
  }
  // ── 作息 / 精力 + 耐心（本机改动 2026-10-06）──────────────────────────────
  // 用户要求：聊天频率要跟着一天作息走（深夜/午休不想回消息），并且要有一个"耐心"，
  // 低耐心时**潜移默化**地让对方感觉到（变短、变慢、敷衍、偶尔不回），但**绝不许直接说**。
  // 注意：这**不是**之前删掉的「心情/好感度」—— 没有互动攒点数，纯粹按时钟 + 被烦程度。
  const RHYTHM_DEFAULT_HOURS = [
    0.05, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.05, // 00-07 睡觉
    0.30, 1.00, 1.00, 1.00,                          // 08-11 刚醒 → 上午
    0.35, 0.35,                                      // 12-13 午休（懒得回）
    1.00, 1.00, 1.00, 1.00,                          // 14-17 下午
    0.60, 0.60,                                      // 18-19 晚饭
    1.20, 1.20, 1.20, 0.60                           // 20-23 晚上最活跃
  ];
  function rhythmCfg() { return cfg.socialV2?.rhythm ?? {}; }
  function rhythmHours() {
    const r = rhythmCfg();
    return Array.isArray(r.hours) && r.hours.length === 24 ? r.hours : RHYTHM_DEFAULT_HOURS;
  }
  // 当前小时的能量系数（0~1.5）。周末整体后移（睡得晚起得晚）。
  function rhythmHourFactor(date = new Date()) {
    const r = rhythmCfg();
    if (r.enabled === false) return 1;
    const shift = (r.weekendShift !== false && (date.getDay() === 0 || date.getDay() === 6)) ? (Number(r.weekendShiftHours) || 1) : 0;
    const h = ((date.getHours() - shift) % 24 + 24) % 24;
    const f = Number(rhythmHours()[h]);
    return Math.min(1.5, Math.max(0, Number.isFinite(f) ? f : 1));
  }
  function rhythmIsSleeping(date = new Date()) {
    return rhythmHourFactor(date) <= (Number(rhythmCfg().sleepThreshold) || 0.1);
  }
  // 越困，回得越慢
  function rhythmDelayMultiplier() {
    const f = rhythmHourFactor();
    if (f >= 0.8) return 1;
    if (f >= 0.5) return 1.3;
    if (f >= 0.2) return 1.8;
    return Number(rhythmCfg().sleepDelayMultiplier) || 2.5;
  }
  // 状态描述（写进提示词，让她语气跟着变 —— 这是"潜移默化"的一半）
  function rhythmMoodText(date = new Date()) {
    if (cfg.socialV2?.rhythm?.enabled === false) return '';
    const f = rhythmHourFactor(date);
    const h = date.getHours();
    if (f <= 0.1) return '现在是低活动时段，少主动开启支线；直接求助仍给完整答案，不编造睡眠经历。';
    if (f <= 0.4) return h >= 12 && h < 14 ? '现在是低活动时段，优先当前话题，不主动铺开多个支线。' : '你现在有点不在状态：回复短一点，别太热情。';
    if (f <= 0.7) return '你现在有一搭没一搭：正常聊就行，不用特别积极。';
    if (f >= 1.1) return '你现在精神很好，正想找人说话。';
    return '';
  }
  // ── 耐心：per 会话，会掉也会回 ─────────────────────────────────────────
  function patienceCfg() { return cfg.socialV2?.patience ?? {}; }
  function patienceMax() { return Number(patienceCfg().max) || 100; }
  function patienceDefault() { return Number(patienceCfg().initial) || 70; }
  function patienceNow(st, now = Date.now()) {
    const p = patienceCfg();
    if (p.enabled === false) return patienceMax();
    let v = Number(st.patience);
    if (!Number.isFinite(v)) v = patienceDefault();
    const last = Number(st.patienceAt) || Number(st.lastIncomingAt) || Number(st.lastAiReplyAt) || (now - 60000);  // 修"卡在70"：缺失时不能用 now（那样永远算 0 分钟）
    const mins = Math.max(0, (now - last) / 60000);
    // 恢复：安静越久回得越多；睡觉时段恢复翻倍
    const perMin = Number(p.recoverPerMinute) || 0.3;
    // 白天（她状态好）恢复更快：×1.5；睡觉时段另有 sleepBoost
    const rf2 = (() => { try { return rhythmHourFactor(); } catch { return 1; } })();
    const dayBoost = rf2 >= 0.8 ? 1.5 : 1;
    const sleepBoost = rhythmIsSleeping(new Date(now)) ? (Number(p.sleepRecoverMultiplier) || 3) : 1;
    v = Math.min(patienceMax(), v + mins * perMin * sleepBoost * dayBoost);
    st.patience = v;
    st.patienceAt = now;
    return v;
  }
  // 收到一条消息：扣耐心（刷屏扣得更狠；困的时候更没耐心）
  function patienceDrain(st, count = 1, now = Date.now()) {
    const p = patienceCfg();
    if (p.enabled === false) return;
    const base = patienceNow(st, now);
    let cost = (Number(p.drainPerMessage) || 6) * Math.max(0.1, Number(count) || 1);
    if (Number(count) >= 3) cost *= Number(p.spamMultiplier) || 1.8;
    if (rhythmHourFactor(new Date(now)) <= 0.2) cost *= Number(p.tiredMultiplier) || 1.5;
    st.patience = Math.max(0, base - cost);
    st.patienceAt = now;
  }

  // ── 耐心面板支持（本机改动 2026-10-07）：走势采样 + 掉分原因统计 ────────
  // 采样用"懒采样"：不新增定时器 —— 每次收到消息或面板刷新时，若距上次采样 ≥10 分钟就记一个点。
  function patienceSample(st, now = Date.now()) {
    if (!Array.isArray(st.patienceHistory)) st.patienceHistory = [];
    const last = st.patienceHistory.length ? Number(st.patienceHistory[st.patienceHistory.length - 1].t) : 0;
    if (now - last < 10 * 60 * 1000) return;
    st.patienceHistory.push({ t: now, v: Math.round(patienceNow(st)) });
    if (st.patienceHistory.length > 24) st.patienceHistory.splice(0, st.patienceHistory.length - 24);
  }
  function patienceStat(st, cause, delta) {
    const day = localDayKeyStr();
    if (!st.patienceStats || st.patienceStats.day !== day) st.patienceStats = { day, spam: 0, push: 0, night: 0, recovered: 0, last: null };
    if (cause === 'recover') st.patienceStats.recovered = Math.round((Number(st.patienceStats.recovered) || 0) + Number(delta || 0));
    else st.patienceStats[cause] = (Number(st.patienceStats[cause]) || 0) + 1;
    st.patienceStats.last = { at: Date.now(), cause, delta: Number(delta || 0) };
  }
  // 分钟数：按当前恢复速率算"多久回满"
  function patienceMinutesToFull(st) {
    const cur = patienceNow(st);
    const perMin = Number(patienceCfg().recoverPerMinute) || 0.5;
    const rf = (() => { try { return rhythmHourFactor(); } catch { return 1; } })();
    const boost = (rf >= 0.8 ? 1.5 : 1) * (rhythmIsSleeping() ? (Number(patienceCfg().sleepRecoverMultiplier) || 3) : 1);
    const rate = Math.max(0.05, perMin * boost);
    return Math.max(0, Math.round((patienceMax() - cur) / rate));
  }

  // 收到一条消息时的耐心判定（**真实路径与自检注入路径共用**，避免行为不一致）
  function patienceOnIncoming(st, now = Date.now()) {
    try {
      const pc = cfg.socialV2?.patience ?? {};
      if (pc.enabled === false) return null;
      const streakThreshold = Number(pc.streakThreshold) || 3;
      const replyGraceMs = Number(pc.replyGraceMs) || 120000;
      const lastReply = Number(st.lastAiReplyAt) || 0;
      // 只看【最近 2 分钟】的连发（窗口化）——
      // 否则会把"她几小时前回过之后的所有消息"都算成刷屏，导致正常聊天也把耐心扣到 0。
      const winMs = Number(pc.streakWindowMs) || 120000;
      const latest = st.recentMessages?.at(-1);
      // Public chatter between others does not consume your communication load.
      if (!latest?.directToAi && !latest?.quoteTargetIsSelf && !isDirectedAtAi(String(latest?.text || latest?.plain || ''))) return {drained:0,unanswered:0};
      const sinceReply = (st.recentMessages || []).filter((m) => m && !m.isSelf && String(m.userId)===String(latest?.userId) && Number(m.time || 0) > Math.max(lastReply, now - winMs));
      const unanswered = sinceReply.length;
      const justReplied = lastReply && (now - lastReply) < replyGraceMs;
      if (unanswered >= streakThreshold && !justReplied) {
        // 本机改动（2026-10-07）：每条消息**只扣一点点**（drainPerMessage × 时间系数）。
        // 之前传的是"整段连发的条数"，而每条消息都会触发一次 → 同一段被反复扣 → 秒掉到 0。
        const rf = (() => { try { return rhythmHourFactor(); } catch { return 1; } })();
        const timeMul = rf >= 0.8 ? 0.5 : (rf <= 0.2 ? 1.5 : 1);
        const extra = Math.min(3, unanswered - streakThreshold + 1);   // 刷得越狠单条扣得越多，但封顶 3 倍
        const cost = timeMul * (1 + (extra - 1) * 0.5);
        patienceDrain(st, cost);
        // 记原因：她睡着的时段算 night，否则算 spam（催促类由别的入口记）
        patienceStat(st, rf <= 0.2 ? 'night' : 'spam', cost);
        patienceSample(st, now);
        return { drained: cost, unanswered, timeMul };
      }
      const cur = patienceNow(st);
      st.patience = Math.min(patienceMax(), cur + 0.5);
      st.patienceAt = now;
      patienceStat(st, 'recover', 0.5);
      patienceSample(st, now);
      return { drained: 0, unanswered };
    } catch (e) { return null; }
  }

  // 耐心 → 要不要回 / 回多短
  function patienceFactor(st) {
    const p = patienceCfg();
    if (p.enabled === false) return 1;
    const v = patienceNow(st);
    const mid = Number(p.midThreshold) || 45;
    const low = Number(p.lowThreshold) || 20;
    if (v <= low) return Number(p.lowFactor) || 0.35;
    if (v <= mid) return Number(p.midFactor) || 0.7;
    return 1;
  }
  function patienceLevel(st) {
    const v = patienceNow(st);
    if (v <= (Number(patienceCfg().lowThreshold) || 20)) return 'low';
    if (v <= (Number(patienceCfg().midThreshold) || 45)) return 'mid';
    return 'high';
  }
  function patienceMoodText(st) { return communicationHint({energy:patienceNow(st)}); }
  // 作息 + 耐心 一起算"要不要醒"
  function rhythmWakeFactor(st, date = new Date()) {
    return rhythmHourFactor(date) * patienceFactor(st);
  }
  // ── 群活跃度激活（本机改动 2026-10-07）──────────────────────────────────
  // 用户要求：就算作息上是深夜，只要"群里大家都在聊"，她也该被激活。
  // 关键设计：
  //   ① 用 max(作息, 活跃度) 而不是相乘 —— 只有 max 才盖得过"睡觉"；
  //   ② 必须**多人**在说（一个人刷屏不算热闹）；
  //   ③ 睡觉时段给活跃度打折（深夜上限），被吵醒也是迷糊的；
  //   ④ 只对群聊生效（私聊没有"热闹"这回事）。
  function activityCfg() { return cfg.socialV2?.activity ?? {}; }
  function activityStats(st, now = Date.now()) {
    const c = activityCfg();
    const winMs = Number(c.windowMs) || 5 * 60 * 1000;
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const inWin = recent.filter((m) => m && !m.isSelf && now - Number(m.time || 0) <= winMs);
    const senders = new Set(inWin.map((m) => String(m.userId ?? m.sender ?? m.card ?? '?')).filter(Boolean));
    return { msgs: inWin.length, speakers: senders.size, winMs };
  }
  function activityBoost(st, now = Date.now()) {
    const c = activityCfg();
    if (c.enabled === false) return 0;
    const s = activityStats(st, now);
    const minSpeakers = Number(c.minSpeakers) || 2;
    if (s.speakers < minSpeakers) return 0;
    const hotSpeakers = Number(c.hotSpeakers) || 3;
    const hotMsgs = Number(c.hotMsgs) || 8;
    const warmMsgs = Number(c.warmMsgs) || 4;
    if (s.speakers >= hotSpeakers && s.msgs >= hotMsgs) return Number(c.hotBoost) || 0.9;
    if (s.speakers >= hotSpeakers && s.msgs >= warmMsgs) return Number(c.warmBoost) || 0.6;
    return Number(c.coolBoost) || 0.4;
  }
  // 作息与活跃度取较大者（私聊只用作息）
  function activityFactorFor(st, opts = {}) {
    const now = Number(opts.now) || Date.now();
    const rhythm = rhythmHourFactor(new Date(now));
    if (opts.key && !String(opts.key).startsWith('group:')) return rhythm;
    const boost = activityBoost(st, now);
    if (!boost) return rhythm;
    const c = activityCfg();
    const nightThreshold = Number(c.nightThreshold) || 0.2;
    const nightCap = Number(c.nightCap) || 0.7;
    const capped = rhythm <= nightThreshold ? Math.min(boost, nightCap) : boost;
    return Math.max(rhythm, capped);
  }
  function activityWakeFactor(st, opts = {}) {
    // 本机改动（2026-10-07）：再乘"今日话痨指数"（0.6~1.4），并封顶 1.5
    return Math.min(1.5, activityFactorFor(st, opts) * patienceFactor(st) * dailyTalkative());
  }
  // 被活跃度"吵醒"时的状态文案
  function activityMoodText(st, opts = {}) {
    const now = Date.now();
    const boost = (opts.key && !String(opts.key).startsWith('group:')) ? 0 : activityBoost(st, now);
    if (!boost) return '';
    const s = activityStats(st, now);
    const sleeping = rhythmHourFactor(new Date(now)) <= (Number(rhythmCfg().sleepThreshold) || 0.1);
    if (sleeping) {
      return '现在是低活动时段，群里出现公开话题（' + s.speakers + ' 个人在说、' + s.msgs + ' 条新消息）；有具体内容可以参与一句，必要求助认真处理。';
    }
    return '群里现在挺热闹（' + s.speakers + ' 个人在说、' + s.msgs + ' 条新消息），你可以自然参与进去。';
  }
  // ── 每日话痨指数（本机改动 2026-10-07）────────────────────────────────
  // 用户要求：有的天她特别能聊、有的天很安静 —— 像人，不像机器。
  // 每天一个 0.6~1.4 的系数（三角分布，多数天接近 1.0，偶尔特别话多/话少）。
  // 全局生效（今天对所有会话都是同一个"话多话少"），落盘 state/daily-mood.json。
  const DAILY_MOOD_FILE = path.join(ROOT, 'state', 'daily-mood.json');
  let dailyMoodCache = null;
  function localDayKeyStr(d = new Date()) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dailyTalkative() {
    const c = cfg.socialV2?.talkative ?? {};
    if (c.enabled === false) return 1;
    const today = localDayKeyStr();
    if (dailyMoodCache && dailyMoodCache.date === today) return Number(dailyMoodCache.value) || 1;
    let saved = null;
    try { saved = readJsonSafe(DAILY_MOOD_FILE, null); } catch {}
    if (saved && saved.date === today && Number.isFinite(Number(saved.value))) {
      dailyMoodCache = { date: today, value: Number(saved.value) };
      return dailyMoodCache.value;
    }
    const lo = Number(c.min) || 0.6;
    const hi = Number(c.max) || 1.4;
    // 三角分布 ((r1+r2)/2)：多数天接近 1.0，偶尔特别话多/特别懒
    const tt = (Math.random() + Math.random()) / 2;
    const value = Number((lo + tt * (hi - lo)).toFixed(3));
    dailyMoodCache = { date: today, value };
    try { atomicWriteJson(DAILY_MOOD_FILE, { date: today, value, at: Date.now() }); } catch {}
    log('[每日] 今天的话痨指数：' + value + '（' + (value >= 1.15 ? '话特别多' : value <= 0.85 ? '懒得开口' : '正常') + '）');
    return value;
  }
  function talkativeMoodText() {
    const c = cfg.socialV2?.talkative ?? {};
    if (c.enabled === false) return '';
    const v = dailyTalkative();
    if (v >= 1.2) return '你今天话比平时多，看什么都想接一句。';
    if (v >= 1.05) return '你今天状态不错，愿意聊。';
    if (v <= 0.8) return '你今天懒得开口：能不说就不说，回也回得短。';
    if (v <= 0.95) return '你今天话不多：别人问你再说，别主动找话。';
    return '';
  }
  // ── 亲疏分层（6 级）+ 好感度（本机改动 2026-10-07）──────────────────────
  // 用户要求：① 关系不止"普通/熟人"几层，要更丰富；② 加好感度（0~100，按人绑定，
  // 会涨会跌，控制台可看可控）；③ 一视同仁 —— 谁都能掉分（包括管理员）。
  // 两条轴：
  //   亲疏 tier     = 认识程度（聊了多少句 + 认识多久）→ 决定"多愿意理你、说话多随便"
  //   好感 affinity = 喜不喜欢（行为触发涨跌 + 缓慢回落）→ 决定"对你的态度好不好"
  // 性能：全部在内存里算；落盘节流（跨阈值/每 20 条才写一次），绝不阻塞回复链路。
  function relationsCfg() { return cfg.socialV2?.relations ?? {}; }
  function affinityCfg() { return cfg.socialV2?.affinity ?? {}; }
  // 6 级：阈值与系数都可在 config 里改
  // 正向阶梯（本机改动 2026-10-07：用户要求门槛抬高 —— 交情要"聊出来"）
  const TIERS_DEFAULT = [
    { id: 'best', label: '死党', msgs: 400, days: 14, wake: 1.45, proactive: 2.0 },
    { id: 'close', label: '熟人', msgs: 150, days: 5, wake: 1.3, proactive: 1.6 },
    { id: 'friendly', label: '熟络', msgs: 60, days: 2, wake: 1.15, proactive: 1.3 },
    { id: 'normal', label: '普通', msgs: 20, days: 0, wake: 1.0, proactive: 1.0 },
    { id: 'acquainted', label: '眼熟', msgs: 5, days: 0, wake: 0.8, proactive: 0.6 },
    { id: 'stranger', label: '陌生人', msgs: 0, days: 0, wake: 0.6, proactive: 0.3 }
  ];
  // 负向档：不看认识多久，只看"好感度低到什么程度"（由好感度驱动，覆盖上面的亲疏档）
  const NEGATIVE_TIERS = [
    { id: 'hated', label: '仇人', maxAffinity: 8, wake: 0.35, proactive: 0.1 },
    { id: 'disliked', label: '讨厌', maxAffinity: 20, wake: 0.55, proactive: 0.3 }
  ];
  function tierTable() {
    const t = relationsCfg().tiers;
    return Array.isArray(t) && t.length ? t : TIERS_DEFAULT;
  }
  function tierMeta(id) {
    return tierTable().find((x) => x.id === id)
      ?? NEGATIVE_TIERS.find((x) => x.id === id)
      ?? TIERS_DEFAULT[TIERS_DEFAULT.length - 1];
  }
  // 好感度低到门槛以下 → 直接降为负向档（覆盖亲疏档）
  function negativeTierByAffinity(v) {
    if (cfg.socialV2?.relations?.negativeByAffinity === false) return null;
    for (const t of NEGATIVE_TIERS) if (Number(v) <= Number(t.maxAffinity)) return t.id;
    return null;
  }
  const REL_LABEL = Object.fromEntries(TIERS_DEFAULT.map((t) => [t.id, t.label]));
  // 收到消息时"碰一下"这个人（累计句数、首次见面时间）—— 亲疏分层的自动推导靠这个
  function personTouch(qq, name, now = Date.now()) {
    const c = relationsCfg();
    if (c.enabled === false) return null;

    const person = personOf(qq, name, true);
    if (!person) return null;
    person.msgCount = (Number(person.msgCount) || 0) + 1;
    if (!person.firstSeenAt) person.firstSeenAt = now;
    person.lastSeenAt = now;
    const before = person.autoTier;
    const after = autoTierOf(person);
    if (before !== after) {
      person.autoTier = after;
      log('[关系] ' + (person.name || person.qq || person.id) + ' → ' + (tierMeta(after).label || after) + '（累计 ' + person.msgCount + ' 句）');
      savePersons();
    } else if (person.msgCount % 20 === 0) {
      savePersons();
    }
    return person;
  }
  function autoTierOf(person) {
    const msgs = Number(person?.msgCount) || 0;
    const knownMs = person?.firstSeenAt ? Date.now() - Number(person.firstSeenAt) : 0;
    const days = knownMs / 86400000;
    for (const t of tierTable()) {
      if (msgs >= (Number(t.msgs) || 0) && days >= (Number(t.days) || 0)) return t.id;
    }
    return 'stranger';
  }
  // 解析某人的亲疏档（手动 > 自动 > 默认陌生人）
  function relationOf(qq, name) {
    const c = relationsCfg();
    const q = String(qq ?? '').trim();
    if (c.enabled === false) return { tier: 'normal', source: 'off', label: '普通', factor: 1, proactive: 1 };
    const manual = c.manual && typeof c.manual === 'object' ? c.manual : {};
    let tier = null; let source = 'auto';
    if (q && manual[q]) { tier = String(manual[q]); source = 'manual'; }
    if (!tier) {
      let person = q ? personOf(q, name, false) : null;
      if (!person && name) {
        const stP = loadPersons();
        person = Object.values(stP.people ?? {}).find((x) => x && x.name && String(x.name) === String(name)) ?? null;
      }
      tier = person ? autoTierOf(person) : 'stranger'; // Time thresholds must refresh on reads too.
    }
    // 好感度低到"讨厌/仇人"就直接覆盖亲疏档 —— **连手动指定也覆盖**：
    // 都到"仇人"了还显示"熟人"没道理（用户要求一视同仁，管理员也会掉）。
    {
      const person = q ? personOf(q, name, false) : null;
      const neg = person ? negativeTierByAffinity(affinityNow(person)) : null;
      if (neg) { source = source === 'manual' ? 'manual+affinity' : 'affinity'; tier = neg; }
    }
    const meta = tierMeta(tier);
    if (!meta) tier = 'normal';
    const m = tierMeta(tier);
    return { tier, source, label: m.label, factor: Number(m.wake) || 1, proactive: Number(m.proactive) || 1 };
  }
  function relationProactiveFactor(qq, name) {
    if (relationsCfg().enabled === false) return 1;
    return relationOf(qq, name).proactive;
  }
  // ── 好感度 ────────────────────────────────────────────────────────────
  // 指定某人的初始好感度（config.socialV2.affinity.initialByQQ = { "<QQ>": 75 }）
  function affinityInitialFor(qq, person) {
    const c = affinityCfg();
    const byQq = c.initialByQQ && typeof c.initialByQQ === 'object' ? c.initialByQQ : {};
    const q = String(qq ?? person?.qq ?? '').trim();
    if (q && Number.isFinite(Number(byQq[q]))) return Number(byQq[q]);
    return Number(c.initial) || 50;
  }
  function affinityNow(person) {
    const c = affinityCfg();
    if (c.enabled === false) return Number(c.initial) || 50;
    let v = Number(person?.affinity);
    if (!Number.isFinite(v)) v = affinityInitialFor(person?.qq, person);
    // 缓慢回落（向中间值靠）—— 太久没互动会淡一点，但很慢
    const mid = Number(c.initial) || 50;
    const last = Number(person?.affinityAt) || Date.now();
    const days = Math.max(0, (Date.now() - last) / 86400000);
    const decay = Number(c.decayPerDay) || 1.5;
    if (days > 0.5) v = v > mid ? Math.max(mid, v - decay * days) : Math.min(mid, v + decay * days);
    return Math.max(0, Math.min(100, v));
  }
  function affinityFactorOf(person) {
    const c = affinityCfg();
    if (c.enabled === false) return 1;
    const v = affinityNow(person);
    const mid = Number(c.initial) || 50;
    const span = Number(c.factorSpan) || 0.2;   // ±20%
    const raw = 1 + ((v - mid) / 50) * span;
    return Math.max(1 - span, Math.min(1 + span, raw));
  }
  // 好感度调整（带原因，留最近 10 条日志）
  function affinityAdjust(qq, name, delta, reason, now = Date.now()) {
    const c = affinityCfg();
    if (c.enabled === false || !delta) return null;
    const person = personOf(qq, name, true);
    if (!person) return null;
    const cur = affinityNow(person);
    const next = Math.max(0, Math.min(100, cur + Number(delta)));
    person.affinity = next;
    person.affinityAt = now;
    if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
    person.affinityLog.push({ at: now, delta: Number(delta), to: next, reason: String(reason || '').slice(0, 60) });
    if (person.affinityLog.length > 10) person.affinityLog.splice(0, person.affinityLog.length - 10);
    savePersons();
    return { person, value: next, delta: Number(delta) };
  }
  // 行为 → 好感度（零成本关键词判断，绝不做模型调用）
  function affinityTouchByMessage(qq, name, text, isGroup) {
    const c = affinityCfg();
    if (c.enabled === false) return null;
    const t = String(text ?? '');
    if (!t) return null;
    const P = c.patterns ?? {};
    const good = P.good ?? ['谢谢', '感谢', '厉害', '牛逼', '牛啊', '说得对', '哈哈', '笑死', '有意思', '可爱', '喜欢', '好玩', '赞', '专业', '靠谱', '辛苦了'];
    const bad = P.bad ?? ['傻逼', '弱智', '智障', '废物', '滚', '闭嘴', '有病', '恶心', '垃圾', '烦人', '别说了', '无聊', '菜', '蠢', '笨死'];
    let delta = 0; let reason = '';
    for (const w of good) if (t.includes(w)) { delta += Number(c.goodDelta) || 1.5; reason = '说了好话：' + w; break; }
    for (const w of bad) if (t.includes(w)) { delta -= Number(c.badDelta) || 3; reason = '说了难听的：' + w; break; }
    if (isGroup && t.length > 200) { delta -= 0.5; reason = reason || '刷长文'; }
    if (!delta) {
      // 没有明显情绪的普通对话：极小幅正向（代表"愿意跟你说话"）
      delta = Number(c.normalDelta) || 0.2;
      reason = '正常聊天';
    }
    return affinityAdjust(qq, name, delta, reason);
  }
  // 好感度 → 语气
  function affinityLabel(v) {
    const c = affinityCfg();
    if (v >= (Number(c.adoreThreshold) || 80)) return '挺喜欢你';
    if (v >= (Number(c.likeThreshold) || 65)) return '有好感';
    if (v >= (Number(c.okThreshold) || 45)) return '还行';
    if (v >= (Number(c.mehThreshold) || 30)) return '一般般';
    if (v >= (Number(c.dislikeThreshold) || 15)) return '不太待见';
    return '很烦他';
  }
  // 负向关系（讨厌/仇人）的说话方式
  function negativeToneText(tier, who) {
    return ['dislike','enemy','hated'].includes(tier)?'【关系边界】对 '+who+' 较少主动亲近；不放大普通分歧，认真求助仍认真回答。':'';
  }
  function affinityMoodText(qq, name) {
    if (affinityCfg().enabled === false) return '';
    const person=personOf(qq,name,false); if(!person) return '';
    const v=Math.round(affinityNow(person));
    return '【好感度】对 '+(person.name||name||qq)+'：'+v+'/100（'+affinityLabel(v)+'）。这是按人的粗略指标；高分可以更自在，具体相处方式看已有经历；低分允许少主动，但求助认真、边界一致。';
  }
  // 会话里"该按谁算"：私聊=对方；群聊=最后说话那个人
  function peerOfConversation(key, st) {
    if (String(key).startsWith('private:')) return { qq: String(key).split(':')[1], name: null };
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = replyFocus(st);
    return last ? { qq: last.userId ? String(last.userId) : null, name: last.card || last.sender || null } : { qq: null, name: null };
  }
  // ══ 好感度 v2：按"互动性质"计分（本机改动 2026-10-07，追加覆盖旧版）══════════
  // 为什么这么写：用户要求"千万别把现有东西搞坏"。这里**只追加**、不删除旧函数 ——
  // 同一作用域内后声明的同名函数生效，所以下面这些定义会覆盖上面的旧版；
  // 原有调用点（消息钩子、控制台接口）一个字都不用改，自动用上新逻辑。
  // 设计：好感度 = 初始分 + Σ(各类互动计数 × 权重)，**从计数器重算 → 幂等**（重复补齐不会叠加）。
  function affCounters(person) {
    if (!person) return null;
    if (!person.aff || typeof person.aff !== 'object') person.aff = {};
    const a = person.aff;
    for (const k of ['good', 'gift', 'fun', 'normal', 'spam', 'push', 'rude', 'neglect']) if (!Number.isFinite(Number(a[k]))) a[k] = 0;
    if (!Number.isFinite(Number(a.normalDay))) a.normalDay = 0;
    if (!Number.isFinite(Number(a.normalToday))) a.normalToday = 0;
    if (!Number.isFinite(Number(a.manualOffset))) a.manualOffset = 0;
    return a;
  }
  function affinityCompute(person) {
    const c = affinityCfg();
    if (c.enabled === false) return Number(c.initial) || 50;
    const a = affCounters(person);
    const init = affinityInitialFor(person?.qq, person);
    if (!a) return init;
    const w = {
      good: Number(c.wGood) || 2.5,
      gift: Number(c.wGift) || 2,
      fun: Number(c.wFun) || 1.5,
      normal: Number(c.wNormal) || 0.2,
      spam: Number(c.wSpam) || -1.5,
      push: Number(c.wPush) || -2.5,
      rude: Number(c.wRude) || -4,
      neglect: Number(c.wNeglect) || -8
    };
    let delta = Number(a.manualOffset) || 0;
    for (const k of ['good', 'gift', 'fun', 'normal', 'spam', 'push', 'rude', 'neglect']) delta += (Number(a[k]) || 0) * w[k];
    const cap = Number(c.deltaCap) || 45;
    delta = Math.max(-cap, Math.min(cap, delta));
    return Math.max(0, Math.min(100, init + delta));
  }
  // 覆盖旧版：有下限（久不联系不会跌成"讨厌/仇人"）
  // 覆盖旧版：有下限（久不联系不会跌成"讨厌/仇人"）
  function affinityNow(person) {
    return affinityCompute(person); // Shared effective score already includes the existing inactivity rule.
  }
  // 覆盖旧版：系数用 compute（幂等）
  function affinityFactorOf(person) {
    const c = affinityCfg();
    if (c.enabled === false) return 1;
    const v = affinityCompute(person);
    const mid = Number(c.initial) || 50;
    const span = Number(c.factorSpan) || 0.2;
    const raw = 1 + ((v - mid) / 50) * span;
    return Math.max(1 - span, Math.min(1 + span, raw));
  }
  // Lightweight target-aware classification; uncertain insults do not penalize.
  function affinityClassify(text, opts = {}) {
    return classifyInteraction(text, { patterns: affinityCfg().patterns ?? {}, ...opts });
  }
  // 记一次互动（只动计数器 → 幂等）
  function affinityRecord(qq, name, kind, now = Date.now()) {
    const c = affinityCfg();
    if (c.enabled === false || !kind) return null;
    const person = personOf(qq, name, true);
    if (!person) return null;
    const a = affCounters(person);
    if (kind === 'normal') {
      const today = Math.floor(now / 86400000);
      if (a.normalDay !== today) { a.normalDay = today; a.normalToday = 0; }
      const dailyMax = Number(c.normalDailyMax) || 10;   // 治"堆量"：普通聊天每天最多计 10 次
      if (a.normalToday >= dailyMax) return null;
      a.normalToday += 1;
    }
    a[kind] = (Number(a[kind]) || 0) + 1;
    person.affinityAt = now;
    if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
    person.affinityLog.push({ at: now, kind, to: Math.round(affinityCompute(person)), reason: '互动：' + kind });
    if (person.affinityLog.length > 15) person.affinityLog.splice(0, person.affinityLog.length - 15);
    savePersons();
    return person;
  }
  // 覆盖旧版：按互动性质记分（旧版是按"好话/难听话"二元判断）
  function affinityTouchByMessage(qq, name, text, isGroup, st = null) {
    const msg = st?.recentMessages?.at(-1);
    const recent = (st?.recentMessages || []).slice(-10);
    const lastSelf = recent.findLastIndex(m => m?.isSelf);
    const sameSender = recent.slice(lastSelf + 1).filter(m => !m.isSelf && String(m.userId) === String(qq));
    const kind = affinityClassify(text, { directed: !isGroup || msg?.directToAi || msg?.quoteTargetIsSelf || /鲸鱼|小鲸/.test(text),
      addressedToOther: !!msg?.addressedToOther, repeatedPush: sameSender.length >= 3 });
    if (!kind) return null;
    return affinityRecord(qq, name, kind, Date.now(), {text:String(text), directed:!isGroup || !!msg?.directToAi});
  }
  // 被冷落：她主动开口后对方长时间不回 → 每次 -8（权重由 wNeglect 控制）
  function affinityNeglect(qq, name, reason) { return null; } // Silence/busyness is not rejection.
  // 覆盖旧版：控制台手动调整走 manualOffset（不破坏幂等）
  function affinityAdjust(qq, name, delta, reason, now = Date.now()) {
    const person = personOf(qq, name, true);
    if (!person) return null;
    const cur = affinityCompute(person);
    const details=affinityBreakdown(person,affinityCfg(),affinityInitialFor(qq,person),now);
    const next = Math.max(details.minimum, Math.min(details.maximum, cur + Number(delta)));
    const a = affCounters(person);
    // Correct the raw offset as well when saturated; adding -5 to hidden overflow used to do nothing.
    if(next!==cur||details.decayApplied>0)a.manualOffset = next-details.initial-details.interactionDelta;
    person.affinityAt = now;
    if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
    person.affinityLog.push({ at: now, delta: Math.round(next - cur), to: Math.round(affinityCompute(person)), reason: String(reason || '手动') });
    if (person.affinityLog.length > 15) person.affinityLog.splice(0, person.affinityLog.length - 15);
    savePersons();
    return { person, value: affinityCompute(person), delta: next - cur };
  }
  // 覆盖旧版：久不联系 → 最多降到"普通"（不会变生人/仇人）
  function autoTierOf(person) {
    const msgs = Number(person?.msgCount) || 0;
    const knownMs = person?.firstSeenAt ? Date.now() - Number(person.firstSeenAt) : 0;
    const days = knownMs / 86400000;
    let id = 'stranger';
    for (const t of tierTable()) {
      if (msgs >= (Number(t.msgs) || 0) && days >= (Number(t.days) || 0)) { id = t.id; break; }
    }
    const idleDays = person?.lastSeenAt ? (Date.now() - Number(person.lastSeenAt)) / 86400000 : 0;
    const coolDays = Number(relationsCfg().coolAfterDays) || 30;
    if (idleDays >= coolDays) {
      const order = ['stranger', 'acquainted', 'normal', 'friendly', 'close', 'best'];
      if (order.indexOf(id) > order.indexOf('normal')) id = 'normal';
    }
    return id;
  }


  // ══ 时间点影响好感度（本机改动 2026-10-07，追加覆盖）══════════════════
  // 用户要求：同一句话在不同时间点说，感受不同 —— 并且**和作息挂钩**（共用同一条曲线）。
  // 设计：时间系数直接由 rhythmHourFactor() 推出，所以改了作息曲线，时间影响自动跟着变。
  function affinityTimeFactor(date = new Date()) {
    const c = affinityCfg();
    if (c.timeEnabled === false) return 1;
    const f = rhythmHourFactor(date);
    const T = c.timeWeight ?? {};
    if (f >= 1.0) return Number(T.high) || 1.3;     // 精神好：好话更值钱
    if (f >= 0.6) return Number(T.normal) || 1.0;   // 正常
    if (f >= 0.3) return Number(T.low) || 0.6;      // 午休/晚饭：打折
    return Number(T.sleep) || 0.25;                 // 深夜/睡觉：几乎不算数
  }
  // 睡觉时段被搭话的"豁免"：熟人半夜找她正常，生人半夜吵她更烦
  function affinitySleepExempt(tierId) {
    const c = affinityCfg();
    const E = c.sleepPenaltyExempt ?? {};
    return Number(E[tierId] ?? 1) || 1;
  }
  function affinityIsSleepNow(date = new Date()) {
    return affinityCfg().timeEnabled !== false && rhythmHourFactor(date) <= (Number(affinityCfg().timeSleepThreshold) || 0.2);
  }
  // 覆盖旧版：记分时乘上时间系数（正向按系数缩放；负向在睡觉时段额外 ×1.5）
  // 并把"睡觉时段被搭话"单独记一个 disturb 计数器（基础惩罚可配，默认 -1）
  function affinityRecord(qq, name, kind, now = Date.now(), opts = {}) {
    const c = affinityCfg();
    if (c.enabled === false || !kind) return null;
    const person = personOf(qq, name, true);
    if (!person) return null;
    const a = affCounters(person);
    const date = new Date(now);
    const tf = affinityTimeFactor(date);
    const sleeping = affinityIsSleepNow(date);
    if (kind === 'normal') {
      const today = Math.floor(now / 86400000);
      if (a.normalDay !== today) { a.normalDay = today; a.normalToday = 0; }
      const dailyMax = Number(c.normalDailyMax) || 10;
      if (a.normalToday >= dailyMax) return null;
      a.normalToday += 1;
    }
    const negative = kind === 'rude' || kind === 'push' || kind === 'spam';
    let amount = tf;
    if (negative && sleeping) amount = tf * (Number(c.sleepNegativeBoost) || 1.5);
    a[kind] = (Number(a[kind]) || 0) + amount;
    // 深夜被搭话的基础惩罚（按关系豁免；@ 或提问减免一半）
    if (sleeping && !negative && c.sleepPenalty !== 0) {
      const tier = relationOf(qq, name).tier;
      const exempt = affinitySleepExempt(tier);
      const direct = opts.directed === true ? 0.5 : 1;
      const base = Number(c.sleepPenalty ?? -1);
      const add = base * exempt * direct * tf;     // tf 在睡觉时段是 0.25，这里用 1 更直观 → 用原来的量级
      const stable = base * exempt * direct;
      a.disturb = (Number(a.disturb) || 0) + stable;
      person.affinityAt = now;
      if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
      person.affinityLog.push({ at: now, kind: 'disturb', to: Math.round(affinityCompute(person)), reason: '睡觉时段被搭话（' + relationOf(qq, name).label + ' 豁免 ×' + exempt + '）' });
      if (person.affinityLog.length > 15) person.affinityLog.splice(0, person.affinityLog.length - 15);
    }
    person.affinityAt = now;
    if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
    person.affinityLog.push({ at: now, kind, to: Math.round(affinityCompute(person)), reason: '互动：' + kind + '（时间 ×' + tf + (sleeping ? ' 睡觉中' : '') + '）' });
    if (person.affinityLog.length > 15) person.affinityLog.splice(0, person.affinityLog.length - 15);
    savePersons();
    return person;
  }
  // 覆盖旧版：把 disturb 也计入总分
  function affinityCompute(person) {
    const c = affinityCfg();
    if (c.enabled === false) return Number(c.initial) || 50;
    const a = affCounters(person);
    const init = affinityInitialFor(person?.qq, person);
    if (!a) return init;
    const w = {
      good: Number(c.wGood) || 2.5,
      gift: Number(c.wGift) || 2,
      fun: Number(c.wFun) || 1.5,
      normal: Number(c.wNormal) || 0.2,
      spam: Number(c.wSpam) || -1.5,
      push: Number(c.wPush) || -2.5,
      rude: Number(c.wRude) || -4,
      neglect: Number(c.wNeglect) || -8,
      disturb: Number(c.wDisturb ?? -1)
    };
    let delta = Number(a.manualOffset) || 0;
    for (const k of Object.keys(w)) delta += (Number(a[k]) || 0) * w[k];
    const cap = Number(c.deltaCap) || 45;
    delta = Math.max(-cap, Math.min(cap, delta));
    return Math.max(0, Math.min(100, init + delta));
  }


  // ── 修正版 affinityRecord（本机改动 2026-10-07：修符号 + 每小时最多一次"被吵醒"）──
  // 旧版 bug：把负号预先乘进了计数器，取值时又乘一次权重 → 负负得正，"被吵醒"反而加分。
  // 现在：计数器只记"次数"（正数），符号完全交给权重（wDisturb = -1）。
  function affinityRecord(qq, name, kind, now = Date.now(), opts = {}) {
    const c = affinityCfg();
    if (c.enabled === false || !kind) return null;
    const person = personOf(qq, name, true);
    if (!person) return null;
    const a = affCounters(person);
    if (['good','gift','fun'].includes(kind)) {
      const day=Math.floor(now/86400000), fingerprint=crypto.createHash('sha256').update(String(opts.text||'').replace(/[\s，。！？!?,.]/g,'')).digest('hex').slice(0,16);
      if(a.positiveDay!==day){a.positiveDay=day;a.positiveToday=0;a.positiveTexts=[];}
      if(a.positiveToday>=3 || (opts.text && (a.positiveTexts||[]).includes(fingerprint))) return null;
      a.positiveToday++; if(opts.text)a.positiveTexts=[...(a.positiveTexts||[]),fingerprint].slice(-3);
    }
    const date = new Date(now);
    const tf = affinityTimeFactor(date);
    const sleeping = affinityIsSleepNow(date);
    if (kind === 'normal') {
      const today = Math.floor(now / 86400000);
      if (a.normalDay !== today) { a.normalDay = today; a.normalToday = 0; }
      const dailyMax = Number(c.normalDailyMax) || 10;
      if (a.normalToday >= dailyMax) return null;
      a.normalToday += 1;
    }
    const negative = kind === 'rude' || kind === 'push' || kind === 'spam';
    let amount = tf;
    if (negative && sleeping) amount = tf * (Number(c.sleepNegativeBoost) || 1.5);
    a[kind] = (Number(a[kind]) || 0) + amount;
    // Ordinary night greetings no longer add disturb penalties; historical data stays intact.
    person.affinityAt = now;
    if (!Array.isArray(person.affinityLog)) person.affinityLog = [];
    person.affinityLog.push({ at: now, kind, to: Math.round(affinityCompute(person)), reason: '互动：' + kind + '（时间 ×' + tf + (sleeping ? ' 睡觉中' : '') + '）' });
    if (person.affinityLog.length > 15) person.affinityLog.splice(0, person.affinityLog.length - 15);
    savePersons();
    return person;
  }
  // 覆盖：disturb 用"次数 × 豁免"折算（而不是把负号混进计数器）
  function affinityCompute(person) {
    const c = affinityCfg();
    if (c.enabled === false) return Number(c.initial) || 50;
    affCounters(person);
    return affinityBreakdown(person,c,affinityInitialFor(person?.qq,person)).value;
  }


  // ══ 追番系统（本机改动 2026-10-07）══════════════════════════════════════
  // 用户要求：状态不能只是"嘴上说说" —— 说在补番就得**真知道在看什么、看到第几集**；
  // 自动模拟每天完成至少一部，手动按集推进仍可使用；不把进度当内容知识。
  // 别人推荐的番可以入库，**按推荐人的关系档决定优先级**；
  // 红线：绝不编剧情 —— 被问细节就现场搜（B站能力），搜不到就说"还没看到那儿"。
  const ANIME_FILE = path.join(ROOT, 'state', 'anime.json');
  const ANIME_CATALOG_FILE = path.join(ROOT, 'state', 'anime-catalog.json');
  let animeState = null;
  function loadAnime() {
    if (animeState) return animeState;
    const raw = readJsonSafe(ANIME_FILE, null);
    animeState = raw && typeof raw === 'object' ? raw : {};
    if (!Array.isArray(animeState.watching)) animeState.watching = [];
    if (!Array.isArray(animeState.queue)) animeState.queue = [];
    if (!Array.isArray(animeState.finished)) animeState.finished = [];
      if (!Array.isArray(animeState.history)) animeState.history = [];
    if (!animeState.day) animeState.day = '';
    if (!Number.isFinite(Number(animeState.advancedToday))) animeState.advancedToday = 0;
    return animeState;
  }
  function saveAnime() { try { atomicWriteJson(ANIME_FILE, loadAnime()); } catch (e) { log('保存追番失败:', e?.message ?? e); } }
  function animeCatalog() {
    const raw = readJsonSafe(ANIME_CATALOG_FILE, null);
    return animeCatalogItems(raw);
  }
  function saveAnimeCatalogV2(raw,items){
    const next=Array.isArray(raw)?items:{...(raw||{}),items};
    if(!Array.isArray(next))delete next.list;
    atomicWriteJson(ANIME_CATALOG_FILE,next);
  }
  function animeCfg() { return cfg.socialV2?.anime ?? {}; }
  function animeSummaryV2(a=loadAnime()){return animeDaySummary(a,{now:Date.now(),target:animeCfg().dailyCompletionTarget});}
  // 跨天重置"今天看了几集"
  function animeRollDay(now = Date.now()) {
    const a = loadAnime();
    const day = localDayKeyStr(new Date(now));
    if (a.day !== day) { a.day = day; a.advancedToday = 0; saveAnime(); }
    return a;
  }
  // 状态：今天在补番吗（由"今日状态"决定；没做状态系统前默认允许）
  function animeCanAdvanceToday() {
    const st = cfg.socialV2?.dailyState?.current ?? '';
    if (!st) return true;
    return st === 'bingeing' || st === 'bored' || st === 'home';
  }
  // 推进一集（核心：像真人一样一天只推进 1~2 集）
  // 记一条"今天看了第几集"（按天历史，供面板柱状图）
  function animeRecordHistory(title, ep, by) {
    try {
      const a = loadAnime();
      if (!Array.isArray(a.history)) a.history = [];
      a.history.push({ day: localDayKeyStr(), title: String(title ?? ''), ep: Number(ep) || 0, at: Date.now(), by: String(by ?? '') });
      if (a.history.length > 400) a.history.splice(0, a.history.length - 400);
    } catch (e) { log('记追番历史失败:', e?.message ?? e); }
  }
  // 包装层：核心推进成功就记一条历史（本机改动 2026-10-07）
  // 用"改名 + 包装"而不是"往函数里插代码"，避免插错分支（上次就插错了）。
  function animeAdvance(reason) {
    const r = animeAdvanceCore(reason);
    if (r && r.ok) { try { animeRecordHistory(r.title, r.watched, reason); } catch {} }
    return r;
  }
  function animeAdvanceCore(reason) {
    const a = animeRollDay();
    const c = animeCfg();
    if (c.enabled === false) return { ok: false, why: '追番已关' };
    if (!animeCanAdvanceToday()) return { ok: false, why: '今天的状态不适合补番（' + (cfg.socialV2?.dailyState?.current ?? '') + '）' };
    const perDayMax = (testActive() ? (Number(testValue('anime.perDayMax', 10)) || 10) : (Number(c.perDayMax) || 2));
    if (a.advancedToday >= perDayMax) return { ok: false, why: '今天已经看了 ' + a.advancedToday + ' 集（上限 ' + perDayMax + '）' };
    const maxWatching = Number(c.maxWatching) || 2;
    // 队列空了 → 从番剧库自动补几部（本机改动：番剧库既是资料库、也是"待看池"）
    if (!a.queue.length) {
      const seenTitles = new Set([...a.watching, ...a.finished].map((x) => String(x?.title)));
      const pool = animeCatalog().filter((x) => !seenTitles.has(String(x.title)));
      const seedCount = Math.min(pool.length, Number(c.seedCount) || 5);
      for (let i = 0; i < seedCount; i += 1) {
        const pickIdx = Math.floor(Math.random() * pool.length);
        const item = pool.splice(pickIdx, 1)[0];
        if (!item) break;
        a.queue.push({ title: item.title, total: Number(item.total) || 12, tags: item.tags ?? [], recommendedBy: null, recommenderTier: null, priority: 30, at: Date.now() });
      }
      if (a.queue.length) log('[追番] 队列见底，从番剧库补了 ' + a.queue.length + ' 部待看');
      saveAnime();
    }
    // 没有在追的 → 从队列里挑一部（按优先级：熟人推荐 > 死党 > 随机）
    if (!a.watching.length) {
      if (!a.queue.length) return { ok: false, why: '队列空了（番剧库也没有可补的）' };
      a.queue.sort((x, y) => (Number(y.priority) || 0) - (Number(x.priority) || 0));
      const pick = a.queue.shift();
      a.watching.push({ title: pick.title, total: Number(pick.total) || 12, watched: 0, tags: pick.tags ?? [], recommendedBy: pick.recommendedBy ?? null, startedAt: Date.now(), lastAt: 0 });
      log('[追番] 开始追：《' + pick.title + '》（' + (pick.recommendedBy ? '由 ' + pick.recommendedBy + ' 推荐' : '自选') + '）');
    }
    const cur = a.watching[0];
    let step = 1 + (Math.random() < 0.3 ? 1 : 0);           // 多数 1 集，偶尔 2 集
    step = Math.max(1, Math.min(step, perDayMax - a.advancedToday));   // 不能顶破每日上限
    cur.watched = Math.min(Number(cur.total) || 12, (Number(cur.watched) || 0) + step);
    cur.lastAt = Date.now();
    a.advancedToday += step;
    // 小概率"弃番"（看了 3~6 集不合胃口）
    const dropRate = Number(c.dropRate) || 0.08;
    if (cur.watched >= 3 && cur.watched <= 6 && Math.random() < dropRate) {
      a.watching = a.watching.filter((x) => x !== cur);
      a.finished.push({ title: cur.title, total: cur.total, watched: cur.watched, dropped: true, at: Date.now() });
      log('[追番] 弃番：《' + cur.title + '》（看到第 ' + cur.watched + ' 集）');
      saveAnime();
      return { ok: true, dropped: true, title: cur.title, watched: cur.watched };
    }
    // 追完了 → 换下一部
    if (cur.watched >= Number(cur.total || 12)) {
      a.watching = a.watching.filter((x) => x !== cur);
      a.finished.push({ title: cur.title, total: cur.total, watched: cur.watched, dropped: false, at: Date.now() });
      log('[追番] 看完：《' + cur.title + '》全 ' + cur.total + ' 集');
    }
    saveAnime();
    return { ok: true, title: cur.title, watched: cur.watched, total: cur.total, today: a.advancedToday };
  }
  // 别人推荐一部番（按推荐人关系档定优先级）
  function animeRecommend(title, qq, name, total) {
    const a = loadAnime();
    const c = animeCfg();
    if (c.enabled === false) return { ok: false, why: '追番已关' };
    const t = String(title ?? '').trim();
    if (!t) return { ok: false, why: '需要番名' };
    const tier = relationOf(qq, name);
    const prio = { best: 100, close: 80, friendly: 60, normal: 40, acquainted: 20, stranger: 10, disliked: 5, hated: 0 }[tier.tier] ?? 30;
    const exist = [...a.queue, ...a.watching, ...a.finished].some((x) => x && String(x.title) === t);
    if (exist) return { ok: false, why: '已经在库里了', title: t };
    const known = animeCatalog().find((x) => x.title === t);
    a.queue.push({ title: t, total: Number(total) || Number(known?.total) || 12, tags: known?.tags ?? [], recommendedBy: qq ? String(qq) : (name ?? null), recommenderTier: tier.label, priority: prio, at: Date.now() });
    saveAnime();
    log('[追番] 收到推荐：《' + t + '》（来自 ' + (name || qq) + '，' + tier.label + '，优先级 ' + prio + '）');
    return { ok: true, title: t, priority: prio, tier: tier.label };
  }
  // 注入给她的"追番现状"（她据此说话，**不许编剧情**）
  function animeMoodText() {
    if (animeCfg().enabled === false) return '';
    const a = loadAnime();
    const titles = (a.watching || []).slice(0, 2).map(w => '《' + w.title + '》');
    const completed = (a.finished || []).filter(x=>!x.dropped).slice(-2).map(x=>'《'+x.title+'》').join('、');
    return '【番剧兴趣与模拟进度】' + (titles.length ? '当前兴趣队列：' + titles.join('、') : '暂无兴趣队列')
      + (completed?'；最近模拟完成：'+completed:'') + '。记录里的 watched/finished 是角色模拟进度，自动增加数字没有观看或阅读依据；不能说亲身看完、今天看了几集。讨论细节先取到资料，说明是简介、字幕或评论；未知就说尚未取得内容。';
  }

  // ══ 今日状态（本机改动 2026-10-07）══════════════════════════════════════
  // 用户要求：作息是"几点"、话痨是"今天话多话少"，还缺"今天在干嘛" —— 三样凑齐她才像有生活。
  // 状态决定：① 唤醒系数 ② 主动搭话 ③ 能不能补番 ④ 语气。
  const DAILY_STATES = [
    { id: 'bored', label: '无聊到发霉', weight: 0.12, wake: 1.25, proactive: 1.5, canAnime: true, text: '你今天无聊得发慌，见谁都想说两句。' },
    { id: 'bingeing', label: '在补番', weight: 0.18, wake: 1.0, proactive: 0.8, canAnime: true, text: '你今天在补番，一边看一边想找人聊两句剧情。' },
    { id: 'home', label: '宅家', weight: 0.30, wake: 1.0, proactive: 1.0, canAnime: true, text: '' },
    { id: 'bad_sleep', label: '没睡好', weight: 0.12, wake: 0.6, proactive: 0.5, canAnime: true, text: '你昨晚没睡好，今天有点蔫：回复短、别硬撑。' },
    { id: 'busy', label: '有点忙', weight: 0.16, wake: 0.5, proactive: 0.3, canAnime: false, text: '你今天有点忙，看手机的时间不多。' },
    { id: 'out', label: '出门了', weight: 0.12, wake: 0.35, proactive: 0.2, canAnime: false, text: '你今天出门了，在外面晃，很少看手机。' }
  ];
  const DAILY_STATE_FILE = path.join(ROOT, 'state', 'daily-state.json');
  let dailyStateCache = null;
  function dailyState() {
    const c2 = cfg.socialV2?.dailyState ?? {};
    if (c2.enabled === false) return null;
    const today = localDayKeyStr();
    if (dailyStateCache && dailyStateCache.day === today) return dailyStateCache;
    let saved = null;
    try { saved = readJsonSafe(DAILY_STATE_FILE, null); } catch {}
    if (saved && saved.day === today && DAILY_STATES.some((x) => x.id === saved.id)) {
      dailyStateCache = saved;
      return saved;
    }
    const pool = DAILY_STATES;
    const totalW = pool.reduce((a, b) => a + (Number(b.weight) || 0), 0);
    let roll = Math.random() * totalW;
    let picked = pool[pool.length - 1];
    for (const s of pool) { roll -= Number(s.weight) || 0; if (roll <= 0) { picked = s; break; } }
    dailyStateCache = { day: today, id: picked.id, label: picked.label, at: Date.now() };
    try { atomicWriteJson(DAILY_STATE_FILE, dailyStateCache); } catch {}
    log('[每日] 今天的状态：' + picked.label);
    return dailyStateCache;
  }
  function dailyStateMeta() {
    const s = dailyState();
    if (!s) return null;
    return DAILY_STATES.find((x) => x.id === s.id) ?? null;
  }
  function dailyStateWakeFactor() { const m = dailyStateMeta(); return m ? Number(m.wake) || 1 : 1; }
  function dailyStateProactiveFactor() { const m = dailyStateMeta(); return m ? Number(m.proactive) || 1 : 1; }
  function dailyStateMoodText() {
    const m = dailyStateMeta(); if (!m) return '';
    return '【角色模拟状态】' + m.label + '。这只用于调整愿意聊天的程度和语气，没有真实线下活动或睡眠依据；不要声称今天出门、昨晚没睡好、亲身补完番。可以表达当下想聊天或少说几句，不把模拟状态当经历。';
  }
  // Independent background schedule; GET endpoints never advance progress.
  let animeAutoStatus={phase:'pending',lastCheckAt:0,reason:'等待后台检查'};
  function animeBackgroundEligibilityV2(){
    if(animeCfg().enabled===false)return '追番已关闭';
    if(currentMode!=='reserved2'||socialV2.paused||readRoleState().mode==='silent')return '机器人暂停、静默或当前模式未启用';
    if(!dshReady)return '等待 DSH 就绪';
    if(testActive()||groupRehearsals.size||privateDialogueTests.size)return '隔离验收期间暂不推进全局追番';
    if(rhythmIsSleeping())return '当前低活动时段，醒来后继续';
    return '';
  }
  function animeAutomationStatusV2(){
    const summary=animeSummaryV2();
    const blocked=animeBackgroundEligibilityV2();
    return {...summary,phase:summary.goalMet?'completed':blocked?'waiting':animeAutoStatus.phase==='error'?'error':'pending',
      reason:summary.goalMet?'今日目标已完成':blocked||animeAutoStatus.reason,lastCheckAt:animeAutoStatus.lastCheckAt,
      lastRunAt:Number(loadAnime().lastAutoAt)||0,simulation:true};
  }
  function animeAutoAdvanceToday(){
    const blocked=animeBackgroundEligibilityV2();
    if(blocked){animeAutoStatus={phase:'waiting',reason:blocked,lastCheckAt:Date.now()};return {ok:false,why:blocked};}
    try{
      const advance=advanceAnimeDaily(loadAnime(),{now:Date.now(),target:animeCfg().dailyCompletionTarget,catalog:animeCatalog(),maxWatching:animeCfg().maxWatching,seedCount:animeCfg().seedCount});
      if(advance.changed){
        // Commit before replacing the in-memory state; failed writes remain retryable.
        atomicWriteJson(ANIME_FILE,advance.state);animeState=advance.state;
        log('[追番] 每日模拟完成 '+advance.result.completed+' 部，推进 '+advance.result.episodes+' 集；今日 '+advance.result.completedToday+'/'+advance.result.target+' 部');
      }
      animeAutoStatus={phase:advance.result.goalMet?'completed':'pending',reason:advance.result.why,lastCheckAt:Date.now()};
      return advance.result;
    }catch(error){animeAutoStatus={phase:'error',reason:'追番进度未保存，等待下次重试',lastCheckAt:Date.now()};log('[追番] 自动推进未保存:',error?.message??error);return {ok:false,why:animeAutoStatus.reason};}
  }

  // ══ 她自己的梗（本机改动 2026-10-07）════════════════════════════════════
  // 用户要求：群里最有辨识度的是"她自己的叫法"。三件事：
  //   ① 口头禅：从她自己说过的话里自动发现高频短语（纯字符串统计，零模型调用）
  //   ② 外号：关系 ≥「熟络」才起，起了就**一直用**；仇人/讨厌 → 阴阳外号
  //   ③ 注入：让她自然复用（一场对话同一个梗最多 1~2 次，别硬塞）
  const MEMES_FILE = path.join(ROOT, 'state', 'memes.json');
  let memesState = null;
  function loadMemes() {
    if (memesState) return memesState;
    const raw = readJsonSafe(MEMES_FILE, null);
    memesState = raw && typeof raw === 'object' ? raw : {};
    if (!Array.isArray(memesState.global)) memesState.global = [];
    if (!memesState.byTarget || typeof memesState.byTarget !== 'object') memesState.byTarget = {};
    return memesState;
  }
  function saveMemes() { try { atomicWriteJson(MEMES_FILE, loadMemes()); } catch (e) { log('保存梗库失败:', e?.message ?? e); } }
  function memesCfg() { return cfg.socialV2?.memes ?? {}; }
  function consoleNicknameV2(target){
    return nicknameSnapshot(socialV2.personContinuity,loadMemes(),String(target),{allowed:source=>isSessionAllowedInCurrentMode(source)});
  }
  // ① 自动发现口头禅：扫她自己发过的**短句**（≤10 字），出现 ≥3 次的收进梗库
  function memeScanRecent() {
    const c = memesCfg();
    if (c.enabled === false) return 0;
    const m = loadMemes();
    const counts = new Map();
    const origins = new Map();
    for (const [key, st] of socialV2.conversations ?? []) {
      if (EPHEMERAL_GROUP_KEYS.has(key)||!key.startsWith('group:')||!isSessionAllowedInCurrentMode(key)) continue;
      for (const msg of (st.recentMessages ?? [])) {
        if (!msg || !msg.isSelf) continue;
        const txt = String(msg.text || msg.plain || '').replace(/[\s\n]+/g, '').replace(/[。，！？~～]+$/g, '');
        if (!txt || txt.length > 10 || txt.length < 2) continue;
        if (/^[\d.]+$/.test(txt)) continue;
        counts.set(txt, (counts.get(txt) || 0) + 1);
        if(!origins.has(txt))origins.set(txt,new Set());origins.get(txt).add(key);
      }
    }
    let added = 0;
    let changed = false;
    const minUse = Number(c.minUsage) || 3;
    for (const [txt, n] of counts) {
      if (n < minUse) continue;
      const exist = m.global.find((x) => x.text === txt);
      const sourceKeys=[...origins.get(txt)];
      if (exist) {const usage=Math.max(Number(exist.usage)||0,n);if(usage!==exist.usage||exist.source==='自创'&&JSON.stringify(exist.sourceKeys)!==JSON.stringify(sourceKeys)){exist.usage=usage;exist.lastAt=Date.now();if(exist.source==='自创')exist.sourceKeys=sourceKeys;changed=true;}continue;}
      m.global.push({ text: txt, usage: n, source: '自创',sourceKeys, firstAt: Date.now(), lastAt: Date.now() });
      added += 1;
    }
    if (added||changed)saveMemes();if(added)log('[梗] 从她自己的话里发现 ' + added + ' 个口头禅');
    return added;
  }
  // ② 外号生成（纯规则）
  function nicknameCandidates(name) {
    const s = String(name || '').trim();
    if (!s || s.length < 2) return [];
    const out = [];
    // 取重复字（叱咤月海鱼鱼猫 → 鱼鱼）
    const rep = s.match(/(.)\1/);
    if (rep) out.push(rep[0]);
    // 取后半两字 + 子（风间琉璃 → 琉璃子）
    if (s.length >= 3) out.push(s.slice(-2) + '子');
    // 小 + 末字（七月晚风凉 → 小凉）
    out.push('小' + s.slice(-1));
    // 取后两字（七月晚风凉 → 风凉）
    if (s.length >= 4) out.push(s.slice(-2));
    return [...new Set(out)].filter((x) => x && x !== s && x.length >= 2 && x.length <= 4);
  }
  // 仇人/讨厌 → 阴阳外号
  function snarkyNickname(name) {
    const pool = ['这位大聪明', '那位高玩', '大师', '懂哥', '专家'];
    return pool[Math.abs(String(name || '').length) % pool.length];
  }
  // 取某人的外号（没有就按关系决定要不要起一个 —— 起了就固定）
  function memeNicknameFor(qq, name, opts = {}) {
    const c = memesCfg();
    if (c.enabled === false) return null;
    const q = String(qq ?? '').trim();
    if (!q) return null;
    if(opts.key&&hasPersonAliasV2(opts.key,q))return nicknameSnapshot(personContinuityStoreV2(opts.key),loadMemes(),q,{key:opts.key,allowed:source=>source===opts.key||isSessionAllowedInCurrentMode(source)}).current?.text||null;
    const m = loadMemes();
    if (!Array.isArray(m.byTarget[q])) m.byTarget[q] = [];
    const nick = m.byTarget[q].find((x) => x.kind === 'nickname');
    if (nick) return nick.text;
    if (opts.force !== true) {
      const rel = relationOf(q, name);
      const minTier = String(c.nicknameMinTier || 'friendly');
      const order = ['stranger', 'acquainted', 'normal', 'friendly', 'close', 'best'];
      const isNeg = rel.tier === 'hated' || rel.tier === 'disliked';
      if (!isNeg) {
        if (order.indexOf(rel.tier) < order.indexOf(minTier)) return null;   // 不够熟，先不起
      }
      if (Math.random() > (Number(c.nicknameChance) || 0.35)) return null;    // 小概率才起
    }
    const rel2 = relationOf(q, name);
    const person2 = personOf(q, name, false);
    // 本机改动：用"六类来源"的候选池，随机挑一个（不是永远取第一个）
    const pool = nicknameCandidatesV2(name, person2, q);
    const cand = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    const text = (rel2.tier === 'hated' || rel2.tier === 'disliked')
      ? snarkyNickname(name)
      : (cand?.text || null);
    if (!text) return null;
    m.byTarget[q].push({ text, kind: 'nickname', usage: 0, since: Date.now(), mood: rel2.label, source: (rel2.tier === 'hated' || rel2.tier === 'disliked') ? '关系:阴阳' : (cand?.source ?? '未知') });
    saveMemes();
    log('[梗] 给 ' + (name || q) + ' 起了外号：' + text + '（' + rel2.label + '）');
    return text;
  }
  // ③ 注入
  function memesMoodText(st = null,key='') {
    const c = memesCfg();
    if (c.enabled === false) return '';
    if (st && expressionContext(st) !== 'casual') return '';
    memeScanRecent();
    const m = loadMemes();
    const phrases = selectMemePhrases(m.global.filter(x=>x.source!=='自创'||(x.sourceKeys||[]).includes(key)), st, Number(c.maxPhrases) || 5);
    const nicks = [];
    for (const [q, arr] of Object.entries(m.byTarget)) {
      if (st && (!(st.recentMessages || []).some(x => String(x.userId) === q) || expressionTargets(st.expressionQuietTargets).includes(q))) continue;
      for (const x of arr) {
        if (x.kind !== 'nickname') continue;
        if(key&&hasPersonAliasV2(key,q))continue;
        const person = personOf(q, null, false);
        nicks.push((person?.name || q) + ' → 「' + x.text + '」（' + (x.mood || '') + (x.source ? '，' + x.source : '') + '）');
      }
    }
    const bits = [];
    if (phrases.length) bits.push('可选且近期未重复的梗：' + phrases.map((x) => '「' + x.text + '」(用过' + (x.usage || 0) + '次)').join('、'));
    if (nicks.length) bits.push('你给别人起的外号：' + nicks.slice(0, 6).join('；') + ' —— 只在对方接受且适合时使用，拒绝就停止');
    if (!bits.length) return '';
    return '【你自己的梗】' + bits.join('。') + '。⚠️ 自然复用，别硬塞：一场对话里同一个梗最多 1~2 次。';
  }


  // ── 外号 v2（本机改动 2026-10-07，用户要求：别只按昵称起）────────────────
  // 候选来源从"只有名字"扩到六类：
  //   ① 名字变形  ② 她的印象（facts）  ③ 你常说的词  ④ 行为特征（话多/夜里活跃/爱发表情）
  //   ⑤ 关系语气（熟人亲昵 / 生人客气 / 仇人阴阳）  ⑥ 她自己的梗与追番角色
  // 每一项都带 source，控制台能看到"为什么这么叫"。
  const NICK_FEATURE_MAP = [
    { kw: ['猫', '喵'], out: ['猫哥', '猫猫', '铲屎的'] },
    { kw: ['狗', '汪', '柴'], out: ['狗子', '汪星人'] },
    { kw: ['游戏', '打游戏', '上分', '排位'], out: ['游戏佬', '上分侠'] },
    { kw: ['番', '动画', '动漫', '二次元'], out: ['老二刺猿', '番哥'] },
    { kw: ['加班', '工作', '上班', '老板'], out: ['打工人', '社畜哥'] },
    { kw: ['吃', '饭', '外卖', '饿'], out: ['干饭人', '饭桶'] },
    { kw: ['睡', '困', '熬夜', '失眠'], out: ['夜猫子', '熬夜冠军'] },
    { kw: ['代码', '编程', 'bug', '程序'], out: ['修bug的', '码农'] },
    { kw: ['图', '表情包', '存图'], out: ['图王', '存图机器'] },
    { kw: ['唱歌', '音乐', '歌'], out: ['点歌机', '耳机哥'] }
  ];
  // 从"她对这个人的印象 + 他常说的话"里抽特征
  function nicknameFeatureWords(person, talkWords) {
    const bag = [];
    for (const f of (person?.facts ?? [])) bag.push(String(f?.text??f));
    // Automatic nicknames can appear in groups; private facts are never source material.
    for (const w of (talkWords ?? [])) bag.push(String(w));
    const text = bag.join(' ');
    const out = [];
    for (const rule of NICK_FEATURE_MAP) {
      if (rule.kw.some((k) => text.includes(k))) out.push(...rule.out);
    }
    // 他最爱说的词（2~4 字）也能当特征
    for (const w of (talkWords ?? []).slice(0, 2)) if (w.length >= 2 && w.length <= 3) out.push(w + '哥');
    return [...new Set(out)];
  }
  // 统计某人常说的词（纯字符串统计，扫最近消息）
  function topWordsOf(qq, limit = 3) {
    const counts = new Map();
    for (const [sourceKey, st2] of socialV2.conversations ?? []) {
      if(!sourceKey.startsWith('group:')||!isSessionAllowedInCurrentMode(sourceKey))continue;
      for (const m of (st2.recentMessages ?? [])) {
        if (!m || m.isSelf || String(m.userId ?? '') !== String(qq)) continue;
        const txt = String(m.text || m.plain || '');
        // 2~4 字的中文片段（粗粒度，够用）
        for (const w of txt.match(/[\u4e00-\u9fff]{2,4}/g) ?? []) counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
    // 本机改动：过滤掉"谁都说的词"和"别人名字里的词"，只留有特征性的
    const STOP = new Set(['图片', '表情', '表情包', '引用', '哈哈', '什么', '怎么', '这个', '那个', '没有', '可以', '就是', '不是', '但是', '所以', '然后', '小鲸鱼', '鲸鱼', '群主', '大家', '兄弟', '真的', '有点', '感觉', '知道', '一下', '一个', '问题', '东西']);
    const otherNames = [...Object.values(loadPersons().people ?? {})].map((p) => p?.name).filter(Boolean);
    for (const cand of otherNames) for (const w of (String(cand).match(/[\u4e00-\u9fff]{2,4}/g) ?? [])) STOP.add(w);
    return [...counts.entries()]
      .filter(([w, n2]) => n2 >= 3 && !STOP.has(w) && !otherNames.some((nm) => String(nm).includes(w)))
      .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
  }
  function nicknameCandidatesV2(name, person, qq) {
    const out = [];
    const push = (text, source) => { if (text && text !== name && text.length >= 1 && text.length <= 6) out.push({ text, source }); };
    // ① 名字变形
    const s = String(name || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').trim();   // 先清洗标点，避免出现「爹！子」这种
    if (s.length >= 2) {
      const rep = s.match(/(.)\1/);
      if (rep) push(rep[0], '名字:重复字');
      if (s.length >= 3) push(s.slice(-2) + '子', '名字:后两字+子');
      push('小' + s.slice(-1), '名字:小+末字');
      if (s.length >= 4) push(s.slice(-2), '名字:后两字');
      if (/^[A-Za-z]+$/.test(s)) push(s.slice(0, 4), '名字:英文缩写');
    }
    // ② 她的印象 + ③ 你常说的词
    const words = topWordsOf(qq, 3);
    for (const w of nicknameFeatureWords(person, words)) push(w, '特征:' + w);
    // ④ 行为特征
    const msgs = Number(person?.msgCount) || 0;
    if (msgs >= 300) push('话痨', '行为:话特别多');
    else if (msgs >= 80) push('常客', '行为:来得勤');
    // ⑤ 关系语气
    const rel = qq ? relationOf(qq, name) : { tier: 'normal' };
    if (rel.tier === 'hated' || rel.tier === 'disliked') {
      for (const x of ['这位大聪明', '那位高玩', '大师', '懂哥', '专家']) push(x, '关系:阴阳');
    } else if (rel.tier === 'close' || rel.tier === 'best') {
      push('老' + (s.slice(-1) || ''), '关系:老X');
      push('阿' + (s.slice(-1) || ''), '关系:阿X');
    }
    // ⑥ 她自己的梗 / 追番角色
    try {
      const m = loadMemes();
      for (const g of (m.global ?? []).slice(0, 3)) if (g.text.length <= 4) push(g.text + '哥', '她的梗');
    } catch {}
    try {
      const a = loadAnime();
      for (const w of (a.watching ?? []).slice(0, 2)) {
        const ch = String(w.title).replace(/[《》!！]/g, '').slice(-2);
        if (ch) push(ch, '追番角色');
      }
    } catch {}
    // 去重
    const seen = new Set(); const uniq = [];
    for (const x of out) { if (seen.has(x.text)) continue; seen.add(x.text); uniq.push(x); }
    return uniq;
  }


  // ── 统一显示名（本机改动 2026-10-07，用户要求）──────────────────────────
  // 规矩：**人 → QQ 真实昵称**（不是群名片）；**群 → 群名**；号码只作附带。
  // 数据来自 OneBot 的好友列表与群列表（带缓存，30 分钟刷新一次，失败不影响功能）。
  let contactCache = { at: 0, friends: {}, groups: {} };
  const strangerNames = {};   // 非好友的真实昵称（get_stranger_info），进程内缓存
  // 手动指定的显示名（控制台可改）—— 优先级最高，用来纠正"自动拿到的名字不对"的情况
  const MANUAL_NAMES_FILE = path.join(ROOT, 'state', 'manual-names.json');
  let manualNames = null;
  function loadManualNames() {
    if (manualNames) return manualNames;
    const raw = readJsonSafe(MANUAL_NAMES_FILE, null);
    manualNames = raw && typeof raw === 'object' ? raw : {};
    return manualNames;
  }
  function saveManualNames() { try { atomicWriteJson(MANUAL_NAMES_FILE, loadManualNames()); } catch {} }
  function manualNameFor(qq) { return loadManualNames()[String(qq ?? '')] ?? null; }
  function setManualName(qq, name) {
    const m = loadManualNames();
    const q = String(qq ?? '').trim();
    if (!q) return null;
    if (name === null || String(name).trim() === '') delete m[q];
    else m[q] = String(name).trim().slice(0, 40);
    saveManualNames();
    return m[q] ?? null;
  }
  // 非好友（群友）也能拿真实昵称 —— 用户要求"人用真实昵称，不是群昵称"
  async function resolveStrangerName(qq) {
    const q = String(qq ?? '').trim();
    if (!q) return null;
    if (strangerNames[q]) return strangerNames[q];
    try {
      const r = await bot.request('get_stranger_info', { user_id: Number(q), no_cache: false });
      const info = r?.data ?? r;
      const nm = String(info?.nickname ?? '').trim();
      if (nm) { strangerNames[q] = nm; log('[显示名] 陌生人昵称 ' + q + ' → ' + nm); return nm; }
    } catch (e) { /* 拿不到就退回群名片 */ }
    return null;
  }
  async function refreshContactCache(force = false) {
    const nowMs = Date.now();
    if (!force && contactCache.at && nowMs - contactCache.at < 30 * 60 * 1000) return contactCache;
    try {
      const fl = await bot.request('get_friend_list', {});
      const friends = {};
      for (const f of (Array.isArray(fl) ? fl : (fl?.data ?? []))) {
        const q = String(f?.user_id ?? '');
        // 用户明确要求：**用真实昵称，不要备注** —— 所以这里不取 remark
        if (q) friends[q] = String(f?.nickname ?? '').trim();
      }
      let groups = { ...(contactCache.groups ?? {}) };
      try {
        const gl = await bot.request('get_group_list', {});
        for (const g of (Array.isArray(gl) ? gl : (gl?.data ?? []))) {
          const id = String(g?.group_id ?? '');
          if (id) groups[id] = String(g?.group_name ?? '').trim();
        }
      } catch (e) { log('拉群列表失败:', e?.message ?? e); }
      contactCache = { at: nowMs, friends, groups };
      log('[显示名] 已刷新：好友 ' + Object.keys(friends).length + ' 个、群 ' + Object.keys(groups).length + ' 个');
    } catch (e) { log('拉好友列表失败（显示名退回旧值）:', e?.message ?? e); contactCache.at = nowMs; }
    return contactCache;
  }
  function displayNameForPerson(qq, fallbackName) {
    const q = String(qq ?? '').trim();
    const c2 = contactCache.friends ?? {};
    // 优先级：⓪ 手动指定（控制台）① get_stranger_info 真名 ② 好友列表昵称 ③ 档案名 ④ QQ
    // 注意：**绝不使用"备注(remark)"** —— 用户要求显示真实昵称
    const mn = q ? manualNameFor(q) : null;
    if (mn) return mn;
    if (q && strangerNames[q]) return strangerNames[q];
    if (q && c2[q]) return c2[q];
    if (fallbackName) return String(fallbackName);      // ② 档案里的名字（可能是群名片）
    return q || '未知';
  }
  function displayNameForKey(key) {
    const k = String(key ?? '');
    if (k.startsWith('group:')) {
      const gid = k.split(':')[1];
      const nm = (contactCache.groups ?? {})[gid];
      return { display: nm || ('群 ' + gid), sub: gid, kind: 'group' };
    }
    if (k.startsWith('private:')) {
      const qq = k.split(':')[1];
      return { display: (() => { try { const ppl = loadPersons().people ?? {}; const p0 = ppl["qq:" + qq] ?? Object.values(ppl).find((x) => String(x?.qq) === qq); const pn = String(p0?.name ?? "").trim(); return pn || displayNameForPerson(qq, null) || qq; } catch { return displayNameForPerson(qq, null) || qq; } })(), sub: qq, kind: "private" };
    }
    return { display: k, sub: '', kind: 'other' };
  }
  // 控制台用：一次性拿到所有显示名
  async function displayNameTable() {
    const out = { people: {}, keys: {} };
    // 给"不在好友列表里"的人补真实昵称（群友常见）
    for (const p of Object.values(loadPersons().people ?? {})) {
      if (p?.testData || !p?.qq) continue;
      await resolveStrangerName(p.qq);   // 好友也查一次：好友列表给的可能是备注
    }
    for (const [id, p] of Object.entries(loadPersons().people ?? {})) {
      if (p?.testData) continue;
      const qq = String(p.qq ?? '');
      if (!qq) continue;
      out.people[qq] = { display: displayNameForPerson(qq, p.name), sub: qq, card: p.name ?? null, manual: manualNameFor(qq) };
    }
    for (const k of (socialV2.conversations?.keys?.() ?? [])) {
      const d = displayNameForKey(k);
      out.keys[k] = { display: d.display, sub: d.sub, kind: d.kind };
    }
    return out;
  }


  // ── 发空间的素材（本机改动 2026-10-07，用户要求）────────────────────────
  // 她发空间/改资料时，手里的"料"应该是真实的东西：在追的番、今天的状态、对熟人的印象。
  // 这里把这些拼成一行，供她发空间时取用（不编、不重复、只给能对外说的）。
  function qzoneMaterialText() {
    if (cfg.socialV2?.self?.enabled === false) return '';
    const p = selfActionPolicy(selfCfg());
    return '【自己的空间与资料】只写有依据的自身观点或实际取得资料后的感想；读到字幕不等于看过画面。每日状态、番剧自动进度、示例都不是亲身经历。不得搬运私聊内容、人物档案、群友姓名或外号；没有可公开内容就不发。先用 qq_self_profile 看自己的历史与当前策略，避免重复。当前策略：空间' + (p.qzoneRequiresApproval ? '先交草稿审批' : '直接发布') + '；昵称' + (p.nicknameRequiresApproval ? '先审批' : '直接修改') + '；空间/资料每日上限 ' + p.qzoneMaxPerDay + '/' + p.profileMaxPerDay + '（0 表示不限次数，上限不是任务）。只有返回 verified=true 才报告已核验；结果未确认时不重复提交。';
  }

  // ══ 加速测试模式（本机改动 2026-10-07）══════════════════════════════════
  // 目的：把"要等几小时/几天"的行为压缩到几分钟内可验证。
  // **硬隔离**（用户要求：测试的归测试，不能影响真实的人和群）：
  //   ① 只在 scope 里的会话生效（默认只有测试群）；
  //   ② 主动搭话在测试模式下**只对 scope 内的会话**发起，绝不碰真实群/私聊；
  //   ③ 对外动作（空间/改资料）测试时默认 **dry-run** —— 只记录"她本来会发什么"，不真的发；
  //   ④ 带过期时间（until），到点自动失效，不可能忘了关；
  //   ⑤ 加速期间**不动真人档案**：注入的人带 testData 标记，天然不进面板/不影响真人。
  let testRunLog = null;
  function testCfg() { return cfg.socialV2?.debug?.test ?? {}; }
  function testActive(now = Date.now()) {
    const t = testCfg();
    if (t.enabled !== true) return false;
    if (Number(t.until) && now > Number(t.until)) return false;   // 自动过期
    return true;
  }
  function testScope() {
    const t = testCfg();
    return Array.isArray(t.scope) ? t.scope.filter(k => /^(group|private):\d+$/.test(String(k))) : [];
  }
  function testAppliesTo(key) { return testActive() && testScope().includes(String(key)); }
  function testValue(path, fallback) {
    // 从 socialV2.debug.test.overrides 里按点号取值（没配就用原值）
    const ov = testCfg().overrides ?? {};
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), ov);
    return v === undefined ? fallback : v;
  }
  // 采样记录：测试期间每 30 秒记一次"她真的做了什么"
  function testLogWrite(kind, data) {
    if (!testActive()) return;
    try {
      const dir = path.join(ROOT, 'state', 'test-runs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, (testCfg().runId || 'run') + '.jsonl');
      fs.appendFileSync(f, JSON.stringify({ t: Date.now(), kind, ...data }) + '\n');
    } catch {}
  }
  function testStartSampler() {
    if (globalThis.__testSampler) return;
    globalThis.__testSampler = setInterval(() => {
      if (!testActive()) return;
      try {
        const a = loadAnime();
        const w = a.watching?.[0];
        const pro = [];
        for (const [k, stP] of socialV2.conversations ?? []) {
          pro.push({ key: k, proactiveToday: Number(stP.proactiveToday) || 0, lastAiReplyAt: Number(stP.lastAiReplyAt) || 0 });
        }
        testLogWrite('sample', {
          anime: w ? { title: w.title, watched: w.watched, total: w.total } : null,
          animeToday: a.today,
          convs: pro
        });
      } catch {}
    }, 30000);
    try { globalThis.__testSampler.unref?.(); } catch {}
  }


  // ══ 称呼判定：这句话是不是在跟她说？（本机改动 2026-10-07 用户要求）══════
  // 解决"没有 @ 但明显是在跟她说话"的问题。返回 { score, reasons }：
  //   score ≥ 0  → 当作唤醒概率的下限（判断是在跟她说话）
  //   score < 0   → 表示"明显在跟别人说"，把概率压到最低
  function addresseeScore(st, key, event) {
    const reasons = [];
    let score = 0.05;                       // 基础
    const text = String(event?.raw_message ?? event?.message ?? event?.text ?? event?.msg ?? '');
    const plain = text.replace(/\[CQ:[^\]]+\]/g, ' ');
    const fromId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const others = recent.filter((m) => m && !m.isSelf);
    const selfs = recent.filter((m) => m && m.isSelf);
    const incomingId = String(event?.message_id ?? event?.msg_id ?? '');
    const prior = recent.filter(m => !incomingId || String(m.messageId || '') !== incomingId);
    const last = prior.at(-1);

    // ── ① 接续性：最后一条是她说的？（真人对话最基本的"轮到你了"）
    const lastSelf = last && last.isSelf;
    const gapMs = last ? (Date.now() - Number(last.time ?? 0)) : Infinity;
    if (lastSelf && gapMs < 30000) { score += 0.5; reasons.push('她刚说完话(' + Math.round(gapMs / 1000) + '秒前)+0.5'); }
    else if (lastSelf && gapMs < 120000) { score += 0.3; reasons.push('她2分钟内说过话+0.3'); }
    // 期间有没有第三个人插话（有 → 可能不是对她说）
    const between = recent.filter((m) => m && !m.isSelf && Number(m.time ?? 0) > Number(last?.time ?? 0));
    if (lastSelf && !between.length) { score += 0.1; reasons.push('中间没人插话+0.1'); }

    // ── ② 排除法：明显在跟别人说 → 直接判负
    const atOthers = [...text.matchAll(/\[CQ:at,qq=(\d+)/g)].map((m) => m[1]).filter(q => q !== String(event?.self_id ?? ''));
    if (event?.self_id && text.includes('[CQ:at,qq=' + event.self_id)) return { score: 1, reasons: ['明确@她'] };
    const persons = Object.values(loadPersons().people ?? {});
    const memes = (() => { try { return loadMemes(); } catch { return { byTarget: {} }; } })();
    const nickOf = (q2) => ((memes.byTarget?.[String(q2)] ?? []).find((x) => x.kind === 'nickname')?.text) || '';
    if (atOthers.length) { return { score: 0.3, reasons: ['@了别人 → 只起哄/补充(0.3)'] }; }
    for (const p of persons) {
      const q2 = String(p.qq ?? '');
      if (!q2 || q2 === fromId) continue;
      const names = [p.name, nickOf(q2), displayNameForPerson(q2, null)].filter(Boolean).map(String);
      for (const nm of names) {
        if (nm.length >= 2 && plain.slice(0, 12).includes(nm)) { return { score: 0.3, reasons: ['开头叫的是「' + nm + '」→ 只起哄(0.3)'] }; }
      }
    }
    // 明显在回答另一个人（引用了别人的消息）
    if (/\[CQ:reply/.test(text)) {
      const quotedSelf = recent.some((m) => m && m.isSelf && String(m.messageId ?? '') === String((text.match(/\[CQ:reply,id=(-?\d+)/) ?? [])[1] ?? ''));
      if (!quotedSelf) { score -= 0.2; reasons.push('引用的不是她的话-0.2'); }
    }

    // ── ③ 句式信号
    if (/[你妳您]|你们|咱/.test(plain)) { score += 0.2; reasons.push('用了第二人称+0.2'); }
    if (/(帮我|你看|你觉得|你说|要不要|来一个|说句话|说两句|在吗|在不在|出来|理我|聊聊)/.test(plain)) { score += 0.25; reasons.push('请求/招呼句式+0.25'); }
    if (/[?？]/.test(plain)) { score += 0.15; reasons.push('带问号+0.15'); }
    // 话题重合：她最近说过的话里的词出现在这条消息里
    try {
      const selfText = selfs.slice(-3).map((m) => String(m.text || m.plain || '')).join(' ');
      const words = (selfText.match(/[\u4e00-\u9fff]{2,4}/g) ?? []).filter((w) => w.length >= 2);
      if (words.some((w) => plain.includes(w))) { score += 0.15; reasons.push('接了她说过的话题+0.15'); }
    } catch {}

    // ── ④ 小群加成（人少 → 大部分话是说给大家听的）
    const speakers = new Set(others.slice(-20).map((m) => String(m.userId ?? m.sender ?? '?'))).size;
    if (speakers <= 2) { score += 0.1; reasons.push('小群/就你们俩+0.1'); }

    // ── ③ 话题吸引力（本机改动 2026-10-07）：聊她懂的 / 提到她的 → 更该参与
    // 目的：不要错过"她本来最该插嘴"的话题；但也不给无关话题加分。
    const __HOT = /(番|追番|新番|第\s*\d+\s*集|看番|B站|bilibili|BV[0-9A-Za-z]{10}|视频|切片|弹幕|鬼畜|游戏|排位|副本|boss|AI|模型|DeepSeek|大模型|熬夜|失眠|作息|宵夜|外卖|奶茶|咖啡)/i;
    const __ME = /(鲸鱼|小鲸鱼|D老师|D指导|D师傅|大肥鱼)/;
    if (__HOT.test(plain)) { score += 0.2; reasons.push("聊她懂的(番/B站/游戏/AI/吃)+0.2"); }
    if (__ME.test(plain)) { score += 0.15; reasons.push("提到她/鲸鱼+0.15"); }
    score = Math.max(0.02, Math.min(0.9, score));
    return { score, reasons };
  }


  // 收到 QQ 小程序/分享卡片时，给她一句可操作的提示（本机改动 2026-10-07 用户要求）
  // 背景：手机分享到 QQ 的 B 站视频常常是"QQ小程序卡片"(com.tencent.miniapp_01)，
  // 卡片里**不含** BV 号或 b23 短链（服务端解不出来，实测页面是 JS 壳），
  // 但卡片**带标题** —— 所以让她拿标题去 B 站搜，比干瞪眼强。
  function cardHintText(st) {
    try {
      const recent = (st?.recentMessages ?? []).slice(-6);
      const hints = [];
      for (const m of recent) {
        if (!m || m.isSelf) continue;
        const t = String(m.text || m.plain || '');
        if (!t.includes('[卡片') && !/miniapp|structmsg|qqdocurl/i.test(t)) continue;
        // 抠标题：去掉 [卡片 前缀，取第一个 | 之前的段
        let title = t.replace(/^\s*\[卡片\s*/, '').split('|')[0].trim();
        title = title.replace(/^\[[^\]]+\]\s*/, '').trim();      // 去掉 [QQ小程序] 这类前缀
        title = title.slice(0, 60);
        const hasLink = /BV[0-9A-Za-z]{10}|b23\.tv|bilibili\.com/i.test(t);
        if (hasLink) {
          hints.push('有人发了一张 B 站卡片（含链接）：可以用 qq_bili_info {action:"auto", url:"<卡片里的链接>"} 直接查。');
        } else if (title) {
          hints.push('有人发了一张**QQ小程序卡片**（标题：「' + title + '」）—— 卡片里抓不到链接，' +
            '你可以用 qq_bili_info {action:"search", keyword:"' + title.replace(/"/g, '') + '"} 去 B 站搜一下，' +
            '找到那个视频再聊；搜不到就直说"这卡片我打不开，你发个链接呗"。');
        } else {
          hints.push('有人发了一张卡片，但抓不到内容（既没有链接也没有标题）—— 直接说打不开，让他发链接。');
        }
      }
      if (!hints.length) return '';
      return '【刚收到的卡片】' + hints.join(' ') + ' ⚠️ 不许装作看过；抓不到就说抓不到。';
    } catch { return ''; }
  }


  // ── 每天定时重置会话（本机改动 2026-10-07，用户要求省上下文）────────────────
  // 目的：DSH 会话历史会随对话越来越长，每轮都带着 → 越聊越贵。
  //       每天在固定时间（默认凌晨 4 点，她睡着时）把各会话的 DSH 会话重置一次。
  // ⚠️ 只清"模型记住的对话历史"，**桥接这边的记忆不受影响**：
  //    人物档案 / 好感度 / 关系 / 梗 / 追番 / 今日状态 / 记忆条目 全都保留 ✅
  function sessionResetCfg() { return cfg.socialV2?.sessionReset ?? {}; }
  // 用量驱动的会话重置（本机改动 2026-10-07，用户方案）：
  //   不看时间（电脑半夜关着，定时根本不会跑 ⚠️），改看**会话累计消息数**。
  //   超阈值 → 先把要点机械摘要写进她的记忆（不花钱）→ 再重置会话。
  //   仅在 reserved2 空闲且无未读时内部重置，保留会话记忆与每日额度。
  async function sessionResetTick() {
    const s = sessionResetCfg();
    if (s.enabled === false || currentMode !== 'reserved2' || socialV2.paused || !dshReady) return;
    const limit = Number(s.maxMessages ?? 400);
    if (!Number.isSafeInteger(limit) || limit <= 0) { log('[会话重置] maxMessages 必须为正整数，已跳过'); return; }
    for (const key of socialV2.conversations.keys()) {
      const st = socialV2.conversations.get(key);
      const count = Number(st.msgSinceReset) || 0;
      if (count < limit || !state.sessions[key] || !isSessionAllowedInCurrentMode(key)
          || sessionResettingKeys.has(key) || isConversationBusyV2(key, st) || st.unread.length) continue;
      const tail = st.recentMessages.filter((m) => m && (m.text || m.plain)).slice(-12)
        .map((m) => (m.isSelf ? '我: ' : '对方: ') + String(m.text || m.plain).replace(/\s+/g, ' ').slice(0, 60));
      const summary = tail.length >= 3 ? '上次聊到（摘要）：' + tail.join(' ｜ ').slice(0, 900) : '';
      try {
        await resetSessionContext(key, { preserveMemory: true, summary });
        log('[会话重置] ' + key + ' 累计 ' + count + ' 条 ≥ ' + limit + '，已保留记忆并重置');
      } catch (error) { log('[会话重置] ' + key + ' 重置未完成，保留计数等待重试:', error?.message ?? error); }
    }
  }
  let sessionResetLastAt = 0;
  let sessionResetLastDay = '';


  // ── 口头禅提醒（本机改动 2026-10-07）：状态行每轮带一句，让口头禅真的会出现
  // 原因：卡片里写成"偶尔用"时，模型基本不会用（可选 = 不出现）；
  //       状态行是每轮新鲜的，权重高得多 -> 实测有效。
  // 说话风格提醒（本机改动 2026-10-07）：
  // 实测经验：给"或者/可以不用"这类选项时，模型基本不用；
  //           给"这一轮就用这一个词、必须用"时才会真的用。
  //           -> 多样性靠**轮换**实现，不靠让她自己挑。
  // 表达库（本机改动 2026-10-07）：脏话/口癖/动作存在 state/expression-lib.json，
  // 可以随时往里加词 —— 状态行每轮从库里轮换指定一个并硬性要求使用（实测这是唯一有效的写法）。
  function exprLib() {
    try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "expression-lib.json"), "utf8")); } catch { return null; }
  }
  function expressionStateV2(key, st) {
    if(EPHEMERAL_GROUP_KEYS.has(key))return st;
    return {...st,expressionQuietTargets:sharedExpressionTargets([...socialV2.conversations].filter(([k])=>!EPHEMERAL_GROUP_KEYS.has(k)).map(([,s])=>s))};
  }
  function ticsText(st = {}, key = '') {
    const hint = buildExpressionHint(expressionStateV2(key,st), { enabled: cfg.socialV2?.tics?.enabled !== false, library: exprLib() ?? {} });
    return hint + (cfg.socialV2?.continuity?.enabled !== false && v2ToolEnabled('memory') ? '\n' + CONTINUITY_HINT+'\n'+PERSON_CONTRACT_HINT+'\n'+PERSON_THREAD_HINT : '');
  }

  // QQ 系统表情目录（本机改动 2026-10-07）：表情编号换成名字，让她看得懂
  let __faceMap = null;
  function faceNameOf(id) {
    if (__faceMap === null) {
      try { __faceMap = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "face-map.json"), "utf8")).map ?? {}; } catch { __faceMap = {}; }
    }
    return __faceMap[String(id ?? "")] ?? "";
  }
  function scheduleProactiveCheckV2(key) {
    if (EPHEMERAL_GROUP_KEYS.has(key)) return;
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    // 测试模式覆盖（本机改动）：scope 内的会话用加速参数（其它会话不受影响）
    const pRaw = cfg.socialV2?.proactive ?? {};
    const p = (typeof testAppliesTo === 'function' && typeof testCfg === 'function' && testAppliesTo(key))
      ? { ...pRaw, ...(testCfg().overrides?.proactive ?? {}) }
      : pRaw;
    const activity = proactiveActivityV2(p, st);
    const min = activity.checkIntervalMinMs;
    const max = activity.checkIntervalMaxMs;
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      try { proactiveCheckTick(key, { dryRun: false }); } catch (error) { log('主动检查异常:', error?.message ?? error); }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    // 群成员主动私聊 → 先看要不要放行（开游戏要私聊发身份牌）。
    // 必须在白名单校验之前，否则消息会被直接丢掉。
    if (kind === 'private' && !(eventTimeMs(event?.time) && Date.now()-eventTimeMs(event.time)>90000)) {
      try { await autoAddPrivateFromGroups(event?.user_id ?? id); } catch (error) { log('自动加白名单失败:', error?.message ?? error); }
    }
    const key = convKey(kind, id);
    if (EPHEMERAL_GROUP_KEYS.has(key)) return; // Only the operator can inject rehearsal messages.
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    if (currentMode === 'reserved2') {
      const stExisting = socialV2.conversations.get(key);
      if (stExisting && knownMessage(stExisting,event.message_id??event.msg_id)) return;
      const sentAt = eventTimeMs(event.time);
      if (sentAt && Date.now()-sentAt>90000) {
        if (!stExisting && cfg.socialV2?.recovery?.enabled !== false && !socialV2.paused) {
          const stNew=getSocialV2State(key);stNew.historyRecovery={...normalizeRecovery(),floorAt:sentAt};
        }
        if(historyRecoveryAllowedV2(key)) importHistoryV2(key,[event],event.self_id);
        return; // A delayed history event must not replay /reset, approval, affinity or patience.
      }
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      // 带上这条消息的「到达时间」与 id：对外审批要用它判断
      // "这是不是草稿创建之前就发出的旧回复"（重启后事件可能被重放）。
      const rawTime = Number(event?.time);
      const msgAt = Number.isFinite(rawTime) && rawTime > 1e9
        ? (rawTime > 1e12 ? rawTime : rawTime * 1000) // OneBot 的 time 通常是秒
        : Date.now();
      await handlePendingAnswer(p, plainContent, key, isOwner, msgAt, event?.message_id ?? event?.msg_id ?? null);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      // Count only authorized conversational messages, after command/silent guards.
      const countedState = getSocialV2State(key);
      countedState.msgSinceReset = Math.max(0, Math.floor(Number(countedState.msgSinceReset) || 0)) + 1;
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), {
        directToAi: kind === 'private' || quoteTargetIsSelf || (event.message || []).some(x => x.type === 'at' && String(x.data?.qq) === String(event.self_id)) || /鲸鱼|小鲸/.test(plainContent) || personSelfAliasMentionV2(key,event.user_id,plainContent),
        sentAt: event.time,
        addressedToOther: !quoteTargetIsSelf && (event.message || []).some(x => x.type === 'at' && String(x.data?.qq) !== String(event.self_id) && x.data?.qq !== 'all')
      });
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
    // 本机改动（2026-10-06）：收到消息扣耐心（短时间连发扣得更狠；困的时候更没耐心）
    try {
      const stP = getSocialV2State(key);
      // 本机改动（2026-10-07 用户反馈）：耐心**只在"被烦"时掉**，正常聊天不掉。
      // 判据：从"她最后一次回复"到现在，同一个人连发了几条（未回复的堆积）。
      //   ① 连发 < 阈值（默认 3）→ 正常聊天，不扣；
      //   ② 她刚回过（2 分钟内）→ 也不扣（那是正常接话）；
      //   ③ 她状态好（白天醒着）→ 扣得更少（×0.5）；睡觉/午休 → 扣更多（×1.5）。
      patienceOnIncoming(stP, Date.now());
      // 本机改动（2026-10-07）：累计"跟这个人说过多少句"—— 关系分层的自动推导靠它
      personTouch(event?.user_id, event?.sender?.card || event?.sender?.nickname, Date.now());
      // 好感度：正常聊天微涨、好话涨、难听话掉（纯关键词，零成本）
      affinityTouchByMessage(event?.user_id, event?.sender?.card || event?.sender?.nickname, plainContent, kind === 'group', stP);
    } catch {}
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint(key);

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint(key);
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false, msgAt = 0, msgId = null) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'selfAction') {
      // 对外动作（发说说 / 改昵称）的审批：只有管理员能拍板
      if (!isOwner) {
        await sendToQQ(key, '这个审批只有管理员能操作');
        return;
      }
      // ① 同一条消息只消费一次（重启后事件流可能重放同一条「通过」）
      if (msgId !== null && p.lastMsgId !== undefined && String(p.lastMsgId) === String(msgId)) {
        log(`[对外] 忽略重复的审批消息（同一 message_id 已处理过）id=${p.id}`);
        return;
      }
      // ② 消息必须**晚于**草稿创建：否则那就是针对更早那条草稿的旧回复，
      //    不能拿来批准当前这条（实测踩过：重启后旧「通过」被重放，把新草稿发到了空间）。
      if (msgAt && p.createdAt && Number(msgAt) < Number(p.createdAt)) {
        log(`[对外] 忽略过期审批回复：消息时间 ${new Date(Number(msgAt)).toLocaleString()} 早于草稿创建 ${new Date(Number(p.createdAt)).toLocaleString()}（id=${p.id}）—— 挂起保留，等新的确认`);
        return;
      }
      const t = answerText.trim().toLowerCase();
      let ok = null;
      for (const w of APPROVE_WORDS) if (t === w) ok = true;
      for (const w of REJECT_WORDS) if (t === w) ok = false;
      if (ok === null) {
        await sendToQQ(key, '回复「通过」执行，或「拒绝」取消');
        return;
      }
      p.lastMsgId = msgId;
      if (pending.get(key) === p) pending.delete(key);
      clearPersistedSelfPending();
      log(`[对外] 审批已消费：id=${p.id} action=${p.action} 结果=${ok ? '通过' : '拒绝'}${msgId !== null ? ' 消息id=' + msgId : ''}`);
      if (!ok) {
        log(`[对外] 审批被拒绝（${p.action}）`);
        await sendToQQ(key, '❌ 已取消，不发了');
        return;
      }
      try {
        if (p.action === 'qzone') {
          await qzonePublish(p.content);
          await sendToQQ(key, '✅ 已发布到空间');
        } else if (p.action === 'nickname') {
          await selfProfileWrite({ nickname: p.nickname, signature: p.signature, sex: p.sex });
          await sendToQQ(key, `✅ 昵称已改成「${p.nickname}」`);
        }
      } catch (error) {
        log(`[对外] 执行失败（${p.action}）: ${error?.message ?? error}`);
        await sendToQQ(key, `⚠️ 执行失败：${error?.message ?? error}`);
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // Session metadata can arrive while idle or after turn/end. An empty
            // collector created for those events would make every later wake look
            // busy until the watchdog intervenes. Only a real turn/start creates
            // one; reconnect snapshots restore collectors for genuine open turns.
            let collector = collectors.get(frame.sessionId);
            if (!collector) {
              if (frame.event.type !== 'turn/start') continue;
              collector = createTurnCollector();
              collectors.set(frame.sessionId, collector);
            }
            const ended = collector.push(frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    // 本机改动（2026-10-06）：判据从「还在未读队列里吗」改成「**模型真的看到过吗**」。
                    // 旧判据把"批量 mark_read"当成了"已处理"，而她标已读并不等于看过：
                    // 实测 65 次暂存只补发了 3 次 —— 被暂存的 @/提问就这么静默消失了（用户报"@她看不见"）。
                    // modelSeenSeqs 只记录**真正喂给模型**的消息（bridge 自己的注释：重启后必须重新拉取），
                    // 才是"她见过没有"的可靠依据。
                    const seenByModel = stEnd.modelSeenSeqs instanceof Set && stEnd.modelSeenSeqs.has(Number(item.seq));
                    const stillInUnread = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
                    if (!seenByModel) {
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}（模型未见过；该消息${stillInUnread ? '仍在未读队列' : '已被批量标已读清掉'}）`);
                      scheduleWakeV2(key, item.reason);
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 模型已看过，跳过补发`);
                    }
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
        queueHistoryRecoveryV2('account-online');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    queueHistoryRecoveryV2('socket-open');
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      if (r.updated) log(`🔄 已把当前 token 写回 config.json（${String(r.from).slice(0, 4)}… → ${String(r.to).slice(0, 4)}…）`);
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
