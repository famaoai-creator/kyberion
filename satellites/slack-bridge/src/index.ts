import { App, LogLevel } from '@slack/bolt';
import * as path from 'node:path';
import {
  logger,
  emitChannelSurfaceEvent,
  resolveServiceBinding,
  safeAppendFileSync,
  prepareSlackSurfaceArtifact,
  recordSlackSurfaceArtifact,
  buildSlackSurfacePrompt,
  runSurfaceConversation,
  recordSlackDelivery,
  listSlackOutboxMessages,
  clearSlackOutboxMessage,
  deriveSlackDelegationReceiver,
  isEnvironmentInitialized,
  getSlackMissionProposalState,
  saveSlackMissionProposalState,
  clearSlackMissionProposalState,
  isSlackMissionConfirmation,
  issueSlackMissionFromProposal,
  handleSlackOnboardingTurn,
  buildSlackOnboardingBlocks,
  buildSlackOnboardingModal,
  parseSlackOnboardingAction,
  createSlackApprovalRequest,
  buildSlackApprovalBlocks,
  parseSlackApprovalAction,
  applySlackApprovalDecision,
} from '@agent/core';

/**
 * Slack Sensory Satellite (Socket Mode) v1.0
 * Ingests Slack messages as GUSP v2.0 Stimuli.
 */

const STIMULI_PATH = path.join(process.cwd(), 'presence/bridge/runtime/stimuli.jsonl');
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

async function postOnboardingReply(client: any, channel: string, threadTs: string, text: string, completed: boolean) {
  const blocks = completed ? undefined : buildSlackOnboardingBlocks(channel, threadTs);
  return client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
    blocks,
  });
}

async function postApprovalRequest(client: any, params: {
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
}) {
  const record = createSlackApprovalRequest(params);
  return client.chat.postMessage({
    channel: params.channel,
    thread_ts: params.threadTs,
    text: `Approval required: ${record.title}`,
    blocks: buildSlackApprovalBlocks(record),
  });
}

async function processSlackOutbox(client: any) {
  const messages = listSlackOutboxMessages();
  for (const message of messages) {
    try {
      const response = await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.thread_ts,
        text: message.text,
      });
      recordSlackDelivery(
        message.correlation_id,
        message.channel,
        message.thread_ts,
        response.ts,
        message.source,
      );
      clearSlackOutboxMessage(message.message_id);
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Outbox delivery failed for ${message.message_id}: ${err.message}`);
    }
  }
}

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
    logLevel: LogLevel.INFO
  });

  const outboxTimer = setInterval(() => {
    processSlackOutbox(app.client).catch((err: any) => {
      logger.error(`❌ [SlackBridge] Outbox poll failed: ${err.message}`);
    });
  }, 3000);
  outboxTimer.unref?.();

  // 1. Listen for messages
  app.message(async ({ message, client }) => {
    // Only process text messages (ignore edits, deletes, etc. for now)
    if (!('text' in message) || !message.text) return;
    if (message.subtype) return; // Ignore bot messages or other subtypes
    const threadTs = 'thread_ts' in message && typeof message.thread_ts === 'string' ? message.thread_ts : message.ts;
    const team = 'team' in message && typeof message.team === 'string' ? message.team : undefined;
    const channelType = 'channel_type' in message && typeof message.channel_type === 'string' ? message.channel_type : undefined;
    const artifact = prepareSlackSurfaceArtifact({
      user: message.user,
      text: message.text,
      channel: message.channel,
      ts: message.ts,
      threadTs,
      team,
      channelType,
    });

    // 3. Physical Ingestion (Evidence-as-State)
    try {
      logger.info(`📥 [SlackBridge] Ingesting stimulus ${artifact.stimulus.id} from ${message.user}`);
      recordSlackSurfaceArtifact(artifact);
      safeAppendFileSync(STIMULI_PATH, JSON.stringify(artifact.stimulus) + '\n', 'utf8');

      const initialized = isEnvironmentInitialized();

      if (artifact.shouldAck || !initialized) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: initialized ? artifact.ackText : 'Received. This workspace is not initialized yet, so I will switch to onboarding mode.',
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
        recordSlackDelivery(artifact.correlationId, message.channel, threadTs, response.ts, 'system');
        return;
      }

      const pendingMissionProposal = getSlackMissionProposalState(message.channel, threadTs);
      if (pendingMissionProposal && isSlackMissionConfirmation(message.text)) {
        const issued = await issueSlackMissionFromProposal({
          channel: message.channel,
          threadTs,
          proposal: pendingMissionProposal.proposal,
          sourceText: pendingMissionProposal.sourceText,
        });
        clearSlackMissionProposalState(message.channel, threadTs);
        const response = await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: [
            `Mission ${issued.missionId} started.`,
            `Type: ${issued.missionType}`,
            `Tier: ${issued.tier}`,
            `Persona: ${issued.persona}`,
            issued.orchestrationStatus === 'queued'
              ? 'Background orchestration has been queued.'
              : 'Background orchestration could not be queued.',
          ].join('\n'),
        });
        recordSlackDelivery(artifact.correlationId, message.channel, threadTs, response.ts, 'system');
        return;
      }

      const forcedReceiver = deriveSlackDelegationReceiver(message.text);
      const conversation = await runSurfaceConversation({
        agentId: SLACK_SURFACE_AGENT_ID,
        query: buildSlackSurfacePrompt({
          user: message.user,
          text: message.text,
          channel: message.channel,
          ts: message.ts,
          threadTs,
          team,
          channelType,
        }),
        senderAgentId: 'kyberion:slack-bridge',
        forcedReceiver,
        delegationSummaryInstruction:
          'Below are delegated responses. Produce the final Slack reply in the user language. Keep it concise and channel-appropriate. Do not emit any A2A blocks.',
      });
      const route = forcedReceiver === 'nerve-agent' ? 'nerve' : 'surface';

      if (conversation.approvalRequests.length > 0) {
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
        });
        const response = await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: [
            conversation.text || 'I can turn this into a mission.',
            '',
            'If you want me to proceed, reply with `はい` or `お願いします` in this thread.',
          ].join('\n').trim(),
        });
        recordSlackDelivery(
          artifact.correlationId,
          message.channel,
          threadTs,
          response.ts,
          route,
        );
        return;
      }

      if (conversation.text) {
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
        const response = await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: conversation.text,
        });
        recordSlackDelivery(
          artifact.correlationId,
          message.channel,
          threadTs,
          response.ts,
          route,
        );
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Ingestion failed: ${err.message}`);
    }
  });

  app.action('slack_approval_decide', async ({ ack, action, body, client }) => {
    await ack();

    try {
      const payload = parseSlackApprovalAction((action as any).value);
      const actorId = (body as any).user?.id || 'unknown';
      const updated = applySlackApprovalDecision({
        requestId: payload.requestId,
        decision: payload.decision,
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
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Approval decision handling failed: ${err.message}`);
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

start().catch(err => {
  logger.error(`SlackBridge crashed: ${err.message}`);
  process.exit(1);
});
