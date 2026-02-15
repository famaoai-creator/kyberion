#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');
const pathResolver = require('./lib/path-resolver.cjs');

const rootDir = path.resolve(__dirname, '..');
const queueDir = pathResolver.shared('queue');

async function processQueue() {
  const inboxDir = path.join(queueDir, 'inbox');
  const outboxDir = path.join(queueDir, 'outbox');

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('LOCK-'));
  if (files.length === 0) return;

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    const lockPath = path.join(inboxDir, `LOCK-${file}`);

    try {
      if (!fs.existsSync(filePath)) continue;
      fs.renameSync(filePath, lockPath);
    } catch (e) { continue; }

    const request = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const msgId = request.id;
    
    // 0. Persona & Chain Extraction
    const chainsConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'knowledge/orchestration/role-chains.json'), 'utf8'));
    let currentRole = 'Autonomous Agent';
    let chainType = 'default';
    let chainStep = 0;

    // Parse Intent for Chain Info: "[Role: X] [Chain: Y:Step] Intent..."
    const chainMatch = request.intent.match(/^\[Role: (.+?)\] \[Chain: (.+?):(\d+)\] (.*)/);
    
    if (chainMatch) {
      currentRole = chainMatch[1];
      chainType = chainMatch[2];
      chainStep = parseInt(chainMatch[3], 10);
      request.intent = chainMatch[4]; // Clean intent
    } else {
      // New Mission: Detect Chain Type
      if (request.intent.toLowerCase().includes('migration')) chainType = 'migration';
      else if (request.intent.toLowerCase().includes('refactor')) chainType = 'refactoring';
      else if (request.intent.toLowerCase().includes('incident')) chainType = 'incident';
      
      const chain = chainsConfig.chains[chainType] || chainsConfig.chains.default;
      currentRole = chain[0].role;
      chainStep = 0;
    }

    const currentChainDef = chainsConfig.chains[chainType] || chainsConfig.chains.default;
    const currentObjective = currentChainDef[chainStep]?.objective || "Execute task";

    // Mission Isolation Setup
    const missionDir = pathResolver.missionDir(msgId.split('_')[0]); // Use root ID for shared mission dir
    const handoffPath = path.join(missionDir, 'handoff.md');
    
    // Read Handoff Context
    let handoffContext = "";
    if (fs.existsSync(handoffPath)) {
      handoffContext = fs.readFileSync(handoffPath, 'utf8');
    }

    console.log(chalk.bold.magenta(`\n\ud83e\udde0 [${msgId}] Awakening: ${currentRole} (Chain: ${chainType} ${chainStep+1}/${currentChainDef.length})`));
    console.log(chalk.dim(`    Objective: ${currentObjective}`));

    const systemPrompt = `
あなたは Gemini エコシステムの自律サブエージェントです。
現在のあなたの役割（Persona）は **${currentRole}** です。
【ミッション】: ${request.intent}
【現在の目標】: ${currentObjective}
【引継ぎ事項 (Handoff)】:
${handoffContext}

【実行モード】: ${tierName}
【許可領域 (Scope)】:
  - 書き込み許可: ${scope.allowedDirs.join(', ')}
  - 読み取り専用: ${scope.readOnlyDirs.join(', ')}
【規程】: 
  1. 成果物は必ず書き込み許可領域に保存せよ。
  2. 読み取り専用領域のファイルへの変更・削除は厳禁とする。
  3. 次の担当者への引継ぎ事項を明確に残せ。
`.trim();

    // 2. ヘッドレスモードでの Gemini CLI 起動
    let agentOutput = "";
    try {
      console.log(chalk.dim(`    [${msgId}] Thinking...`));
      
      agentOutput = execSync(`gemini --prompt "${systemPrompt.replace(/"/g, '\\"')}" ${modeFlag}`, { 
        encoding: 'utf8', 
        cwd: rootDir, 
        env: { ...process.env, GEMINI_FORMAT: 'text' } 
      });
    } catch (e) {
      agentOutput = `Agent encountered an error during thinking: ${e.message}\n${e.stdout || ''}`;
    }

    // 3. 成果の投影 & Handoff Update
    fs.writeFileSync(path.join(outboxDir, `RES-${msgId}.json`), JSON.stringify({ 
      id: msgId, 
      status: 'complete', 
      thought: `Completed step ${chainStep+1} as ${currentRole}`, 
      result: agentOutput, 
      timestamp: new Date().toISOString() 
    }, null, 2));

    // Append to Handoff
    const newHandoff = `\n## Step ${chainStep+1}: ${currentRole}\n> ${new Date().toISOString()}\n\n${agentOutput.substring(0, 300)}...\n\n`;
    fs.appendFileSync(handoffPath, newHandoff);

    // 4. Chain Continuation or Perpetual Planning
    const nextStep = chainStep + 1;
    if (nextStep < currentChainDef.length) {
      // Standard Chain Continuation
      const nextRole = currentChainDef[nextStep];
      const nextMsgId = `${msgId.split('_')[0]}_${nextStep}`;
      const nextIntent = `[Role: ${nextRole.role}] [Chain: ${chainType}:${nextStep}] ${request.intent}`;
      
      fs.writeFileSync(path.join(inboxDir, `${nextMsgId}.json`), JSON.stringify({
        id: nextMsgId, intent: nextIntent, status: 'pending'
      }));
      console.log(chalk.green(`  \u21aa Handoff to: ${nextRole.role}`));
    } else {
      // Chain Complete: Perpetual Mode check
      console.log(chalk.bold.green(`  \u2714 Chain Complete.`));

      if (process.env.GEMINI_PERPETUAL === 'true') {
        // --- PERPETUAL MODE: PLAN NEXT MISSION ---
        const stopFile = path.join(rootDir, 'STOP');
        if (fs.existsSync(stopFile)) {
          console.log(chalk.bold.red(`  \ud83d\uded1 STOP signal detected. Terminating Perpetual Mode.`));
          return;
        }

        console.log(chalk.bold.yellow(`\n\u267b\ufe0f Perpetual Mode: Planning next objective...`));
        
        // Next-Action Planning人格による思考
        const plannerPrompt = `
あなたは Gemini エコシステムの戦略プランナーです。
これまでのミッション「${request.intent}」が完了しました。
現在のプロジェクトの状態（Task Board, Knowledge Index等）を分析し、
次に着手すべき「最も価値の高いエンジニアリング・タスク」を1つ特定せよ。
出力は「{"intent": "...", "chain": "..."}」という形式のJSONのみで行え。
`.trim();

        try {
          const nextActionRaw = execSync(`gemini --prompt "${plannerPrompt.replace(/"/g, '\\"')}" --approval-mode plan`, { 
            encoding: 'utf8', env: { ...process.env, GEMINI_FORMAT: 'text' } 
          });
          
          const nextAction = JSON.parse(nextActionRaw.match(/\{.*\}/s)[0]);
          const nextRootId = `PERP-${Date.now().toString(36).toUpperCase()}`;
          
          fs.writeFileSync(path.join(inboxDir, `${nextRootId}.json`), JSON.stringify({
            id: nextRootId, intent: nextAction.intent, status: 'pending'
          }));
          
          console.log(chalk.bold.magenta(`  \ud83d\ude80 Self-Generated Next Mission: "${nextAction.intent}" (Chain: ${nextAction.chain})`));
        } catch (e) {
          console.log(chalk.red(`  [!] Failed to generate next perpetual mission: ${e.message}`));
        }
      }
      
      // Final Confessional
      // ... existing code ...
    }

    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    console.log(chalk.green(`  [${msgId}] Sub-Agent has returned with results.`));
  }
}

processQueue();
