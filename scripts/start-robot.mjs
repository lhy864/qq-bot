import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLaunchLock, createWindowsIO, describeStatus, loadOperations, saveOperations, startRobot } from './robot-operations.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let release;
try {
  if (process.platform !== 'win32') throw new Error('双击启动入口只支持 Windows');
  release = acquireLaunchLock(root);
  const settings = loadOperations(root); const io = createWindowsIO(settings);
  console.log('鲸鱼机器人启动检查\n已运行的组件会复用；QQ 如需扫码，请在 QQ 窗口完成登录。');
  let lastStage = '';
  const result = await startRobot(() => loadOperations(root), io, (component, action, pid) => {
    const stage = component + ':' + action;
    if (stage === lastStage) return;
    if (stage !== lastStage) console.log('[' + component + '] ' + ({ reuse: '已经运行，复用', launched: '已发起启动', 'qq-login': '等待 QQ 登录或网关就绪', connections: '等待各端连接就绪' }[action] ?? action));
    lastStage = stage;
    try { saveOperations(root, { event: 'startup-stage', component, action, ...(pid ? { pid } : {}) }); } catch {}
  });
  saveOperations(root, { event: 'startup-ready', status: result });
  console.log('\n' + describeStatus(result));
} catch (error) {
  console.error('\n启动尚未完成：' + error.message);
  if (error.snapshot) console.error(describeStatus(error.snapshot));
  try { saveOperations(root, { event: 'startup-failed', reason: error.message }); } catch {}
  process.exitCode = 1;
} finally { release?.(); }
