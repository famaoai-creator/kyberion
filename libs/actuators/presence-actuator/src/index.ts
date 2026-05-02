import { logger, recordInteraction, resolveServiceBinding, safeReadFile, validatePresenceTimeline, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { WebClient } from '@slack/web-api';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  action: 'dispatch' | 'status' | 'receive_event' | 'dispatch_timeline' | 'record_interaction';
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
      timeline?: any;
      // record_interaction params
      person_slug?: string;
      org?: string;
      summary?: string;
      tone_shifts?: string[];
    };
  };
}

export async function handleAction(input: PresenceAction) {
  const { action, params } = input;

  let slack: WebClient | null = null;
  try {
    const binding = resolveServiceBinding('slack', 'secret-guard');
    if (binding.accessToken) {
      slack = new WebClient(binding.accessToken);
    }
  } catch (_) {
    slack = null;
  }

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
        logger.warn('⚠️ Slack service binding not found. Falling back to log-only.');
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

    case 'dispatch_timeline': {
      const timeline = validatePresenceTimeline(params.payload.timeline);
      const bridgeUrl = process.env.KYBERION_A2UI_BRIDGE_URL || 'http://127.0.0.1:3031';
      const response = await fetch(`${bridgeUrl}/api/timeline/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(timeline),
      });
      if (!response.ok) {
        throw new Error(`Presence timeline dispatch failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      return { status: 'timeline_dispatched', ...body };
    }

    case 'record_interaction': {
      const { person_slug, org, summary, tone_shifts } = params.payload;
      if (!person_slug || !org || !summary) {
        throw new Error('[PRESENCE] record_interaction requires person_slug, org, and summary');
      }
      const node = recordInteraction({
        personSlug: person_slug,
        org,
        source: 'presence-actuator',
        interaction: {
          at: new Date().toISOString(),
          summary,
          channel: params.channel,
          ...(tone_shifts ? { tone_shifts } : {}),
        },
      });
      logger.info(`[PRESENCE] recorded interaction with ${org}/${person_slug} (${node.history.length} entries)`);
      return { status: 'interaction_recorded', person_slug, org, history_length: node.history.length };
    }

    default:
      throw new Error(`Unsupported presence action: ${action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
