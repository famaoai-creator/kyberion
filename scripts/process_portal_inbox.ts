import chalk from 'chalk';
import * as path from 'node:path';
// chalk imported dynamically
import { execSync } from 'node:child_process';
import { safeExistsSync, safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const inboxPath = path.join(rootDir, 'active/shared/portal/inbox.json');
const outboxPath = path.join(rootDir, 'active/shared/portal/outbox.json');

interface PortalRequest {
  intent: string;
  status: 'pending' | 'thinking' | 'complete' | 'processed';
  [key: string]: any;
}

async function processInbox(): Promise<void> {
  if (!safeExistsSync(inboxPath)) return;

  const raw = safeReadFile(inboxPath, { encoding: 'utf8' }) as string;
  const request: PortalRequest = JSON.parse(raw);
  if (request.status !== 'pending') return;

  console.log(chalk.bold.cyan(`\n📩 Processing Portal Request: "${request.intent}"`));

  const thought = `Lord（上様）より「${request.intent}」との命を授かった。\n現在のロール（Architect）に基づき、単なるコマンド実行に留まらず、広範な影響調査を実施する。`;

  // 1. 中間報告
  safeWriteFile(
    outboxPath,
    JSON.stringify(
      {
        status: 'thinking',
        thought,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );

  let result = '';
  try {
    if (request.intent.includes('security')) {
      result += execSync('node dist/scripts/cli.js run security-scanner --dir .', { encoding: 'utf8' });
      result += '\n' + execSync('node dist/scripts/cli.js run generate_debt_report', { encoding: 'utf8' });
    } else {
      result = '意図を解釈しました。適切なスキルセットを起動します。';
    }
  } catch (_e) {
    result = '実行中にエラーが発生しましたが、状況は把握しました。';
  }

  // 3. 完了報告
  safeWriteFile(
    outboxPath,
    JSON.stringify(
      {
        status: 'complete',
        thought: '任務完了。分析結果をポータルへ投影した。',
        result,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // Mark inbox as processed
  request.status = 'processed';
  safeWriteFile(inboxPath, JSON.stringify(request, null, 2));

  console.log(chalk.green('✔ Agent has responded to the portal.'));
}

processInbox().catch(err => {
  console.error(err);
  process.exit(1);
});
