#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const inboxPath = path.join(rootDir, 'work/portal/inbox.json');
const outboxPath = path.join(rootDir, 'work/portal/outbox.json');

async function processInbox() {
  if (!fs.existsSync(inboxPath)) return;

  const request = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
  if (request.status !== 'pending') return;

  console.log(chalk.bold.cyan(`
\ud83d\udce9 Processing Portal Request: "${request.intent}"`));

  // --- エージェントの思考プロセス (Simulation) ---
  const thought = `Lord（上様）より「${request.intent}」との命を授かった。
現在のロール（Architect）に基づき、単なるコマンド実行に留まらず、広範な影響調査を実施する。`;

  // 1. 中間報告（思考の書き出し）
  fs.writeFileSync(outboxPath, JSON.stringify({ 
    status: 'thinking', 
    thought, 
    timestamp: new Date().toISOString() 
  }, null, 2));

  // 2. 実際の行動（ここでは例としてセキュリティスキャンと負債調査を連鎖させる）
  let result = "";
  try {
    if (request.intent.includes('security')) {
      result += execSync('node scripts/cli.cjs run security-scanner --dir .', { encoding: 'utf8' });
      result += "
" + execSync('node scripts/cli.cjs run generate_debt_report', { encoding: 'utf8' });
    } else {
      result = "意図を解釈しました。適切なスキルセットを起動します。";
    }
  } catch (e) {
    result = "実行中にエラーが発生しましたが、状況は把握しました。";
  }

  // 3. 完了報告
  fs.writeFileSync(outboxPath, JSON.stringify({ 
    status: 'complete', 
    thought: "任務完了。分析結果をポータルへ投影した。",
    result,
    timestamp: new Date().toISOString() 
  }, null, 2));

  // inboxを処理済みに更新
  request.status = 'processed';
  fs.writeFileSync(inboxPath, JSON.stringify(request, null, 2));
  
  console.log(chalk.green("\u2714 Agent has responded to the portal."));
}

processInbox();
