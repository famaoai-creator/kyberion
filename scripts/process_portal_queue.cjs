#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');
const pathResolver = require('../libs/core/path-resolver.cjs');
const { safeJsonParse } = require('../libs/core/validators.cjs');

const rootDir = pathResolver.rootDir();
const queueDir = pathResolver.shared('queue');
const inboxDir = path.join(queueDir, 'inbox');
const outboxDir = path.join(queueDir, 'outbox');

/**
 * process_portal_queue.cjs v2.2
 * Orchestrates multi-role mission chains with full context injection.
 */

async function processQueue() {
  if (!fs.existsSync(inboxDir)) return;

  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('LOCK-'));
  if (files.length === 0) return;

  // Load chains config
  const chainsPath = path.join(rootDir, 'knowledge/orchestration/role-chains.json');
  const chainsConfig = fs.existsSync(chainsPath)
    ? JSON.parse(fs.readFileSync(chainsPath, 'utf8'))
    : { chains: { default: [{ role: 'Agent', objective: 'Process' }] } };

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    const lockPath = path.join(inboxDir, `LOCK-${file}`);

    try {
      if (!fs.existsSync(filePath)) continue;
      fs.renameSync(filePath, lockPath);
    } catch (e) {
      continue;
    }

    const request = safeJsonParse(fs.readFileSync(lockPath, 'utf8'), 'Queue Request');
    const msgId = request.id;

    // 1. Mission Context Detection
    let chainType = 'default';
    let chainStep = 0;
    let intent = request.intent;

    // Support for explicit chain tagging: "[Chain: migration:1] Intent..."
    const chainMatch = intent.match(/^\[Chain: (.+?):(\d+)\] (.*)/);
    if (chainMatch) {
      chainType = chainMatch[1];
      chainStep = parseInt(chainMatch[2], 10);
      intent = chainMatch[3];
    } else {
      // Auto-detect chain type
      const lowerIntent = intent.toLowerCase();
      if (lowerIntent.includes('migration')) chainType = 'migration';
      else if (lowerIntent.includes('refactor')) chainType = 'refactoring';
      else if (lowerIntent.includes('incident')) chainType = 'incident';
    }

    const chain = chainsConfig.chains[chainType] || chainsConfig.chains.default;
    const stepConfig = chain[chainStep] || chain[chain.length - 1];
    const currentRole = stepConfig.role;
    const currentObjective = stepConfig.objective;

    // 2. Prepare Environment
    const missionId = msgId.startsWith('REQ-') ? `MSN-${msgId.slice(4)}` : msgId;
    const missionDir = pathResolver.missionDir(missionId);
    const handoffPath = path.join(missionDir, 'handoff.md');

    let handoffContext = fs.existsSync(handoffPath)
      ? fs.readFileSync(handoffPath, 'utf8')
      : 'None (New mission)';

    console.log(chalk.bold.magenta(`\n\ud83e\udde0 [${msgId}] Awakening: ${currentRole}`));
    console.log(chalk.dim(`    Objective: ${currentObjective}`));

    // 3. Construct Deep Prompt
    const systemPrompt = `
あなたは Gemini エコシステムの自律エージェントです。
現在のあなたの役割（Persona）は **${currentRole}** です。

【ミッション】: ${intent}
【現在の目標】: ${currentObjective}
【Chain ステータス】: ${chainType} (Step ${chainStep + 1}/${chain.length})

【引継ぎ事項 (Handoff)】:
${handoffContext}

【作業領域 (Writable)】: ${missionDir}
【規程】:
1. 成果物は必ず作業領域に保存せよ。
2. 完了時、次のステップへの引継ぎ事項を末尾に記載せよ。
`.trim();

    // 4. Execution
    let agentOutput = '';
    try {
      console.log(chalk.dim(`    Processing as ${currentRole}...`));
      agentOutput = execSync(`gemini --prompt "${systemPrompt.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        cwd: rootDir,
        env: { ...process.env, MISSION_ID: missionId, GEMINI_FORMAT: 'text' },
      });
    } catch (e) {
      agentOutput = `Error during execution: ${e.message}\n${e.stdout || ''}`;
    }

    // 5. Update Evidence & Check for Next Step
    const response = {
      id: msgId,
      mission_id: missionId,
      role: currentRole,
      status: 'complete',
      result: agentOutput,
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(outboxDir, `RES-${msgId}.json`), JSON.stringify(response, null, 2));

    // Update handoff for next possible step
    const handoffUpdate = `\n### Step ${chainStep + 1}: ${currentRole}\n> ${new Date().toISOString()}\n\n${agentOutput.substring(0, 500)}...\n`;
    fs.appendFileSync(handoffPath, handoffUpdate);

    // 6. Chain Continuation (Optional auto-queueing)
    if (chainStep + 1 < chain.length) {
      const nextMsgId = `${msgId}_STEP${chainStep + 2}`;
      const nextRequest = {
        id: nextMsgId,
        intent: `[Chain: ${chainType}:${chainStep + 1}] ${intent}`,
        status: 'pending',
      };
      fs.writeFileSync(
        path.join(inboxDir, `${nextMsgId}.json`),
        JSON.stringify(nextRequest, null, 2)
      );
      console.log(chalk.cyan(`  \u21aa Auto-queued next step: ${chain[chainStep + 1].role}`));
    }

    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    console.log(chalk.green(`  [${msgId}] Task complete.`));
  }
}

if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
processQueue();
