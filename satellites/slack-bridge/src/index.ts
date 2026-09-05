import { App, LogLevel } from '@slack/bolt';
import { installProcessGuards } from '@agent/core/process-guards';
import { isDirectEntry } from '@agent/core/direct-entry';
import { appendJsonLine, getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('slack-bridge');
import { logger } from '@agent/core/core';
import * as pathResolver from '@agent/core/path-resolver';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import {
  emitChannelSurfaceEvent,
  recordSlackDelivery,
  recordSlackSurfaceArtifact,
} from '@agent/core/surface-artifact-store';
import { resolveServiceBinding } from '@agent/core/service-binding';
import {
  prepareSlackSurfaceArtifact,
  runSurfaceMessageConversation,
} from '@agent/core/channel-surface';
import {
  formatChannelThreadContext,
  runChannelTurn,
  type ChannelAdapter,
  type ChannelTypingHandle,
  type RunChannelTurnOptions,
} from '@agent/core/channel-adapter';
import type { SurfaceConversationResult } from '@agent/core/channel-surface-types';
import { recordSlackKnowledgeReaction } from '@agent/core/knowledge-feedback-loop';
import { createSurfaceOutboxDrainGuard, drainSurfaceOutbox } from '@agent/core/surface-delivery';
import { deriveSlackDelegationReceiver } from '@agent/core/surface-runtime-router';
import {
  buildSlackOnboardingBlocks,
  buildSlackOnboardingModal,
  handleSlackOnboardingTurn,
  isEnvironmentInitialized,
  parseSlackOnboardingAction,
} from '@agent/core/slack-onboarding';
import {
  buildMissionIssuanceReply,
  clearSlackMissionProposalState,
  getSlackMissionProposalState,
  isSlackMissionConfirmation,
  isSlackMissionRejection,
  issueSlackMissionFromProposal,
  saveSlackMissionProposalState,
} from '@agent/core/surface-mission-proposals';
import {
  buildSlackApprovalAskWhyBlocks,
  buildSlackApprovalBlocks,
  createSlackApprovalRequest,
  parseSlackApprovalAction,
  parseSlackAskWhyAction,
} from '@agent/core/slack-approval-ui';
import {
  applySurfaceApprovalDecision,
  resolveSurfaceApprovalAskWhy,
} from '@agent/core/surface-approval-ui';
import {
  buildSlackMissionProposalBlocks,
  parseSlackMissionProposalAction,
  slackMissionProposalFallbackText,
} from '@agent/core/slack-mission-proposal-ui';
import { dispatchPresenceFrame } from '@agent/core/presence-bridge';
import {
  buildBridgeEmptyReplyText,
  chunkSurfaceMessage,
  postBridgeError,
  sendSurfaceTextWithFallback,
} from '@agent/core/bridge-error-reply';
import { resolveCustomerBinding } from '@agent/core/customer-channel-binding';
import { runCustomerConversation } from '@agent/core/customer-conversation';
import { evaluateSurfaceActorAccess } from '@agent/core/surface-access-policy';
import { renderIntentAuthorityLabel } from '@agent/core/intent-resolution-contract';
import {
  buildAutomationSlackModal,
  extractAutomationSlackFormValues,
  parseAutomationSlackModalMetadata,
} from '@agent/core/automation-blueprint-slack';
import {
  findAutomationBlueprint,
  parseAutomationSlashRequest,
  registerAutomationBlueprint,
} from '@agent/core/automation-blueprint';
import { t } from '@agent/core/t';

type SlackClient = InstanceType<typeof App>['client'];
type SlackModalView = NonNullable<Parameters<SlackClient['views']['open']>[0]['view']>;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readValueAt(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readStringAt(value: unknown, path: readonly string[]): string {
  const resolved = readValueAt(value, path);
  return typeof resolved === 'string' ? resolved : '';
}

/**
 * Slack Sensory Satellite (Socket Mode) v1.0
 * Ingests Slack messages as GUSP v2.0 Stimuli.
 */

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const SLACK_SURFACE_AGENT_ID = 'slack-surface-agent';

function recordSlackConversationOutcome(params: {
  correlationId: string;
  channel: string;
  threadTs: string;
  sourceText: string;
  route: 'surface' | 'nerve';
  outcome: 'approval_request' | 'mission_proposal' | 'plain_reply' | 'empty_reply';
  approvalCount?: number;
  missionProposalCount?: number;
}) {
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'events', {
    correlation_id: params.correlationId,
    decision: 'conversation_outcome_recorded',
    why: 'Slack bridge recorded the post-conversation outcome so operator surfaces can distinguish proposal, approval, and plain reply paths.',
    policy_used: 'slack_surface_agent_v1',
    agent_id: params.route === 'nerve' ? 'nerve-agent' : SLACK_SURFACE_AGENT_ID,
    resource_id: params.threadTs,
    slack_channel: params.channel,
    thread_ts: params.threadTs,
    route: params.route,
    outcome: params.outcome,
    approval_count: params.approvalCount || 0,
    mission_proposal_count: params.missionProposalCount || 0,
    source_text: params.sourceText.slice(0, 240),
  });
}

interface SlackThreadMessage {
  text?: unknown;
  bot_id?: unknown;
  user?: unknown;
  username?: unknown;
  ts?: unknown;
}

interface SlackThreadRepliesClient {
  conversations?: {
    replies?: (input: {
      channel: string;
      ts: string;
      limit: number;
    }) => Promise<{ messages?: SlackThreadMessage[] }>;
  };
}

interface SlackReactionClient {
  reactions: {
    add(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
}

/**
 * UX-02: Slack has no bot typing API, so use a short-lived reaction as the
 * provider-specific typing handle. Creating the handle is deliberately part
 * of `runChannelTurn` after thread context has been resolved; a failed history
 * lookup must not leave an orphaned 👀 reaction on the user's message.
 */
export async function createSlackTypingHandle(
  client: SlackReactionClient,
  channel: string,
  timestamp: string
): Promise<ChannelTypingHandle> {
  let added = false;
  try {
    await client.reactions.add({ channel, timestamp, name: 'eyes' });
    added = true;
  } catch (reactionErr: unknown) {
    logger.warn(`[SlackBridge] typing reaction failed: ${errorDetail(reactionErr)}`);
  }

  return {
    async stop() {
      if (!added) return;
      added = false;
      try {
        await client.reactions.remove({ channel, timestamp, name: 'eyes' });
      } catch {
        // The reaction may already be gone; this is cosmetic state.
      }
    },
  };
}

export async function collectSlackThreadContext(
  client: SlackThreadRepliesClient,
  channel: string,
  threadTs: string,
  currentTs: string
): Promise<string | undefined> {
  if (threadTs === currentTs || !client.conversations?.replies) return undefined;

  try {
    const response = await client.conversations.replies({ channel, ts: threadTs, limit: 8 });
    const entries = (response.messages || [])
      .filter((message) => String(message.ts || '') !== currentTs)
      .map((message) => ({
        role: message.bot_id ? ('assistant' as const) : ('user' as const),
        authorLabel: String(message.username || message.user || 'unknown'),
        text: String(message.text || ''),
      }));
    return formatChannelThreadContext('Slack', entries);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️ [SlackBridge] Failed to fetch thread history: ${message}`);
    return undefined;
  }
}

export interface SlackChannelTurnRequest {
  text: string;
  channel: string;
  threadTs: string;
  correlationId: string;
  receivedAt: string;
  actorId: string;
  forcedReceiver?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Run one Slack turn on the shared channel adapter.
 *
 * The conversation callback MUST forward `threadContext`: Slack collects it
 * from `conversations.replies` via the adapter, and dropping it here silently
 * made every threaded Slack reply context-free (unlike Telegram/Discord).
 */
export function runSlackChannelTurn(
  adapter: ChannelAdapter,
  request: SlackChannelTurnRequest,
  options: RunChannelTurnOptions = {}
): Promise<SurfaceConversationResult> {
  return runChannelTurn(
    adapter,
    { text: request.text, channel: request.channel, threadTs: request.threadTs },
    ({ threadContext }) =>
      runSurfaceMessageConversation({
        surface: 'slack',
        text: request.text,
        channel: request.channel,
        threadTs: request.threadTs,
        correlationId: request.correlationId,
        receivedAt: request.receivedAt,
        actorId: request.actorId,
        senderAgentId: 'kyberion:slack-bridge',
        agentId: SLACK_SURFACE_AGENT_ID,
        forcedReceiver: request.forcedReceiver,
        threadContext,
        delegationSummaryInstruction:
          'Below are delegated responses. Produce the final Slack reply in the user language. Keep it concise and channel-appropriate. Do not emit any A2A blocks.',
        metadata: request.metadata,
      }),
    options
  );
}

async function postOnboardingReply(
  client: SlackClient,
  channel: string,
  threadTs: string,
  text: string,
  completed: boolean
) {
  const blocks = completed ? undefined : buildSlackOnboardingBlocks(channel, threadTs);
  return postSlackTextWithBlocks(client, { channel, thread_ts: threadTs, text, blocks });
}

async function postSlackTextWithBlocks(
  client: SlackClient,
  params: { channel: string; thread_ts?: string; text: string; blocks?: unknown[] }
) {
  return sendSurfaceTextWithFallback({
    surface: 'slack',
    text: params.text,
    send: ({ text, format }) =>
      client.chat.postMessage({
        ...params,
        text,
        ...(format === 'plain' ? { blocks: undefined, mrkdwn: false } : {}),
      }),
  });
}

async function postSlackText(
  client: SlackClient,
  params: { channel: string; thread_ts?: string; text: string }
) {
  let response;
  for (const chunk of chunkSurfaceMessage(params.text, 'slack')) {
    response = await sendSurfaceTextWithFallback({
      surface: 'slack',
      text: chunk,
      send: ({ text, format }) =>
        client.chat.postMessage({
          ...params,
          text,
          ...(format === 'plain' ? { mrkdwn: false } : {}),
        }),
    });
  }
  return response;
}

async function postApprovalRequest(
  client: SlackClient,
  params: {
    channel: string;
    threadTs: string;
    correlationId: string;
    requestedBy: string;
    draft: {
      title: string;
      summary: string;
      details?: string;
      severity?: 'low' | 'medium' | 'high';
    };
    sourceText?: string;
    intentResolution?: import('@agent/core/intent-resolution-contract').IntentResolutionContract;
  }
) {
  const record = createSlackApprovalRequest(params);
  return postSlackTextWithBlocks(client, {
    channel: params.channel,
    thread_ts: params.threadTs,
    text: [
      `Approval required: ${record.title}`,
      ...(params.intentResolution
        ? [
            `Authority: ${renderIntentAuthorityLabel(
              params.intentResolution.authority_level,
              resolveOperatorLocale()
            )}`,
            `Next action: ${params.intentResolution.next_action.label}`,
          ]
        : []),
    ].join('\n'),
    blocks: buildSlackApprovalBlocks(record, params.intentResolution),
  });
}

async function reflectSlackPresence(params: {
  status: string;
  expression: string;
  subtitle: string;
  transcript?: Array<{ speaker: string; text: string }>;
}) {
  try {
    await dispatchPresenceFrame({
      agentId: SLACK_SURFACE_AGENT_ID,
      title: 'Presence Studio',
      status: params.status,
      expression: params.expression,
      subtitle: params.subtitle,
      transcript: params.transcript || [],
    });
  } catch (error: unknown) {
    logger.warn(
      `⚠️ [SlackBridge] Presence reflect failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function automationRegistrationReply(
  registration: ReturnType<typeof registerAutomationBlueprint>
): string {
  const scheduled = registration.scheduled;
  if (!scheduled) {
    return t('bridge:automation_missing_bindings', undefined, 'ja');
  }
  const delivery = scheduled.deliver_to
    ? ` → ${scheduled.deliver_to.surface}:${scheduled.deliver_to.channel}`
    : '';
  return [
    `スケジュールを登録しました: ${scheduled.name}`,
    `cron: ${scheduled.trigger.cron}${scheduled.trigger.timezone ? ` (${scheduled.trigger.timezone})` : ''}${delivery}`,
  ].join('\n');
}

async function postAutomationReply(
  client: SlackClient,
  params: { channel: string; user: string; threadTs?: string; text: string }
): Promise<void> {
  await client.chat.postEphemeral({
    channel: params.channel,
    user: params.user,
    text: params.text,
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
  });
}

function formatSlackMissionIssuedReply(
  issued: Awaited<ReturnType<typeof issueSlackMissionFromProposal>>
): string {
  return buildMissionIssuanceReply(issued, {
    locale: resolveOperatorLocale(),
    includeDetails: true,
  });
}

async function processSlackOutbox(client: SlackClient) {
  return drainSurfaceOutbox(
    'slack',
    async (message) => {
      const response = await postSlackText(client, {
        channel: message.channel,
        thread_ts: message.thread_ts || undefined,
        text: message.text,
      });
      if (!response) throw new Error('Slack outbox delivery returned no response.');
      recordSlackDelivery(
        message.correlation_id,
        message.channel,
        message.thread_ts,
        response.ts,
        message.source
      );
    },
    { includeTenantNamespaces: true }
  );
}

const runSlackOutbox = createSurfaceOutboxDrainGuard('slack');

async function start() {
  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'slack_bridge');
  }
  const binding = resolveServiceBinding('slack', 'secret-guard');
  const appToken = binding.appToken;
  const botToken = binding.accessToken;

  if (!appToken || !botToken) {
    logger.error('❌ Missing Slack service binding (access token or app token).');
    process.exitCode = 1;
    return;
  }

  const app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // HA-03: register a schedule from the same Blueprint contract used by the
  // question/slash/form preview surfaces. The bridge only handles Slack
  // authorization and transport; validation and registry writes stay in core.
  app.command('/kyberion', async ({ ack, command, client, respond }) => {
    await ack();
    const actorId = readStringAt(command, ['user_id']);
    const channel = readStringAt(command, ['channel_id']);
    try {
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed)
        throw new Error(`Unauthorized Slack automation request: ${access.reason}`);
      if (!channel || !actorId)
        throw new Error('Slack automation request is missing actor or channel.');

      const request = parseAutomationSlashRequest(readStringAt(command, ['text']));
      const entry = findAutomationBlueprint(request.blueprint_id);
      const values: Record<string, string> = { ...request.values };
      const deliverySlot = entry.blueprint.delivery?.channel_slot;
      if (deliverySlot && !Object.hasOwn(values, deliverySlot)) values[deliverySlot] = channel;

      if (request.open_form) {
        const triggerId = readStringAt(command, ['trigger_id']);
        if (!triggerId) throw new Error('Slack automation form requires a trigger_id.');
        await client.views.open({
          trigger_id: triggerId,
          view: buildAutomationSlackModal(
            entry.blueprint,
            {
              blueprint_id: entry.blueprint.blueprint_id,
              pipeline_ref: entry.blueprint.pipeline_ref,
              channel,
              thread_ts: '',
              actor_id: actorId,
            },
            values
            // Core owns the provider-neutral modal shape; this is the single
            // typed Slack API boundary for that already-validated payload.
          ) as unknown as SlackModalView,
        });
        return;
      }

      const registration = registerAutomationBlueprint(entry, values);
      await respond({
        response_type: 'ephemeral',
        text: automationRegistrationReply(registration),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await respond({
        response_type: 'ephemeral',
        text: `スケジュール登録を実行できませんでした: ${detail}`,
      });
    }
  });

  app.view('kyberion_automation_submit', async ({ ack, body, view, client }) => {
    await ack();
    let metadata;
    let actorId = '';
    try {
      metadata = parseAutomationSlackModalMetadata(readStringAt(view, ['private_metadata']));
      actorId = readStringAt(body, ['user', 'id']);
      if (actorId !== metadata.actor_id) throw new Error('Slack automation modal actor mismatch.');
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed)
        throw new Error(`Unauthorized Slack automation request: ${access.reason}`);

      const entry = findAutomationBlueprint(metadata.blueprint_id);
      if (entry.blueprint.pipeline_ref !== metadata.pipeline_ref) {
        throw new Error('Slack automation modal pipeline reference mismatch.');
      }
      const values = extractAutomationSlackFormValues(
        entry.blueprint,
        readValueAt(view, ['state', 'values'])
      );
      const deliverySlot = entry.blueprint.delivery?.channel_slot;
      if (deliverySlot && !Object.hasOwn(values, deliverySlot))
        values[deliverySlot] = metadata.channel;
      const registration = registerAutomationBlueprint(entry, values);
      await postAutomationReply(client, {
        channel: metadata.channel,
        user: actorId,
        threadTs: metadata.thread_ts,
        text: automationRegistrationReply(registration),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const canNotify =
        metadata?.channel &&
        metadata?.actor_id &&
        actorId === metadata.actor_id &&
        evaluateSurfaceActorAccess('slack', actorId).allowed;
      if (canNotify && metadata) {
        await postAutomationReply(client, {
          channel: metadata.channel,
          user: metadata.actor_id,
          threadTs: metadata.thread_ts,
          text: `スケジュール登録を実行できませんでした: ${detail}`,
        });
      } else {
        logger.error(`❌ [SlackBridge] Automation modal handling failed: ${detail}`);
      }
    }
  });

  const outboxTimer = setInterval(() => {
    runSlackOutbox(() => processSlackOutbox(app.client)).catch((err: unknown) => {
      logger.error(`❌ [SlackBridge] Outbox poll failed: ${errorDetail(err)}`);
    });
  }, 3000);
  outboxTimer.unref?.();

  // 1. Listen for messages
  app.message(async ({ message, client }) => {
    // Only process text messages (ignore edits, deletes, etc. for now)
    if (!('text' in message) || !message.text) return;
    if (message.subtype) return; // Ignore bot messages or other subtypes
    const threadTs =
      'thread_ts' in message && typeof message.thread_ts === 'string'
        ? message.thread_ts
        : message.ts;
    const team = 'team' in message && typeof message.team === 'string' ? message.team : undefined;
    const channelType =
      'channel_type' in message && typeof message.channel_type === 'string'
        ? message.channel_type
        : undefined;
    const artifact = prepareSlackSurfaceArtifact({
      user: message.user,
      text: message.text,
      channel: message.channel,
      ts: message.ts,
      threadTs,
      team,
      channelType,
    });

    // E2E-06: bound customer channels run in customer mode BEFORE any operator
    // processing — customers must never reach the operator brain.
    const customerBinding = resolveCustomerBinding('slack', message.channel);
    if (customerBinding) {
      try {
        const conversation = await runCustomerConversation({
          binding: customerBinding,
          text: message.text,
          actorId: message.user,
          threadTs,
          correlationId: `slack-${message.ts}`,
        });
        if (conversation.text) {
          await postSlackText(client, {
            channel: message.channel,
            thread_ts: threadTs,
            text: conversation.text,
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(`❌ [SlackBridge] Customer conversation failed: ${detail}`);
        await postBridgeError({
          conversationKey: `slack-customer:${message.channel}:${threadTs}`,
          err,
          surface: 'slack',
          locale: customerBinding.binding.language || 'ja',
          post: (text) =>
            postSlackText(client, { channel: message.channel, thread_ts: threadTs, text }),
        });
      }
      return;
    }

    const access = evaluateSurfaceActorAccess('slack', message.user || '');
    if (!access.allowed) {
      logger.warn(
        `[SlackBridge] Ignored unauthorized message from sender: ${message.user || 'unknown'} (${access.reason})`
      );
      return;
    }

    // 3. Physical Ingestion (Evidence-as-State)
    try {
      logger.info(
        `📥 [SlackBridge] Ingesting stimulus ${artifact.stimulus.id} from ${message.user}`
      );
      recordSlackSurfaceArtifact(artifact);
      appendJsonLine(STIMULI_PATH, artifact.stimulus);

      const initialized = isEnvironmentInitialized();

      if (artifact.shouldAck || !initialized) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: initialized
            ? artifact.ackText
            : 'Received. This workspace is not initialized yet, so I will switch to onboarding mode.',
        });
      }

      if (!initialized) {
        const onboarding = handleSlackOnboardingTurn({
          channel: message.channel,
          threadTs,
          text: message.text,
        });

        const response = await postOnboardingReply(
          client,
          message.channel,
          threadTs,
          onboarding.replyText,
          onboarding.completed
        );
        recordSlackDelivery(
          artifact.correlationId,
          message.channel,
          threadTs,
          response.ts,
          'system'
        );
        return;
      }

      const pendingMissionProposal = getSlackMissionProposalState(message.channel, threadTs);
      if (pendingMissionProposal && isSlackMissionRejection(message.text)) {
        clearSlackMissionProposalState(message.channel, threadTs);
        const response = await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: 'ミッション提案をキャンセルしました。必要になったら、いつでも再提案できます。',
        });
        recordSlackDelivery(
          artifact.correlationId,
          message.channel,
          threadTs,
          response.ts,
          'system'
        );
        return;
      }
      if (pendingMissionProposal && isSlackMissionConfirmation(message.text)) {
        const issued = await issueSlackMissionFromProposal({
          channel: message.channel,
          threadTs,
          proposal: pendingMissionProposal.proposal,
          sourceText: pendingMissionProposal.sourceText,
          routingDecision: pendingMissionProposal.routingDecision,
        });
        clearSlackMissionProposalState(message.channel, threadTs);
        const response = await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: formatSlackMissionIssuedReply(issued),
        });
        recordSlackDelivery(
          artifact.correlationId,
          message.channel,
          threadTs,
          response.ts,
          'system'
        );
        return;
      }

      const forcedReceiver = deriveSlackDelegationReceiver(message.text);
      const route = forcedReceiver === 'nerve-agent' ? 'nerve' : 'surface';
      await reflectSlackPresence({
        status: 'thinking',
        expression: 'thinking',
        subtitle: 'Slack Surface is preparing a reply.',
        transcript: [{ speaker: 'Slack User', text: message.text }],
      });
      const channelAdapter: ChannelAdapter = {
        channel: 'slack',
        actorId: message.user,
        threadContext: () =>
          collectSlackThreadContext(client, message.channel, threadTs, message.ts),
        typing: () => createSlackTypingHandle(client, message.channel, message.ts),
        shouldSend: ({ result }) =>
          !result.missionProposals?.length && result.approvalRequests.length === 0,
        send: async ({ text }) => {
          const response = await postSlackText(client, {
            channel: message.channel,
            thread_ts: threadTs,
            text,
          });
          if (!response) throw new Error('Slack delivery returned no response.');
          recordSlackDelivery(
            artifact.correlationId,
            message.channel,
            threadTs,
            response.ts,
            route
          );
        },
      };
      // The `'text' in message` narrowing above is lost inside the afterTurn
      // closure under the per-package strict tsconfig; capture the text once.
      const sourceText = message.text;
      await runSlackChannelTurn(
        channelAdapter,
        {
          text: sourceText,
          channel: message.channel,
          threadTs,
          correlationId: artifact.correlationId,
          receivedAt: message.ts,
          actorId: message.user,
          forcedReceiver,
          metadata: {
            user: message.user,
            team,
            channelType,
          },
        },
        {
          // UX-02: the 👀 typing reaction must outlive the proposal and
          // approval envelopes this bridge posts itself — stopping typing
          // in runChannelTurn would clear it while work is still pending.
          afterTurn: async (conversation) => {
            if (conversation.approvalRequests.length > 0) {
              await reflectSlackPresence({
                status: 'thinking',
                expression: 'listening',
                subtitle: 'Slack Surface is waiting for approval.',
                transcript: [
                  {
                    speaker: 'Slack Surface',
                    text:
                      conversation.text ||
                      t('bridge:approval_required_fallback', undefined, resolveOperatorLocale()),
                  },
                ],
              });
              recordSlackConversationOutcome({
                correlationId: artifact.correlationId,
                channel: message.channel,
                threadTs,
                sourceText,
                route,
                outcome: 'approval_request',
                approvalCount: conversation.approvalRequests.length,
                missionProposalCount: conversation.missionProposals?.length || 0,
              });
              for (const approval of conversation.approvalRequests) {
                await postApprovalRequest(client, {
                  channel: message.channel,
                  threadTs,
                  correlationId: artifact.correlationId,
                  requestedBy: SLACK_SURFACE_AGENT_ID,
                  draft: approval,
                  sourceText,
                  intentResolution: conversation.intentResolution,
                });
              }
              return;
            }

            if (conversation.missionProposals && conversation.missionProposals.length > 0) {
              const proposal = conversation.missionProposals[0];
              await reflectSlackPresence({
                status: 'speaking',
                expression: 'thinking',
                subtitle: conversation.text || 'Slack Surface prepared a mission proposal.',
                transcript: [
                  {
                    speaker: 'Slack Surface',
                    text: conversation.text || 'I can turn this into a mission.',
                  },
                ],
              });
              recordSlackConversationOutcome({
                correlationId: artifact.correlationId,
                channel: message.channel,
                threadTs,
                sourceText,
                route,
                outcome: 'mission_proposal',
                approvalCount: conversation.approvalRequests.length,
                missionProposalCount: conversation.missionProposals.length,
              });
              saveSlackMissionProposalState({
                channel: message.channel,
                threadTs,
                proposal,
                sourceText,
                routingDecision: conversation.routingDecision,
              });
              const response = await postSlackTextWithBlocks(client, {
                channel: message.channel,
                thread_ts: threadTs,
                text: slackMissionProposalFallbackText(proposal, conversation.intentResolution),
                blocks: buildSlackMissionProposalBlocks(proposal, conversation.intentResolution),
              });
              recordSlackDelivery(
                artifact.correlationId,
                message.channel,
                threadTs,
                response.ts,
                route
              );
              return;
            }

            // Match the shared delivery gate in channel-adapter: a whitespace-only
            // reply is silence, so it must take the empty-reply path.
            if (conversation.text.trim()) {
              await reflectSlackPresence({
                status: 'speaking',
                expression: 'joy',
                subtitle: conversation.text,
                transcript: [{ speaker: 'Slack Surface', text: conversation.text }],
              });
              recordSlackConversationOutcome({
                correlationId: artifact.correlationId,
                channel: message.channel,
                threadTs,
                sourceText,
                route,
                outcome: 'plain_reply',
                approvalCount: conversation.approvalRequests.length,
                missionProposalCount: conversation.missionProposals?.length || 0,
              });
              return;
            }

            recordSlackConversationOutcome({
              correlationId: artifact.correlationId,
              channel: message.channel,
              threadTs,
              sourceText,
              route,
              outcome: 'empty_reply',
              approvalCount: conversation.approvalRequests.length,
              missionProposalCount: conversation.missionProposals?.length || 0,
            });
            // UX-01: an empty agent reply must not read as silence.
            await postSlackText(client, {
              channel: message.channel,
              thread_ts: threadTs,
              text: buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() }),
            });
          },
        }
      );
    } catch (err: unknown) {
      logger.error(`❌ [SlackBridge] Ingestion failed: ${errorDetail(err)}`);
      // UX-01: surface a vocabulary-based error to the user (rate-limited per thread).
      await postBridgeError({
        conversationKey: `slack:${message.channel}:${threadTs}`,
        err,
        surface: 'slack',
        locale: resolveOperatorLocale(),
        post: (text) =>
          postSlackText(client, { channel: message.channel, thread_ts: threadTs, text }),
      });
    }
  });

  app.event('reaction_added', async ({ event, client }) => {
    const actorId = readStringAt(event, ['user']);
    const channel = readStringAt(event, ['item', 'channel']);
    const messageTs = readStringAt(event, ['item', 'ts']);
    if (!channel || !messageTs || !actorId) return;
    const access = evaluateSurfaceActorAccess('slack', actorId);
    if (!access.allowed) {
      logger.warn(`[SlackBridge] Ignored unauthorized knowledge reaction from ${actorId}`);
      return;
    }
    try {
      const history = await client.conversations.history({
        channel,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      });
      const message = history.messages?.[0];
      const metadata =
        readValueAt(message, ['metadata', 'event_payload']) ||
        readValueAt(message, ['metadata']) ||
        {};
      const documentPath =
        readStringAt(metadata, ['knowledge_document_path']) ||
        readStringAt(metadata, ['document_path']) ||
        readStringAt(message, ['text']).match(
          /\b(knowledge\/(?:product|confidential|personal)\/[^\s>]+)/u
        )?.[1];
      if (!documentPath) return;
      const binding = resolveCustomerBinding('slack', channel);
      const target = recordSlackKnowledgeReaction({
        reaction: readStringAt(event, ['reaction']),
        document_path: documentPath,
        actor: actorId,
        channel,
        message_ts: messageTs,
        ...(binding ? { tenant_slug: binding.tenantSlug } : {}),
      });
      if (target) {
        emitChannelSurfaceEvent('slack_bridge', 'slack', 'events', {
          correlation_id: `slack-reaction-${messageTs}`,
          decision: 'knowledge_feedback_recorded',
          why: 'Slack reaction was translated into the governed human knowledge feedback loop.',
          policy_used: 'slack_knowledge_feedback_v1',
          agent_id: SLACK_SURFACE_AGENT_ID,
          resource_id: messageTs,
          slack_channel: channel,
          feedback_path: target,
          tenant_slug: binding?.tenantSlug,
          reaction: readStringAt(event, ['reaction']),
        });
      }
    } catch (error) {
      logger.warn(
        `[SlackBridge] Knowledge reaction ignored: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  app.action('slack_approval_decide', async ({ ack, action, body, client }) => {
    await ack();

    try {
      const payload = parseSlackApprovalAction(readStringAt(action, ['value']));
      const actorId = readStringAt(body, ['user', 'id']) || 'unknown';
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed) {
        logger.warn(
          `⚠️ [SlackBridge] Ignoring unauthorized approval action from ${actorId}: ${access.reason}`
        );
        return;
      }
      const channel = readStringAt(body, ['channel', 'id']);
      const threadTs =
        readStringAt(body, ['message', 'thread_ts']) || readStringAt(body, ['message', 'ts']);
      if (!channel || !threadTs) throw new Error('Slack approval action is missing channel/thread');
      const updated = applySurfaceApprovalDecision({
        surface: 'slack',
        requestId: payload.requestId,
        decision: payload.decision,
        channel,
        threadTs,
        decidedBy: actorId,
      });

      await client.chat.postMessage({
        channel: updated.channel,
        thread_ts: updated.threadTs,
        text:
          payload.decision === 'approved'
            ? `Approved by <@${actorId}>: ${updated.title}`
            : `Rejected by <@${actorId}>: ${updated.title}`,
      });
      // LC-10 ask-why: one skippable follow-up on rejection. Buttons keep
      // the reply deterministic — no pending-conversation state needed.
      if (payload.decision === 'rejected') {
        await client.chat.postMessage({
          channel: updated.channel,
          thread_ts: updated.threadTs,
          text: 'どこが期待と違いましたか？(スキップ可)',
          blocks: buildSlackApprovalAskWhyBlocks(updated.id),
        });
      }
    } catch (err: unknown) {
      logger.error(`❌ [SlackBridge] Approval decision handling failed: ${errorDetail(err)}`);
    }
  });

  app.action('slack_mission_proposal_decide', async ({ ack, action, body, client }) => {
    await ack();
    try {
      const payload = parseSlackMissionProposalAction(readStringAt(action, ['value']));
      const channel = readStringAt(body, ['channel', 'id']);
      const threadTs =
        readStringAt(body, ['message', 'thread_ts']) || readStringAt(body, ['message', 'ts']);
      const actorId = readStringAt(body, ['user', 'id']) || 'unknown';
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed) {
        logger.warn(
          `⚠️ [SlackBridge] Ignoring unauthorized mission proposal action from ${actorId}: ${access.reason}`
        );
        return;
      }
      if (!channel || !threadTs)
        throw new Error('Slack mission proposal action is missing channel/thread');

      const pending = getSlackMissionProposalState(channel, threadTs);
      if (!pending) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'このミッション提案はすでに処理済みか期限切れです。',
        });
        return;
      }

      clearSlackMissionProposalState(channel, threadTs);
      if (payload.decision === 'rejected') {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `ミッション提案をキャンセルしました（<@${actorId}>）。`,
        });
        return;
      }

      const issued = await issueSlackMissionFromProposal({
        channel,
        threadTs,
        proposal: pending.proposal,
        sourceText: pending.sourceText,
        routingDecision: pending.routingDecision,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: formatSlackMissionIssuedReply(issued),
      });
    } catch (err: unknown) {
      logger.error(
        `❌ [SlackBridge] Mission proposal decision handling failed: ${errorDetail(err)}`
      );
    }
  });

  app.action('slack_approval_askwhy', async ({ ack, action, body, client }) => {
    await ack();
    try {
      const payload = parseSlackAskWhyAction(readStringAt(action, ['value']));
      const actorId = readStringAt(body, ['user', 'id']) || 'unknown';
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed) {
        logger.warn(
          `⚠️ [SlackBridge] Ignoring unauthorized approval reason action from ${actorId}: ${access.reason}`
        );
        return;
      }
      const channel = readStringAt(body, ['channel', 'id']);
      const threadTs =
        readStringAt(body, ['message', 'thread_ts']) || readStringAt(body, ['message', 'ts']);
      if (!channel || !threadTs)
        throw new Error('Slack approval reason action is missing channel/thread');
      const resolved = resolveSurfaceApprovalAskWhy({
        surface: 'slack',
        requestId: payload.requestId,
        category: payload.category,
        annotatedBy: actorId,
        channel,
        threadTs,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: resolved.reply,
      });
    } catch (err: unknown) {
      logger.error(`❌ [SlackBridge] Ask-why handling failed: ${errorDetail(err)}`);
    }
  });

  app.action('slack_onboarding_pick', async ({ ack, body, client, action }) => {
    await ack();

    try {
      const payload = parseSlackOnboardingAction(readStringAt(action, ['value']));
      const onboarding = handleSlackOnboardingTurn({
        channel: payload.channel,
        threadTs: payload.threadTs,
        text: payload.answer || '',
      });

      await postOnboardingReply(
        client,
        payload.channel,
        payload.threadTs,
        onboarding.replyText,
        onboarding.completed
      );
    } catch (err: unknown) {
      logger.error(`❌ [SlackBridge] Onboarding button handling failed: ${errorDetail(err)}`);
    }
  });

  app.action('slack_onboarding_open_modal', async ({ ack, body, client, action }) => {
    await ack();

    try {
      const payload = parseSlackOnboardingAction(readStringAt(action, ['value']));
      await client.views.open({
        trigger_id: readStringAt(body, ['trigger_id']),
        view: buildSlackOnboardingModal(payload),
      });
    } catch (err: unknown) {
      logger.error(`❌ [SlackBridge] Opening onboarding modal failed: ${errorDetail(err)}`);
    }
  });

  app.view('slack_onboarding_submit', async ({ ack, body, view, client }) => {
    await ack();

    try {
      const payload = parseSlackOnboardingAction(view.private_metadata);
      const input = view.state.values?.slack_onboarding_input?.value?.value || '';
      const onboarding = handleSlackOnboardingTurn({
        channel: payload.channel,
        threadTs: payload.threadTs,
        text: input,
      });

      await postOnboardingReply(
        client,
        payload.channel,
        payload.threadTs,
        onboarding.replyText,
        onboarding.completed
      );
    } catch (err: unknown) {
      logger.error(`❌ [SlackBridge] Onboarding modal submission failed: ${errorDetail(err)}`);
    }
  });

  // 2. Start the app
  await app.start();
  logger.info('🛡️ Slack Sensory Satellite is online (Socket Mode). Listening for stimuli...');
}

// Same guard as the Telegram bridge: only a direct `node index.js` invocation
// starts the bridge, so importing this module in a test cannot open a Socket
// Mode connection — and a leaked VITEST env cannot silently no-op a real start.
const directEntry = isDirectEntry(import.meta.url, 'satellites/slack-bridge/src/index.ts');
if (directEntry && !getRegisteredEnvText('VITEST')) {
  start().catch((err) => {
    logger.error(`SlackBridge crashed: ${err.message}`);
    process.exitCode = 1;
  });
} else if (directEntry) {
  logger.warn('[SlackBridge] VITEST is set — suppressing the direct-entry start.');
}
