import { logger } from '@agent/core/core';
import { recordInteraction } from '@agent/core/relationship-graph-store';
import { resolveServiceBinding } from '@agent/core/service-binding';
import { validatePresenceTimeline } from '@agent/core/presence-surface';
import * as pathResolver from '@agent/core/path-resolver';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { retry } from '@agent/core/async-utils';
import { secureFetch } from '@agent/core/network';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { isRecord } from '@agent/core/foundation/text';
import { enqueueSurfaceOutboxMessage } from '@agent/core/surface-coordination-store';
import type { SurfaceAsyncChannel } from '@agent/core/channel-surface-types';
import { WebClient } from '@slack/web-api';

const PRESENCE_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/presence-actuator/manifest.json'
);
const DEFAULT_PRESENCE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

/**
 * Helper to safely access global ptyEngine
 */
const getPtyEngine = () => {
  const key = Symbol.for('@kyberion/pty-engine');
  const engine = (globalThis as any)[key];
  if (!engine) {
    throw new Error(
      'PTY Engine singleton not found in globalThis. Ensure libs/core/pty-engine is loaded.'
    );
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
      person_slug?: string;
      org?: string;
      summary?: string;
      tone_shifts?: string[];
    };
  };
}

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: PRESENCE_MANIFEST_PATH,
  defaults: DEFAULT_PRESENCE_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

export type PresenceSatelliteSurface = 'telegram' | 'discord' | 'imessage';

export interface PresenceDispatchRoute {
  surface: 'slack' | PresenceSatelliteSurface;
  channel: string;
  via: 'slack' | 'satellite-outbox';
}

const SATELLITE_SURFACES = new Set<PresenceSatelliteSurface>(['telegram', 'discord', 'imessage']);

/**
 * Slack is the default presence backend.
 * Prefix the channel to forward through an existing satellite outbox:
 * `telegram:<chatId>`, `discord:<channelId>`, `imessage:<chatId>`.
 * Optional `slack:<id>` keeps the Slack WebClient path.
 */
export function resolvePresenceDispatchRoute(channel: string): PresenceDispatchRoute {
  const trimmed = channel.trim();
  const match = /^(slack|telegram|discord|imessage):(.*)$/i.exec(trimmed);
  if (!match) {
    return { surface: 'slack', channel: trimmed, via: 'slack' };
  }
  const surface = match[1].toLowerCase() as PresenceDispatchRoute['surface'];
  const dest = match[2].trim();
  if (!dest) {
    throw new Error(`[PRESENCE] ${surface} channel id is empty. Use ${surface}:<id>.`);
  }
  if (SATELLITE_SURFACES.has(surface as PresenceSatelliteSurface)) {
    return {
      surface: surface as PresenceSatelliteSurface,
      channel: dest,
      via: 'satellite-outbox',
    };
  }
  return { surface: 'slack', channel: dest, via: 'slack' };
}

export function normalizeTimelineDispatchResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('[PRESENCE] timeline dispatch response must be a JSON object');
  }
  return value;
}

export async function handleAction(input: PresenceAction) {
  const { action } = input;
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `presence:${action}`,
    params: input.params || {},
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation presence:${action} was not admitted.`}`
    );
  }
  const params = preflight.input as PresenceAction['params'];

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
      logger.info(
        `[PRESENCE] Received UI Event: ${params.payload.event_type} from ${params.channel}`
      );

      if (params.payload.threadId) {
        getPtyEngine().pushMessage(
          params.payload.threadId,
          `ui:${params.channel}`,
          params.payload.targetPersona || 'KYBERION-PRIME',
          {
            type: 'a2ui_action',
            event: params.payload.event_type,
            data: params.payload.event_data,
          }
        );
        return { status: 'routed_to_ism', threadId: params.payload.threadId };
      }
      return { status: 'ignored', reason: 'no_thread_id' };
    }

    case 'dispatch': {
      const route = resolvePresenceDispatchRoute(params.channel);
      logger.info(
        `[PRESENCE] Dispatching to ${route.surface}:${route.channel} (Mode: ${params.mode}, via: ${route.via})`
      );

      if (params.payload.threadId) {
        getPtyEngine().pushMessage(
          params.payload.threadId,
          params.payload.from || 'system',
          params.payload.targetPersona || '*',
          params.payload.text
        );
      }

      if (route.via === 'satellite-outbox') {
        const text = params.payload.text || '';
        const messagePath = enqueueSurfaceOutboxMessage({
          surface: route.surface as SurfaceAsyncChannel,
          correlationId: `presence-${Date.now().toString(36)}`,
          channel: route.channel,
          threadTs: params.payload.threadId || '',
          text,
          source: 'system',
        });
        logger.info(
          `✅ [PRESENCE_SATELLITE] Queued ${route.surface} outbox for ${route.channel}. ${messagePath}`
        );
        return {
          status: 'queued_satellite',
          surface: route.surface,
          channel: route.channel,
          via: 'satellite-outbox',
        };
      }

      if (!slack) {
        logger.warn('⚠️ Slack service binding not found. Falling back to log-only.');
        logger.info(`[PRESENCE_LOG] >> ${params.payload.text}`);
        return { status: 'logged', text: params.payload.text };
      }

      try {
        const result = await retry(
          async () =>
            slack.chat.postMessage({
              channel: route.channel,
              text: params.payload.text || '',
              thread_ts: params.payload.threadId,
            }),
          buildRetryOptions()
        );

        logger.info(`✅ [PRESENCE_SLACK] Message sent to ${route.channel}. TS: ${result.ts}`);

        if (params.mode === 'conversational') {
          return {
            status: 'waiting',
            conversationId: result.ts,
            channel: route.channel,
            originalText: params.payload.text,
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
      const bridgeUrl = getRegisteredEnvText('KYBERION_A2UI_BRIDGE_URL') || 'http://127.0.0.1:3031';
      const body: unknown = await retry(
        async () =>
          secureFetch({
            method: 'POST',
            url: `${bridgeUrl}/api/timeline/dispatch`,
            headers: { 'Content-Type': 'application/json' },
            data: timeline,
            kyberion_allow_local_network: true,
          }),
        buildRetryOptions()
      );
      return { status: 'timeline_dispatched', ...normalizeTimelineDispatchResponse(body) };
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
          at: nowIso(),
          summary,
          channel: params.channel,
          ...(tone_shifts ? { tone_shifts } : {}),
        },
      });
      logger.info(
        `[PRESENCE] recorded interaction with ${org}/${person_slug} (${node.history.length} entries)`
      );
      return {
        status: 'interaction_recorded',
        person_slug,
        org,
        history_length: node.history.length,
      };
    }

    default:
      throw new Error(`Unsupported presence action: ${action}`);
  }
}
