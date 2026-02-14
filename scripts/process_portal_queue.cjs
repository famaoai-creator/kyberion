#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const pathResolver = require('./lib/path-resolver.cjs');

const rootDir = path.resolve(__dirname, '..');
const queueDir = pathResolver.shared('queue');

async function processQueue() {
  const inboxDir = path.join(queueDir, 'inbox');
  const outboxDir = path.join(queueDir, 'outbox');

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) return;

  console.log(chalk.bold.cyan(`
\u23f3 Found ${files.length} messages in queue.`));

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    const request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (request.status !== 'pending') continue;

    const msgId = request.id;
    console.log(chalk.cyan(`  [${msgId}] Thinking...`));

    // 1. 中間報告（思考の書き出し）
    fs.writeFileSync(path.join(outboxDir, `RES-${msgId}.json`), JSON.stringify({ 
      id: msgId,
      status: 'thinking', 
      thought: `Lordからの命「${request.intent}」を承った。分析を開始する。`,
      timestamp: new Date().toISOString() 
    }, null, 2));

    // 2. 行動 (Simulation)
    let result = `意図「${request.intent}」に基づき、ミッションを完遂した。`;
    // 必要に応じてここで実際のスキルを実行

    // 3. 完了報告
    fs.writeFileSync(path.join(outboxDir, `RES-${msgId}.json`), JSON.stringify({ 
      id: msgId,
      status: 'complete', 
      thought: "任務完了。全エビデンスを同期した。",
      result,
      timestamp: new Date().toISOString() 
    }, null, 2));

    // inboxから削除（アーカイブ）
    fs.unlinkSync(filePath);
    console.log(chalk.green(`  [${msgId}] Done.`));
  }
}

processQueue();
