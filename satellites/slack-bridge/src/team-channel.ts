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
import {
  speakerCan,
  type ChannelSpeakerPrincipal,
} from '@agent/core/surface/channel-speaker-principal';
import {
  CHANNEL_MEMORY_LIMITS,
  addChannelMemory,
  buildChannelMemoryContext,
  listChannelMemory,
  parseChannelMemoryCommand,
  removeChannelMemory,
  type ChannelMemoryRef,
} from '@agent/core/surface/channel-memory-store';
import {
  formatThreadWorkStatus,
  isThreadStatusQuery,
  readThreadWork,
  recordThreadWork,
  resolveThreadWorkStatus,
} from '@agent/core/surface/thread-work-index';

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

function slackMemoryRef(policy: ChannelModePolicy): ChannelMemoryRef | undefined {
  return policy.mode === 'team' && policy.tenantSlug
    ? { surface: 'slack', tenantSlug: policy.tenantSlug, channel: policy.channelId }
    : undefined;
}

/** Team Channel P2: the channel's memory, capped at its disclosure tier. */
export function slackChannelMemoryContext(policy: ChannelModePolicy): string | undefined {
  const ref = slackMemoryRef(policy);
  if (!ref) return undefined;
  try {
    return buildChannelMemoryContext(listChannelMemory(ref, policy.maxTier));
  } catch (error: unknown) {
    logger.warn(
      `[SlackBridge] Channel memory unavailable — turn continues without it | check ${policy.channelId} memory file | ${errorDetail(error)}`
    );
    return undefined;
  }
}

/** Prefix the team disclosure directive (and channel memory) to the thread context. */
export function withSlackChannelDirective(
  policy: ChannelModePolicy | undefined,
  threadContext: string | undefined,
  speaker?: ChannelSpeakerPrincipal
): string | undefined {
  const directive = policy ? buildChannelDisclosureDirective(policy, speaker) : undefined;
  if (!directive) return threadContext;
  const memory = policy ? slackChannelMemoryContext(policy) : undefined;
  return [directive, memory, threadContext].filter(Boolean).join('\n\n');
}

/**
 * Team Channel P2: deterministic thread commands handled without the model —
 * "status?" (work this thread started) and channel memory commands
 * (remember / forget / list). Returns the reply text, or undefined when the
 * message is a normal turn.
 */
export function handleSlackTeamChannelCommand(params: {
  policy: ChannelModePolicy;
  speaker?: ChannelSpeakerPrincipal;
  threadTs: string;
  text: string;
}): string | undefined {
  const { policy, speaker, threadTs, text } = params;
  if (policy.mode !== 'team') return undefined;
  const locale = resolveOperatorLocale();
  if (isThreadStatusQuery(text)) {
    const index = readThreadWork({ surface: 'slack', channel: policy.channelId, threadTs });
    return formatThreadWorkStatus(resolveThreadWorkStatus(index), locale);
  }
  const command = parseChannelMemoryCommand(text);
  const ref = slackMemoryRef(policy);
  if (!command || !ref) return undefined;
  if (command.kind === 'list') {
    const entries = listChannelMemory(ref, policy.maxTier);
    if (entries.length === 0) return t('bridge:channel_memory_empty', undefined, locale);
    return [
      t('bridge:channel_memory_list_header', { count: entries.length }, locale),
      ...entries.map((entry) => `- ${entry.id}: ${entry.text}`),
    ].join('\n');
  }
  const needed = command.kind === 'remember' ? 'request_work' : 'decide';
  if (!speaker || !speakerCan(speaker, needed)) {
    return t('bridge:channel_memory_not_authorized', undefined, locale);
  }
  if (command.kind === 'forget') {
    return removeChannelMemory(ref, command.id)
      ? t('bridge:channel_memory_forgotten', { id: command.id }, locale)
      : t('bridge:channel_memory_not_found', { id: command.id }, locale);
  }
  const result = addChannelMemory(ref, {
    text: command.text,
    tier: policy.maxTier,
    createdBy: speaker.principalId ?? speaker.actorId,
    sourceThread: threadTs,
  });
  switch (result.status) {
    case 'saved':
      return t('bridge:channel_memory_saved', { id: result.entry.id }, locale);
    case 'too_long':
      return t(
        'bridge:channel_memory_too_long',
        { max: CHANNEL_MEMORY_LIMITS.maxTextLength },
        locale
      );
    case 'full':
      return t('bridge:channel_memory_full', { max: CHANNEL_MEMORY_LIMITS.maxEntries }, locale);
    default:
      return t('bridge:channel_memory_nothing', undefined, locale);
  }
}

/** Team Channel P2: attribution and tenant scope carried by an issued mission. */
export function slackMissionIssueContext(
  channel: string,
  confirmedBy: string
): { confirmedBy: string; scope?: { tenant_slug: string; tier: ChannelModePolicy['maxTier'] } } {
  const policy = resolveChannelModePolicy('slack', channel);
  return {
    confirmedBy,
    ...(policy.mode === 'team' && policy.tenantSlug
      ? { scope: { tenant_slug: policy.tenantSlug, tier: policy.maxTier } }
      : {}),
  };
}

/** Team Channel P2: remember that this thread started the mission (best-effort). */
export function linkSlackMissionToThread(
  channel: string,
  threadTs: string,
  missionId: string,
  confirmedBy: string
): void {
  const policy = resolveChannelModePolicy('slack', channel);
  try {
    recordThreadWork(
      { surface: 'slack', channel, threadTs },
      { kind: 'mission', id: missionId, confirmed_by: confirmedBy },
      policy.tenantSlug ? { tenantSlug: policy.tenantSlug } : {}
    );
  } catch (error: unknown) {
    logger.warn(
      `[SlackBridge] Thread work link failed — status queries will not list ${missionId} | check thread-work store | ${errorDetail(error)}`
    );
  }
}
