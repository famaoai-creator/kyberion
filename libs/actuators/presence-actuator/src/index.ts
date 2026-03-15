import { logger } from '../../../core/index.js';
import { createStandardYargs } from '../../../core/cli-utils.js';
import { safeReadFile } from '../../../core/secure-io.js';
import { WebClient } from '@slack/web-api';
import * as path from 'node:path';

/**
 * Helper to safely access global ptyEngine
 */
const getPtyEngine = () => {
  const key = Symbol.for('@kyberion/pty-engine');
  const engine = (globalThis as any)[key];
  if (!engine) {
    throw new Error('PTY Engine singleton not found in globalThis. Ensure libs/core/pty-engine is loaded.');
  }
  return engine;
};

export type MessagingMode = 'emitter' | 'listener' | 'conversational';

interface PresenceAction {
  action: 'dispatch' | 'status' | 'receive_event';
  params: {
    channel: string; 
    mode?: MessagingMode;
    payload: {
      text?: string;
      attachments?: any[];
      threadId?: string;
      targetPersona?: string;
      from?: string;
      event_type?: string;
      event_data?: any;
    };
  };
}

export async function handleAction(input: PresenceAction) {
  const { action, params } = input;

  const botToken = process.env.SLACK_BOT_TOKEN;
  const slack = botToken ? new WebClient(botToken) : null;

  switch (action) {
    case 'receive_event': {
      logger.info(`[PRESENCE] Received UI Event: ${params.payload.event_type} from ${params.channel}`);
      
      if (params.payload.threadId) {
        getPtyEngine().pushMessage(
          params.payload.threadId,
          `ui:${params.channel}`,
          params.payload.targetPersona || 'KYBERION-PRIME',
          { 
            type: 'a2ui_action', 
            event: params.payload.event_type, 
            data: params.payload.event_data 
          }
        );
        return { status: 'routed_to_ism', threadId: params.payload.threadId };
      }
      return { status: 'ignored', reason: 'no_thread_id' };
    }

    case 'dispatch': {
      logger.info(`[PRESENCE] Dispatching to ${params.channel} (Mode: ${params.mode})`);

      if (params.payload.threadId) {
        getPtyEngine().pushMessage(
          params.payload.threadId, 
          params.payload.from || 'system', 
          params.payload.targetPersona || '*', 
          params.payload.text
        );
      }

      if (!slack) {
        logger.warn('⚠️ SLACK_BOT_TOKEN not found in environment. Falling back to log-only.');
        logger.info(`[PRESENCE_LOG] >> ${params.payload.text}`);
        return { status: 'logged', text: params.payload.text };
      }

      try {
        const result = await slack.chat.postMessage({
          channel: params.channel,
          text: params.payload.text || '',
          thread_ts: params.payload.threadId
        });

        logger.info(`✅ [PRESENCE_SLACK] Message sent to ${params.channel}. TS: ${result.ts}`);
        
        if (params.mode === 'conversational') {
          return { 
            status: 'waiting', 
            conversationId: result.ts,
            channel: params.channel,
            originalText: params.payload.text
          };
        }

        return { status: 'sent', ts: result.ts };
      } catch (err: any) {
        logger.error(`❌ [PRESENCE_SLACK] Failed to send message: ${err.message}`);
        throw err;
      }
    }

    default:
      throw new Error(`Unsupported presence action: ${action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  
  const inputPath = path.resolve(process.cwd(), argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
