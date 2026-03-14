import { handleAction as terminal } from '../libs/actuators/terminal-actuator/src/index.js';
import { handleAction as presence } from '../libs/actuators/presence-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

/**
 * Terminal-Presence Lifecycle (TPL) Real Slack Demo
 * Orchestrates physical work (Terminal) and real human interaction (Slack).
 */

async function runTPLLifecycle() {
  const channelId = 'C0AJ7EHH8BB'; // target channel
  logger.info(`🎬 Starting Real Slack TPL Demo on channel ${channelId}...`);

  // --- PHASE 1: Initialization ---
  const myThreadId = 'tpl-real-test-001';
  logger.info(`[TPL_PHASE_1] Initializing thread: ${myThreadId}`);

  const { sessionId } = await terminal({
    action: 'spawn',
    params: { threadId: myThreadId, shell: '/bin/sh' }
  });

  await presence({
    action: 'dispatch',
    params: {
      channel: channelId,
      mode: 'emitter',
      payload: { text: `🚀 *Kyberion 稼働開始*\nターミナル・スレッド \`${myThreadId}\` を初期化しました。実機テストを開始します。` }
    }
  });

  // --- PHASE 2: Execution & Observation ---
  logger.info('[TPL_PHASE_2] Executing tasks...');
  
  await terminal({
    action: 'write',
    params: { sessionId, data: 'echo "Compiling Kyberion Core..." && sleep 2 && echo "ERROR: Physical sensor connection lost (sensor_id: cam_01)"\r' }
  });

  await new Promise(r => setTimeout(r, 3000));
  const { output } = await terminal({ action: 'poll', params: { sessionId } });
  logger.info(`[TERMINAL_OBSERVATION]:\n${output}`);

  if (output.includes('ERROR')) {
    // --- PHASE 3: Intervention ---
    logger.info('[TPL_PHASE_3] Error detected. Notifying Slack for intervention.');
    
    await presence({
      action: 'dispatch',
      params: {
        channel: channelId,
        mode: 'conversational',
        payload: { text: `⚠️ *異常検知 (Thread: ${myThreadId})*\n\`cam_01\` との接続が切れました。再接続（Reset）を試みますか？\n（※実機テストのため、このまま作業を擬似継続します）` }
      }
    });

    logger.info('[TPL_WAIT] Simulated user intervention delay...');
    await new Promise(r => setTimeout(r, 2000));
    logger.info(`[PRESENCE_IN] << User notified.`);

    logger.info('[TPL_RESUME] Resuming work...');
    await terminal({
      action: 'write',
      params: { sessionId, data: 'echo "Resetting cam_01..." && echo "Connection restored." && echo "Finalizing mission..."\r' }
    });
  }

  // --- PHASE 4: Conclusion ---
  await new Promise(r => setTimeout(r, 2000));
  const finalLog = await terminal({ action: 'poll', params: { sessionId } });
  logger.info(`[FINAL_TERMINAL_STATE]:\n${finalLog.output}`);

  await presence({
    action: 'dispatch',
    params: {
      channel: channelId,
      mode: 'emitter',
      payload: { text: `✅ *ミッション完了*\nスレッド \`${myThreadId}\` の作業が正常に終了しました。物理状態は安定しています。` }
    }
  });

  await terminal({ action: 'kill', params: { sessionId } });
  logger.info('🏁 TPL Real Slack Demo complete.');
}

runTPLLifecycle().catch(err => {
  logger.error(`Demo failed: ${err.message}`);
});
