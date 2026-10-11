// Curated offline suite. QQ/DSH are mocked; HTTP tests use temporary loopback ports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = path.join(root, 'review', 'tmp');
fs.mkdirSync(temp, { recursive: true });
const scripts = [
  'test-person-continuity.mjs',
  'test-person-threads.mjs',
  'test-person-recall.mjs',
  'test-console-consistency.mjs',
  'test-leisure.mjs',
  'test-material-conversation.mjs',
  'test-material-relevance.mjs',
  'test-discussion-progress.mjs',
  'test-opinion-continuity.mjs',
  'test-participation-outcome.mjs',
  'test-learning-practice.mjs',
  'test-reading-questions.mjs',
  'test-leisure-activities.mjs',
  'test-daily-activity.mjs',
  'test-chat-expression.mjs',
  'test-conversation-quality.mjs',
  'test-warm-companion.mjs',
  'test-slang-research.mjs',
  'test-proactive-activity.mjs',
  'test-anime-daily.mjs',
  'test-private-company.mjs',
  'test-message-recovery.mjs',
  'test-console-behavior.mjs',
  'test-lived-experience.mjs',
  'test-stage1.mjs',
  'test-dialogue-personality.mjs',
  'test-bili-subtitles.mjs',
  'test-bili-source-boundary.mjs',
  'test-private-dialogue.mjs',
  'test-persona-batch1.mjs',
  'test-review-regressions.mjs', 'test-no-reply-collector.mjs', 'test-audit-bridge.mjs', 'test-audit-security.mjs',
  'test-audit-security-mcp.mjs', 'test-reply-wait.mjs', 'test-token-economy.mjs',
  'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs', 'test-preset-local-tools.mjs',
  'test-robot-operations.mjs',
];
let failures = 0;
for (const script of scripts) {
  console.log('\nRunning ' + script);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...(script === 'test-robot-operations.mjs' ? ['--windows-process'] : [])], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, TEMP: temp, TMP: temp, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) { failures++; console.error('FAILED ' + script + ': ' + (result.error?.message ?? result.status)); }
}
console.log('\nOffline review suite: ' + (scripts.length - failures) + '/' + scripts.length + ' scripts passed.');
process.exitCode = failures ? 1 : 0;
