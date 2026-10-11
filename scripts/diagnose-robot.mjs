import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRobot, createWindowsIO, describeStatus, loadOperations, saveOperations } from './robot-operations.mjs';

const args = process.argv.slice(2); const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : fileURLToPath(new URL('..', import.meta.url)));
try {
  const settings = loadOperations(root);
  const snapshot = await checkRobot(settings, createWindowsIO(settings));
  if (args.includes('--save')) {
    const file = path.join(root, 'state', 'diagnostic-latest.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file); saveOperations(root, { event: 'diagnostic', status: snapshot });
  }
  console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : describeStatus(snapshot));
  if (!snapshot.ready) process.exitCode = 1;
} catch {
  console.error('诊断未完成：请检查配置文件、目录访问权限和本机服务地址。未输出配置或凭据内容。');
  process.exitCode = 2;
}
