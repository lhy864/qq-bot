// Account-scoped self actions over documented SnowLuma actions.
// Callers still enforce conversation permissions. This layer owns serialization,
// durable retry identity, quotas and read-back confirmation. No arbitrary targets.
import { createHash } from 'node:crypto';

const clean = x => String(x ?? '').trim();
const normalized = x => clean(x).replace(/\r\n/g, '\n');
const DAY = 86400000;
const sexValue = value => value === null || value === undefined ? null
  : typeof value === 'string' ? ({ male: 1, female: 2, unknown: 0 }[value] ?? Number(value)) : Number(value);
export function selfActionPolicy(config = {}) {
  return { qzoneRequiresApproval: config.qzoneRequiresApproval !== false,
    nicknameRequiresApproval: config.nicknameRequiresApproval !== false,
    qzoneMaxPerDay: Math.max(0, Number(config.qzoneMaxPerDay ?? 1)),
    profileMaxPerDay: Math.max(0, Number(config.profileMaxPerDay ?? 1)),
    qzoneMaxChars: Math.max(1, Number(config.qzoneMaxChars ?? 300)),
    zeroLimitMeans: 'unlimited', profileFields: ['nickname', 'signature'],
    ownSpaceAction: 'get_qzone_msg_list', execution: 'account-serialized-with-readback' };
}
export function validateSelfText(value, max, sensitive) {
  const text = clean(value);
  if (!text) throw new Error('内容不能为空');
  if (text.length > max) throw new Error(`内容超过 ${max} 字`);
  if (sensitive?.test(text)) throw new Error('内容含敏感信息特征，已拒绝');
  return text;
}

export function createSelfActions({ call, state, save, config, dayKey,
  now = Date.now, sensitive, publicGuard = () => {}, log = () => {} }) {
  let tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const roll = () => {
    const st = state(), day = dayKey();
    if (st.dayKey !== day) { st.dayKey = day; st.postedToday = 0; st.profileChangedToday = 0; }
    if (!Array.isArray(st.operations)) st.operations = [];
    if (!Array.isArray(st.profileHistory)) st.profileHistory = [];
    return st;
  };
  const commit = () => save(); // Must throw on failure before any external write.
  const ownProfile = async () => {
    const login = await call('get_login_info');
    if (!login?.user_id) throw new Error('无法确认机器人自己的账号，未操作');
    const info = await call('get_stranger_info', { user_id: Number(login.user_id), no_cache: true });
    return { user_id: login.user_id, nickname: info?.nickname ?? login.nickname ?? '', signature: info?.long_nick ?? info?.signature ?? '', sex: info?.sex ?? null };
  };
  const ownPosts = async () => {
    const data = await call('get_qzone_msg_list', { pos: 0, num: 20 });
    if (!Array.isArray(data?.msglist)) throw new Error('自己的空间列表返回格式无效');
    return { total: Number(data.total) || 0, posts: data.msglist };
  };
  const count = (st, op) => {
    if (op.counted) return;
    if (op.day === st.dayKey) { const field = op.kind === 'qzone' ? 'postedToday' : 'profileChangedToday'; st[field] = Number(st[field] || 0) + 1; }
    op.counted = true;
  };
  const verify = async op => {
    if (op.kind === 'qzone') {
      const list = await ownPosts();
      const match = list.posts.find(p => op.tid ? String(p.tid) === String(op.tid)
        : normalized(p.content) === normalized(op.params.content) && Number(p.time) * 1000 >= op.at - 60000);
      if (!match || normalized(match.content) !== normalized(op.params.content)) return null;
      return { tid: match.tid, content: match.content };
    }
    const profile = await ownProfile();
    for (const [field, value] of Object.entries(op.params)) {
      const actual = field === 'personal_note' ? profile.signature : profile[field];
      if (field === 'sex') { if (sexValue(actual) !== value) return null; }
      else if (normalized(actual) !== normalized(value)) return null;
    }
    return profile;
  };
  const confirmed = (st, op, result) => {
    op.status = 'confirmed'; op.verifiedAt = now(); if (result.tid) op.tid = result.tid;
    count(st, op);
    if (op.kind === 'qzone') {
      if (!Array.isArray(st.history)) st.history = [];
      const found = st.history.find(h => h.operationId === op.id || op.tid && String(h.tid) === String(op.tid));
      if (found) Object.assign(found, { verified: true, verifiedAt: op.verifiedAt });
      else st.history.unshift({ tid: op.tid ?? null, content: op.params.content, at: op.at, operationId: op.id, verified: true, verifiedAt: op.verifiedAt });
      st.history = st.history.slice(0, 50);
    } else if (!st.profileHistory.some(h => h.operationId === op.id)) {
      st.profileHistory.unshift({ operationId: op.id, at: op.at, fields: Object.keys(op.params), before: op.before, applied: op.params, verified: true });
      st.profileHistory = st.profileHistory.slice(0, 30);
    }
    commit();
    return { ...op.params, ...(op.kind === 'qzone' ? { tid: op.tid ?? null } : {}), verified: true, operationId: op.id };
  };
  const uncertainError = () => Object.assign(new Error('执行结果尚未确认，已保留记录；请先核对自己的资料或空间，不要重复提交'), { code: 'SELF_ACTION_UNCERTAIN' });
  const execute = (kind, params) => serial(async () => {
    const st = roll(), policy = selfActionPolicy(config());
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, params })).digest('hex');
    const existing = [...st.operations].reverse().find(o => o.fingerprint === fingerprint && o.status !== 'failed' && (o.status !== 'confirmed' || now() - o.at < DAY));
    if (existing) {
      // A timed-out or pre-crash write must be reconciled by reads, never resent.
      const result = await verify(existing).catch(() => null);
      if (result) return { ...confirmed(st, existing, result), duplicate: true };
      if (existing.status !== 'confirmed') throw uncertainError();
      // A confirmed profile can be changed again by another legitimate operation.
      // Reapplying an old value is a new change and still needs today's quota.
      if (kind === 'qzone') throw new Error('这条说说曾核验成功，当前未读到；请先核对是否已删除，不自动重发');
    }
    let before;
    if (kind === 'profile') {
      before = await ownProfile();
      const matches = Object.entries(params).every(([k, v]) => k === 'sex' ? sexValue(before.sex) === v : normalized(k === 'personal_note' ? before.signature : before[k]) === normalized(v));
      if (matches) return { ...params, verified: true, unchanged: true };
    } else {
      const list = await ownPosts();
      const old = list.posts.find(p => normalized(p.content) === normalized(params.content) && now() - Number(p.time) * 1000 < DAY);
      if (old) return { tid: old.tid, verified: true, duplicate: true, unchanged: true };
    }
    const field = kind === 'qzone' ? 'postedToday' : 'profileChangedToday';
    const max = kind === 'qzone' ? policy.qzoneMaxPerDay : policy.profileMaxPerDay;
    const reservations = st.operations.filter(o => o.kind === kind && o.day === st.dayKey && !o.counted && ['pending', 'uncertain'].includes(o.status)).length;
    if (max > 0 && Number(st[field] || 0) + reservations >= max) throw new Error('今日额度已用完或有待确认操作，未重复执行');
    // Keep unresolved operations across days/restarts; do not silently erase them.
    if (st.operations.filter(o => ['pending', 'uncertain'].includes(o.status)).length >= 20) throw new Error('待确认操作过多，请先检查执行记录');
    st.operations = st.operations.filter(o => ['pending', 'uncertain'].includes(o.status) || now() - o.at < 7 * DAY).slice(-100);
    const op = { id: createHash('sha256').update(fingerprint + ':' + now() + ':' + st.operations.length).digest('hex').slice(0, 24), fingerprint, kind, params, before, at: now(), day: st.dayKey, status: 'pending', counted: false };
    st.operations.push(op); commit();
    try {
      const ack = await call(kind === 'qzone' ? 'send_qzone_msg' : 'set_qq_profile', params);
      if (kind === 'qzone' && ack?.tid) op.tid = ack.tid;
      op.acknowledged = true; count(st, op); commit();
    } catch (error) {
      op.status = error?.actionOutcome === 'failed' ? 'failed' : 'uncertain'; commit();
      if (op.status === 'failed') throw new Error('SnowLuma 明确拒绝了操作，未报告成功');
      log('self action outcome uncertain');
    }
    const result = await verify(op).catch(() => null);
    if (result) return confirmed(st, op, result);
    op.status = 'uncertain'; commit(); throw uncertainError();
  });
  return {
    policy: () => selfActionPolicy(config()), ownProfile, ownPosts,
    publish(value) {
      const content = validateSelfText(value, selfActionPolicy(config()).qzoneMaxChars, sensitive); publicGuard(content);
      return execute('qzone', { content });
    },
    writeProfile({ nickname, signature, sex } = {}) {
      const params = {};
      if (nickname !== undefined && nickname !== null && clean(nickname)) params.nickname = validateSelfText(nickname, 24, sensitive);
      if (signature !== undefined && signature !== null) { params.personal_note = clean(signature) ? validateSelfText(signature, 60, sensitive) : ''; publicGuard(params.personal_note); }
      if (sex !== undefined && sex !== null && clean(sex)) { const n = Number(sex); if (![0, 1, 2].includes(n)) throw new Error('sex 只能是 0/1/2'); params.sex = n; }
      if (!Object.keys(params).length) throw new Error('没有要改的资料字段');
      return execute('profile', params);
    }
  };
}
