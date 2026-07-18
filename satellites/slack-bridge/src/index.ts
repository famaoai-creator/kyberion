import { App, LogLevel } from '@slack/bolt';
import { installProcessGuards } from '@agent/core';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('slack-bridge');
import {
  resolveOperatorLocale,
  logger,
  pathResolver,
  emitChannelSurfaceEvent,
  resolveServiceBinding,
  safeAppendFileSync,
  prepareSlackSurfaceArtifact,
  recordSlackSurfaceArtifact,
  runSurfaceMessageConversation,
  recordSlackDelivery,
  listSlackOutboxMessages,
  clearSlackOutboxMessage,
  createSurfaceOutboxDrainGuard,
  isSurfaceOutboxDue,
  recordSurfaceDeliverySuccess,
  settleSurfaceOutboxFailure,
  deriveSlackDelegationReceiver,
  isEnvironmentInitialized,
  getSlackMissionProposalState,
  saveSlackMissionProposalState,
  clearSlackMissionProposalState,
  isSlackMissionConfirmation,
  isSlackMissionRejection,
  issueSlackMissionFromProposal,
  handleSlackOnboardingTurn,
  buildSlackOnboardingBlocks,
  buildSlackOnboardingModal,
  parseSlackOnboardingAction,
  createSlackApprovalRequest,
  buildSlackApprovalBlocks,
  parseSlackApprovalAction,
  applySurfaceApprovalDecision,
  buildSlackApprovalAskWhyBlocks,
  buildSlackMissionProposalBlocks,
  parseSlackMissionProposalAction,
  slackMissionProposalFallbackText,
  parseSlackAskWhyAction,
  resolveSurfaceApprovalAskWhy,
  dispatchPresenceFrame,
  buildBridgeEmptyReplyText,
  chunkSurfaceMessage,
  postBridgeError,
  resolveCustomerBinding,
  runCustomerConversation,
  evaluateSurfaceActorAccess,
  sendSurfaceTextWithFallback,
  buildAutomationSlackModal,
  extractAutomationSlackFormValues,
  findAutomationBlueprint,
  parseAutomationSlashRequest,
  parseAutomationSlackModalMetadata,
  registerAutomationBlueprint,
} from '@agent/core';

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

async function postOnboardingReply(
  client: any,
  channel: string,
  threadTs: string,
  text: string,
  completed: boolean
) {
  const blocks = completed ? undefined : buildSlackOnboardingBlocks(channel, threadTs);
  return postSlackTextWithBlocks(client, { channel, thread_ts: threadTs, text, blocks });
}

async function postSlackTextWithBlocks(
  client: any,
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
  client: any,
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
  client: any,
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
  }
) {
  const record = createSlackApprovalRequest(params);
  return postSlackTextWithBlocks(client, {
    channel: params.channel,
    thread_ts: params.threadTs,
    text: `Approval required: ${record.title}`,
    blocks: buildSlackApprovalBlocks(record),
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
  } catch (error: any) {
    logger.warn(`⚠️ [SlackBridge] Presence reflect failed: ${error?.message || error}`);
  }
}

function automationRegistrationReply(
  registration: ReturnType<typeof registerAutomationBlueprint>
): string {
  const delivery = registration.scheduled.deliver_to
    ? ` → ${registration.scheduled.deliver_to.surface}:${registration.scheduled.deliver_to.channel}`
    : '';
  return [
    `スケジュールを登録しました: ${registration.scheduled.name}`,
    `cron: ${registration.scheduled.trigger.cron}${registration.scheduled.trigger.timezone ? ` (${registration.scheduled.trigger.timezone})` : ''}${delivery}`,
  ].join('\n');
}

async function postAutomationReply(
  client: any,
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
  return [
    `Mission ${issued.missionId} started.`,
    `Type: ${issued.missionType}`,
    `Tier: ${issued.tier}`,
    `Persona: ${issued.persona}`,
    issued.routingDecision
      ? `Routing: ${issued.routingDecision.mode}${issued.routingDecision.owner ? ` (${issued.routingDecision.owner})` : ''}`
      : undefined,
    issued.orchestrationStatus === 'queued'
      ? 'Background orchestration has been queued.'
      : 'Background orchestration could not be queued.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function processSlackOutbox(client: any) {
  const messages = listSlackOutboxMessages();
  for (const message of messages) {
    if (!isSurfaceOutboxDue(message)) continue;
    try {
      const response = await postSlackText(client, {
        channel: message.channel,
        thread_ts: message.thread_ts || undefined,
        text: message.text,
      });
      recordSlackDelivery(
        message.correlation_id,
        message.channel,
        message.thread_ts,
        response.ts,
        message.source
      );
      recordSurfaceDeliverySuccess('slack', message.channel);
      clearSlackOutboxMessage(message.message_id);
    } catch (err: any) {
      const decision = settleSurfaceOutboxFailure('slack', message, err);
      logger.error(
        `❌ [SlackBridge] Outbox delivery failed for ${message.message_id}: ${err.message} (${decision.failure.kind}${decision.dead_letter ? ', dead-lettered' : `, retry at ${decision.next_attempt_at}`})`
      );
    }
  }
}

const runSlackOutbox = createSurfaceOutboxDrainGuard('slack');

async function start() {
  process.env.MISSION_ROLE ||= 'slack_bridge';
  const binding = resolveServiceBinding('slack', 'secret-guard');
  const appToken = binding.appToken;
  const botToken = binding.accessToken;

  if (!appToken || !botToken) {
    logger.error('❌ Missing Slack service binding (access token or app token).');
    process.exit(1);
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
    const actorId = String((command as any).user_id || '');
    const channel = String((command as any).channel_id || '');
    try {
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed)
        throw new Error(`Unauthorized Slack automation request: ${access.reason}`);
      if (!channel || !actorId)
        throw new Error('Slack automation request is missing actor or channel.');

      const request = parseAutomationSlashRequest(String((command as any).text || ''));
      const entry = findAutomationBlueprint(request.blueprint_id);
      const values: Record<string, string> = { ...request.values };
      const deliverySlot = entry.blueprint.delivery?.channel_slot;
      if (deliverySlot && !Object.hasOwn(values, deliverySlot)) values[deliverySlot] = channel;

      if (request.open_form) {
        const triggerId = String((command as any).trigger_id || '');
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
          ) as any,
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
      metadata = parseAutomationSlackModalMetadata(String((view as any).private_metadata || ''));
      actorId = String((body as any).user?.id || '');
      if (actorId !== metadata.actor_id) throw new Error('Slack automation modal actor mismatch.');
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed)
        throw new Error(`Unauthorized Slack automation request: ${access.reason}`);

      const entry = findAutomationBlueprint(metadata.blueprint_id);
      if (entry.blueprint.pipeline_ref !== metadata.pipeline_ref) {
        throw new Error('Slack automation modal pipeline reference mismatch.');
      }
      const values = extractAutomationSlackFormValues(entry.blueprint, (view as any).state?.values);
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
    runSlackOutbox(() => processSlackOutbox(app.client)).catch((err: any) => {
      logger.error(`❌ [SlackBridge] Outbox poll failed: ${err.message}`);
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
      safeAppendFileSync(STIMULI_PATH, JSON.stringify(artifact.stimulus) + '\n', 'utf8');

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

      // UX-02: Slack has no bot typing API — show 👀 on the user's message
      // while we work and swap it for ✅ when the reply lands. Reaction
      // failures are cosmetic and must never block the reply.
      const typingReaction = { added: false };
      try {
        await client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'eyes',
        });
        typingReaction.added = true;
      } catch (reactionErr: any) {
        logger.warn(`[SlackBridge] typing reaction failed: ${reactionErr?.message || reactionErr}`);
      }
      const clearTypingReaction = async () => {
        if (!typingReaction.added) return;
        typingReaction.added = false;
        try {
          await client.reactions.remove({
            channel: message.channel,
            timestamp: message.ts,
            name: 'eyes',
          });
        } catch {
          /* reaction may already be gone — cosmetic */
        }
      };

      const forcedReceiver = deriveSlackDelegationReceiver(message.text);
      await reflectSlackPresence({
        status: 'thinking',
        expression: 'thinking',
        subtitle: 'Slack Surface is preparing a reply.',
        transcript: [{ speaker: 'Slack User', text: message.text }],
      });
      const conversation = await runSurfaceMessageConversation({
        surface: 'slack',
        text: message.text,
        channel: message.channel,
        threadTs,
        correlationId: artifact.correlationId,
        receivedAt: message.ts,
        actorId: message.user,
        senderAgentId: 'kyberion:slack-bridge',
        agentId: SLACK_SURFACE_AGENT_ID,
        forcedReceiver,
        delegationSummaryInstruction:
          'Below are delegated responses. Produce the final Slack reply in the user language. Keep it concise and channel-appropriate. Do not emit any A2A blocks.',
        metadata: {
          user: message.user,
          team,
          channelType,
        },
      });
      await clearTypingReaction();
      const route = forcedReceiver === 'nerve-agent' ? 'nerve' : 'surface';

      if (conversation.approvalRequests.length > 0) {
        await reflectSlackPresence({
          status: 'thinking',
          expression: 'listening',
          subtitle: 'Slack Surface is waiting for approval.',
          transcript: [
            {
              speaker: 'Slack Surface',
              text: conversation.text || 'Approval is required before continuing.',
            },
          ],
        });
        recordSlackConversationOutcome({
          correlationId: artifact.correlationId,
          channel: message.channel,
          threadTs,
          sourceText: message.text,
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
            sourceText: message.text,
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
          sourceText: message.text,
          route,
          outcome: 'mission_proposal',
          approvalCount: conversation.approvalRequests.length,
          missionProposalCount: conversation.missionProposals.length,
        });
        saveSlackMissionProposalState({
          channel: message.channel,
          threadTs,
          proposal,
          sourceText: message.text,
          routingDecision: conversation.routingDecision,
        });
        const response = await postSlackTextWithBlocks(client, {
          channel: message.channel,
          thread_ts: threadTs,
          text: slackMissionProposalFallbackText(proposal),
          blocks: buildSlackMissionProposalBlocks(proposal),
        });
        recordSlackDelivery(artifact.correlationId, message.channel, threadTs, response.ts, route);
        return;
      }

      if (conversation.text) {
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
          sourceText: message.text,
          route,
          outcome: 'plain_reply',
          approvalCount: conversation.approvalRequests.length,
          missionProposalCount: conversation.missionProposals?.length || 0,
        });
        const response = await postSlackText(client, {
          channel: message.channel,
          thread_ts: threadTs,
          text: conversation.text,
        });
        recordSlackDelivery(artifact.correlationId, message.channel, threadTs, response.ts, route);
        return;
      }

      recordSlackConversationOutcome({
        correlationId: artifact.correlationId,
        channel: message.channel,
        threadTs,
        sourceText: message.text,
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Ingestion failed: ${err.message}`);
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

  app.action('slack_approval_decide', async ({ ack, action, body, client }) => {
    await ack();

    try {
      const payload = parseSlackApprovalAction((action as any).value);
      const actorId = (body as any).user?.id || 'unknown';
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed) {
        logger.warn(
          `⚠️ [SlackBridge] Ignoring unauthorized approval action from ${actorId}: ${access.reason}`
        );
        return;
      }
      const channel = (body as any).channel?.id;
      const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Approval decision handling failed: ${err.message}`);
    }
  });

  app.action('slack_mission_proposal_decide', async ({ ack, action, body, client }) => {
    await ack();
    try {
      const payload = parseSlackMissionProposalAction((action as any).value);
      const channel = (body as any).channel?.id;
      const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
      const actorId = (body as any).user?.id || 'unknown';
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Mission proposal decision handling failed: ${err.message}`);
    }
  });

  app.action('slack_approval_askwhy', async ({ ack, action, body, client }) => {
    await ack();
    try {
      const payload = parseSlackAskWhyAction((action as any).value);
      const actorId = (body as any).user?.id || 'unknown';
      const access = evaluateSurfaceActorAccess('slack', actorId);
      if (!access.allowed) {
        logger.warn(
          `⚠️ [SlackBridge] Ignoring unauthorized approval reason action from ${actorId}: ${access.reason}`
        );
        return;
      }
      const channel = (body as any).channel?.id;
      const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Ask-why handling failed: ${err.message}`);
    }
  });

  app.action('slack_onboarding_pick', async ({ ack, body, client, action }) => {
    await ack();

    try {
      const payload = parseSlackOnboardingAction((action as any).value);
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Onboarding button handling failed: ${err.message}`);
    }
  });

  app.action('slack_onboarding_open_modal', async ({ ack, body, client, action }) => {
    await ack();

    try {
      const payload = parseSlackOnboardingAction((action as any).value);
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildSlackOnboardingModal(payload),
      });
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Opening onboarding modal failed: ${err.message}`);
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Onboarding modal submission failed: ${err.message}`);
    }
  });

  // 2. Start the app
  await app.start();
  logger.info('🛡️ Slack Sensory Satellite is online (Socket Mode). Listening for stimuli...');
}

start().catch((err) => {
  logger.error(`SlackBridge crashed: ${err.message}`);
  process.exit(1);
});
