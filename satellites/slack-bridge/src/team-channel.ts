import { withExecutionContextAsync } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import type { SurfaceTenantIsolation } from '@agent/core/surface/channel-surface-types';
import { issueSlackMissionFromProposal } from '@agent/core/surface/surface-mission-proposals';
import type { TierLevel } from '@agent/core/types';
import { auditChain } from '@agent/core/governance/audit-chain';
import { resolveOperatorLocale } from '@agent/core/surface/operator-identity';
import { t } from '@agent/core/t';
import {
  buildChannelDisclosureDirective,
  channelTurnScope,
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

/** Neutralize Slack mrkdwn control sequences (`<!channel>`, links, mentions) in member text. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function auditChannelMemory(
  action: 'remember' | 'forget',
  actor: string,
  policy: ChannelModePolicy,
  entryId: string
): void {
  try {
    auditChain.record({
      agentId: actor,
      action: `channel_memory.${action}`,
      operation: `slack:${policy.channelId}`,
      result: 'completed',
      metadata: { tenant_slug: policy.tenantSlug, entry_id: entryId, tier: policy.maxTier },
    });
  } catch (error: unknown) {
    logger.warn(
      `[SlackBridge] Channel memory audit record failed — ${action} ${entryId} still applied | check audit chain | ${errorDetail(error)}`
    );
  }
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
    // A channel re-bound to another tenant must not list the old tenant's work.
    const sameTenant = index && (!index.tenant_slug || index.tenant_slug === policy.tenantSlug);
    return escapeSlackText(
      formatThreadWorkStatus(resolveThreadWorkStatus(sameTenant ? index : null), locale)
    );
  }
  const command = parseChannelMemoryCommand(text);
  const ref = slackMemoryRef(policy);
  if (!command || !ref) return undefined;
  if (command.kind === 'list') {
    const entries = listChannelMemory(ref, policy.maxTier);
    if (entries.length === 0) return t('bridge:channel_memory_empty', undefined, locale);
    return [
      t('bridge:channel_memory_list_header', { count: entries.length }, locale),
      ...entries.map((entry) => `- ${entry.id}: ${escapeSlackText(entry.text)}`),
    ].join('\n');
  }
  // Saving is work (request_work); forgetting is a decision, judged exactly
  // like approvals (member role, then the channel's approvers fallback).
  const allowed =
    command.kind === 'remember'
      ? Boolean(speaker && speakerCan(speaker, 'request_work'))
      : Boolean(
          speaker &&
          !speaker.denied &&
          evaluateChannelApprovalAuthority(policy, speaker.actorId, { speaker }).allowed
        );
  if (!speaker || !allowed) return t('bridge:channel_memory_not_authorized', undefined, locale);
  const actor = speaker.principalId ?? speaker.actorId;
  if (command.kind === 'forget') {
    // Only facts visible at the channel's current tier can be removed from it.
    const visible = listChannelMemory(ref, policy.maxTier).some((entry) => entry.id === command.id);
    const removed = visible && removeChannelMemory(ref, command.id);
    if (removed) auditChannelMemory('forget', actor, policy, command.id);
    return removed
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
      auditChannelMemory('remember', actor, policy, result.entry.id);
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

/**
 * The team-channel part of one Slack turn: the tenant scope, whether the
 * speaker may only ask (P1), and the tenant isolation of the turn (E: never
 * above confidential). All empty for owner turns.
 */
export function resolveSlackTeamTurn(
  policy: ChannelModePolicy | undefined,
  speaker: ChannelSpeakerPrincipal | undefined
): {
  scope?: { tier: TierLevel; tenant_slug: string };
  askOnly: boolean;
  isolation?: SurfaceTenantIsolation;
} {
  const scope = policy ? channelTurnScope(policy) : undefined;
  const askOnly = Boolean(speaker && !speakerCan(speaker, 'request_work'));
  if (!scope) return { askOnly };
  const maxTier = scope.tier === 'public' ? 'public' : 'confidential';
  return { scope, askOnly, isolation: { tenantSlug: scope.tenant_slug, maxTier } };
}

/** Runs an isolated turn with the channel's tenant bound, so reads stay in it. */
export function runInTeamTurnContext<T>(
  isolation: SurfaceTenantIsolation | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!isolation) return fn();
  return withExecutionContextAsync('slack_bridge', fn, undefined, isolation.tenantSlug);
}

/**
 * Team Channel P2: answers a deterministic thread command (status, channel
 * memory) through `post`. True when the turn is handled — also when the
 * command failed, so a broken command never falls through to the model.
 */
export async function answerSlackTeamChannelCommand(
  params: Parameters<typeof handleSlackTeamChannelCommand>[0],
  post: (text: string) => Promise<unknown>
): Promise<boolean> {
  try {
    const reply = handleSlackTeamChannelCommand(params);
    if (reply === undefined) return false;
    await post(reply);
  } catch (err) {
    logger.error(
      `❌ [SlackBridge] Team channel command failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return true;
}

/** Principal recorded as the confirmer of a mission confirmed by text. */
export function slackTextConfirmer(
  policy: ChannelModePolicy,
  actorId: string,
  speaker?: ChannelSpeakerPrincipal
): ReturnType<typeof evaluateChannelApprovalAuthority>['decidedBy'] {
  return evaluateChannelApprovalAuthority(policy, actorId, speaker ? { speaker } : {}).decidedBy;
}

/** Team Channel P2: issues a confirmed mission and links it to its thread. */
export async function issueSlackThreadMission(
  channel: string,
  threadTs: string,
  pending: Pick<
    Parameters<typeof issueSlackMissionFromProposal>[0],
    'proposal' | 'sourceText' | 'routingDecision'
  >,
  confirmedBy: string
): ReturnType<typeof issueSlackMissionFromProposal> {
  const issued = await issueSlackMissionFromProposal({
    channel,
    threadTs,
    proposal: pending.proposal,
    sourceText: pending.sourceText,
    routingDecision: pending.routingDecision,
    ...slackMissionIssueContext(channel, confirmedBy),
  });
  linkSlackMissionToThread(channel, threadTs, issued.missionId, confirmedBy);
  return issued;
}
