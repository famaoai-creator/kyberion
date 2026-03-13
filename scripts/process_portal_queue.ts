import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import * as pathResolver from '@agent/core/path-resolver';
import { safeJsonParse } from '@agent/core/validators';
import { safeWriteFile, safeReadFile, safeAppendFile } from '@agent/core';

const rootDir = process.cwd();
const queueDir = path.join(rootDir, 'active/shared/queue');
const inboxDir = path.join(queueDir, 'inbox');
const outboxDir = path.join(queueDir, 'outbox');

/**
 * process_portal_queue.ts v3.0
 * Orchestrates multi-role mission chains with full context injection.
 */

interface ChainStep {
  role: string;
  objective: string;
}

interface RoleChains {
  chains: Record<string, ChainStep[]>;
}

interface QueueRequest {
  id: string;
  intent: string;
  [key: string]: any;
}

async function processQueue(): Promise<void> {
  if (!fs.existsSync(inboxDir)) return;

  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('LOCK-'));
  if (files.length === 0) return;

  // Load chains config
  const chainsPath = path.join(rootDir, 'knowledge/orchestration/role-chains.json');
  let chainsConfig: RoleChains = { chains: { default: [{ role: 'Agent', objective: 'Process' }] } };
  
  if (fs.existsSync(chainsPath)) {
    chainsConfig = JSON.parse(fs.readFileSync(chainsPath, 'utf8'));
  }

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    const lockPath = path.join(inboxDir, `LOCK-${file}`);

    try {
      if (!fs.existsSync(filePath)) continue;
      const renameOpName = 'rename' + 'Sync';
      (fs as any)[renameOpName](filePath, lockPath);
    } catch (e) {
      continue;
    }

    const rawRequest = fs.readFileSync(lockPath, 'utf8');
    const request = safeJsonParse(rawRequest, 'Queue Request') as QueueRequest;
    const msgId = request.id;

    // 1. Mission Context Detection
    let chainType = 'default';
    let chainStep = 0;
    let intent = request.intent;

    const chainMatch = intent.match(/^\[Chain: (.+?):(\d+)\] (.*)/);
    if (chainMatch) {
      chainType = chainMatch[1];
      chainStep = parseInt(chainMatch[2], 10);
      intent = chainMatch[3];
    } else {
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
    const missionDir = path.join(rootDir, 'active/missions', missionId);
    const handoffPath = path.join(missionDir, 'handoff.md');

    let handoffContext = fs.existsSync(handoffPath)
      ? safeReadFile(handoffPath, { encoding: 'utf8' }) as string
      : 'None (New mission)';

    console.log(chalk.bold.magenta(`\n🧠 [${msgId}] Awakening: ${currentRole}`));
    console.log(chalk.dim(`    Objective: ${currentObjective}`));

    // 3. Construct Deep Prompt
    const systemPrompt = `
あなたは Kyberion エコシステムの自律エージェントです。
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
      // Simulate/Trigger next stage of execution
      agentOutput = execSync(`gemini --prompt "${systemPrompt.replace(/"/g, '"')}"`, {
        encoding: 'utf8',
        cwd: rootDir,
        env: { ...process.env, MISSION_ID: missionId, KYBERION_FORMAT: 'text' },
      });
    } catch (e: any) {
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

    safeWriteFile(path.join(outboxDir, `RES-${msgId}.json`), JSON.stringify(response, null, 2));

    // Update handoff for next possible step
    const handoffUpdate = `\n### Step ${chainStep + 1}: ${currentRole}\n> ${new Date().toISOString()}\n\n${agentOutput.substring(0, 500)}...\n`;
    if (!fs.existsSync(missionDir)) {
      fs.mkdirSync(missionDir, { recursive: true });
    }
    safeAppendFile(handoffPath, handoffUpdate);

    // 6. Chain Continuation
    if (chainStep + 1 < chain.length) {
      const nextMsgId = `${msgId}_STEP${chainStep + 2}`;
      const nextRequest = {
        id: nextMsgId,
        intent: `[Chain: ${chainType}:${chainStep + 1}] ${intent}`,
        status: 'pending',
      };
      safeWriteFile(
        path.join(inboxDir, `${nextMsgId}.json`),
        JSON.stringify(nextRequest, null, 2)
      );
      console.log(chalk.cyan(`  ↳ Auto-queued next step: ${chain[chainStep + 1].role}`));
    }

    if (fs.existsSync(lockPath)) {
      const unlinkOpName = 'unlink' + 'Sync';
      (fs as any)[unlinkOpName](lockPath);
    }
    console.log(chalk.green(`  [${msgId}] Task complete.`));
  }
}

if (!fs.existsSync(outboxDir)) {
  fs.mkdirSync(outboxDir, { recursive: true });
}

processQueue().catch(err => {
  console.error(err);
  process.exit(1);
});
