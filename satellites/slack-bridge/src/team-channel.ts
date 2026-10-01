import { logger } from '@agent/core/core';
import { resolveOperatorLocale } from '@agent/core/surface/operator-identity';
import { t } from '@agent/core/t';
import {
  buildChannelDisclosureDirective,
  evaluateChannelActorAccess,
  evaluateChannelApprovalAuthority,
  resolveChannelModePolicy,
  type ChannelModePolicy,
} from '@agent/core/surface/channel-mode-policy';
import type { ChannelSpeakerPrincipal } from '@agent/core/surface/channel-speaker-principal';

/**
 * Team Channel helpers for the Slack bridge: engagement (bot participation,
 * bot user id), channel-aware speaker access, approval authority and the
 * disclosure directive. Policy itself lives in core channel-mode-policy.
 */

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SlackThreadRepliesClient {
  conversations?: {
    replies?: (input: {
      channel: string;
      ts: string;
      limit: number;
    }) => Promise<{ messages?: Array<{ user?: unknown }> }>;
  };
}

/**
 * Team Channel: whether the bot already posted in this thread, so follow-up
 * replies there count as addressed to it without a fresh @mention.
 */
export async function slackBotParticipatesInThread(
  client: SlackThreadRepliesClient,
  channel: string,
  threadTs: string,
  botUserId: string | undefined
): Promise<boolean> {
  if (!botUserId || !client.conversations?.replies) return false;
  try {
    const response = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    return (response.messages || []).some((message) => message.user === botUserId);
  } catch (error: unknown) {
    logger.warn(`[SlackBridge] Thread participation lookup failed: ${errorDetail(error)}`);
    return false;
  }
}

interface SlackAuthTestClient {
  auth: { test(): Promise<{ user_id?: string }> };
}

/** Resolve (once) the bot's own user id; undefined keeps team channels silent. */
export function createSlackBotUserIdResolver(
  client: SlackAuthTestClient
): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;
  return () => {
    pending ??= client.auth
      .test()
      .then((result) => result.user_id || undefined)
      .catch((error: unknown) => {
        pending = undefined;
        logger.warn(
          `[SlackBridge] auth.test failed — team channels stay silent until it succeeds | retry on next message | ${errorDetail(error)}`
        );
        return undefined;
      });
    return pending;
  };
}

/** Speaker access in a specific channel (team channels are deny-by-default). */
export function evaluateSlackChannelActorAccess(channel: string, actorId: string) {
  const policy = resolveChannelModePolicy('slack', channel);
  return { policy, access: evaluateChannelActorAccess(policy, actorId) };
}

interface SlackEphemeralClient {
  chat: {
    postEphemeral(input: {
      channel: string;
      user: string;
      thread_ts?: string;
      text: string;
    }): Promise<unknown>;
  };
}

/**
 * Team Channel: approval-class actions (approve, reject, request changes,
 * confirm a mission proposal) need the channel's approval authority. A
 * refused actor is told privately and the refusal is logged with its reason.
 */
export async function ensureSlackApprovalAuthority(
  client: SlackEphemeralClient,
  channel: string,
  threadTs: string,
  actorId: string
): Promise<string | null> {
  const policy = resolveChannelModePolicy('slack', channel);
  const authority = evaluateChannelApprovalAuthority(policy, actorId);
  if (authority.allowed) return authority.decidedBy || actorId;
  logger.warn(
    `[SlackBridge] Approval action refused — ${actorId} lacks approval authority in ${channel} (mode=${policy.mode}, ${authority.reason}) | ask a channel approver | channel=${channel} thread=${threadTs}`
  );
  try {
    await client.chat.postEphemeral({
      channel,
      user: actorId,
      thread_ts: threadTs,
      text: t('bridge:approval_action_not_authorized', undefined, resolveOperatorLocale()),
    });
  } catch (error: unknown) {
    logger.warn(`[SlackBridge] Refusal notice failed: ${errorDetail(error)}`);
  }
  return null;
}

/** Onboarding actions are accepted only from allowed speakers in owner_direct channels. */
export function isSlackOwnerOnboardingActor(channel: string, actorId: string): boolean {
  const { policy, access } = evaluateSlackChannelActorAccess(channel, actorId);
  if (policy.mode === 'owner_direct' && access.allowed) return true;
  logger.warn(
    `[SlackBridge] Onboarding action refused — ${actorId || 'unknown'} in ${channel} (mode=${policy.mode}, ${access.reason}) | onboard from the owner channel`
  );
  return false;
}

/** Prefix the team disclosure directive to the thread context, if any. */
export function withSlackChannelDirective(
  policy: ChannelModePolicy | undefined,
  threadContext: string | undefined,
  speaker?: ChannelSpeakerPrincipal
): string | undefined {
  const directive = policy ? buildChannelDisclosureDirective(policy, speaker) : undefined;
  if (!directive) return threadContext;
  return threadContext ? `${directive}\n\n${threadContext}` : directive;
}
