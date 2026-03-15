import { handleAction as terminal } from '../libs/actuators/terminal-actuator/src/index.js';
import { handleAction as presence } from '../libs/actuators/presence-actuator/src/index.js';
import { logger, safeExistsSync, safeMkdir, safeReadFile, safeStat, safeWriteFile } from '../libs/core/index.js';
import * as path from 'node:path';

/**
 * HITL (Human-In-The-Loop) TPL Demo
 * Waits for a REAL Slack message to continue terminal work.
 */

const STIMULI_PATH = path.join(process.cwd(), 'presence/bridge/runtime/stimuli.jsonl');

async function waitForUserReply(timeoutMs = 60000): Promise<string | null> {
  logger.info(`⏳ Waiting for user reply in ${STIMULI_PATH}...`);
  const startTime = Date.now();
  
  // Ensure the directory exists
  const dir = path.dirname(STIMULI_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  if (!safeExistsSync(STIMULI_PATH)) safeWriteFile(STIMULI_PATH, '');

  let lastSize = safeStat(STIMULI_PATH).size;

  while (Date.now() - startTime < timeoutMs) {
    const currentSize = safeStat(STIMULI_PATH).size;
    if (currentSize > lastSize) {
      const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
      const lines = content.trim().split('\n');
      const lastLine = JSON.parse(lines[lines.length - 1]);
      logger.info(`📥 [HITL] Received reply: "${lastLine.signal.payload}" from ${lastLine.origin.source_id}`);
      return lastLine.signal.payload;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function runHITLLifecycle() {
  const channelId = 'C0AJ7EHH8BB';
  const myThreadId = 'hitl-real-test-777';
  
  logger.info('🎬 Starting REAL HITL TPL Demo...');

  // 1. Start Terminal
  const { sessionId } = await terminal({
    action: 'spawn',
    params: { threadId: myThreadId, shell: '/bin/sh' }
  });

  // 2. Initial Message
  await presence({
    action: 'dispatch',
    params: {
      channel: channelId,
      mode: 'emitter',
      payload: { text: `👋 *Kyberion HITL Mode 始動*\nこれより実機の双方向テストを開始します。スレッド: \`${myThreadId}\`` }
    }
  });

  // 3. Simulated Error and QUESTION
  await terminal({
    action: 'write',
    params: { sessionId, data: 'echo "Critical Update Required..." && echo "WAITING_FOR_USER_PERMISSION"\r' }
  });

  await presence({
    action: 'dispatch',
    params: {
      channel: channelId,
      mode: 'conversational',
      payload: { text: `❓ *主権者への確認 (Thread: ${myThreadId})*\n重要なシステムアップデートが必要です。実行してもよろしいですか？\n（*Slack で何か返信してください。その内容を検知して作業を続行します*）` }
    }
  });

  // 4. WAIT FOR REAL REPLY
  const userReply = await waitForUserReply(120000); // Wait up to 2 mins

  if (userReply) {
    logger.info(`[HITL_PROCEED] Resuming based on user reply: ${userReply}`);
    await terminal({
      action: 'write',
      params: { sessionId, data: `echo "Proceeding with action: ${userReply}" && echo "Update complete." && echo "Finalizing..."\r` }
    });
  } else {
    logger.warn('[HITL_TIMEOUT] No reply detected within timeout.');
    await terminal({
      action: 'write',
      params: { sessionId, data: 'echo "Operation cancelled due to timeout."\r' }
    });
  }

  // 5. Final Report
  await new Promise(r => setTimeout(r, 2000));
  const { output } = await terminal({ action: 'poll', params: { sessionId } });
  
  await presence({
    action: 'dispatch',
    params: {
      channel: channelId,
      mode: 'emitter',
      payload: { text: `✅ *HITL テスト終了*\n最終状態:\n\`\`\`\n${output}\n\`\`\`` }
    }
  });

  await terminal({ action: 'kill', params: { sessionId } });
  logger.info('🏁 HITL Demo finished.');
}

runHITLLifecycle().catch(console.error);
