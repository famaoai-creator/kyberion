import { getRegisteredEnvText } from '../foundation/env.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import type { TierLevel } from '../types.js';
import type { MemberRegistryPathOptions } from '../organization/member-registry.js';
import { evaluateSurfaceActorAccess, type SurfaceAccessDecision } from './surface-access-policy.js';
import {
  resolveChannelSpeaker,
  speakerCan,
  type ChannelSpeakerPrincipal,
} from './channel-speaker-principal.js';

/**
 * Team Channel P0: per-channel conversation mode.
 *
 * A chat channel is one of three conversation modes:
 *   - `owner_direct` — the operator's own channel (default; current behaviour).
 *   - `team`         — a shared channel of same-tenant team members. Kyberion
 *                      answers only when @mentioned or inside a thread it
 *                      already participates in, caps disclosure at the
 *                      channel's tier, denies unlisted speakers, and accepts
 *                      approvals only from the channel's approvers.
 *   - `customer`     — reserved for the customer path. Customer channels are
 *                      declared by customer-channel-binding, never here; an
 *                      entry naming it fails closed.
 *
 * Every mode-dependent rule lives in {@link CHANNEL_MODE_RULES} so later
 * modes (customer) plug in by adding a row, not by branching in each bridge.
 *
 * Configuration is `KYBERION_SURFACE_CHANNEL_MODES`, keyed by surface then
 * channel id, e.g.
 *   {"slack":{"C0TEAM":{"mode":"team","tenant_slug":"acme",
 *     "max_tier":"confidential","approvers":["U0LEAD"]}}}
 * An unparsable value fails closed: every channel of every surface is treated
 * as a misconfigured team channel that nobody may use.
 */

export type ChannelConversationMode = 'owner_direct' | 'team' | 'customer';

export interface ChannelModeRules {
  /** Respond only when mentioned or in a thread the agent participates in. */
  requireMention: boolean;
  /** Deny speakers when no allowlist is configured. */
  denyUnconfiguredAllowlist: boolean;
  /** Highest tier this mode may ever disclose. */
  tierCeiling: TierLevel;
  /** Who may decide approvals posted in the channel. */
  approvalAuthority: 'allowlisted_actor' | 'channel_approvers' | 'none';
}

export const CHANNEL_MODE_RULES: Readonly<Record<ChannelConversationMode, ChannelModeRules>> =
  Object.freeze({
    owner_direct: {
      requireMention: false,
      denyUnconfiguredAllowlist: false,
      tierCeiling: 'personal',
      approvalAuthority: 'allowlisted_actor',
    },
    team: {
      requireMention: true,
      denyUnconfiguredAllowlist: true,
      tierCeiling: 'confidential',
      approvalAuthority: 'channel_approvers',
    },
    customer: {
      requireMention: false,
      denyUnconfiguredAllowlist: true,
      tierCeiling: 'public',
      approvalAuthority: 'none',
    },
  });

export interface ChannelModePolicy {
  surface: string;
  channelId: string;
  mode: ChannelConversationMode;
  rules: ChannelModeRules;
  /** Tenant the channel belongs to (team mode). */
  tenantSlug?: string;
  /** Effective disclosure tier: the configured tier clamped to the mode ceiling. */
  maxTier: TierLevel;
  approvers: string[];
  source: 'default' | 'configured' | 'invalid';
  /** Why a configured entry was rejected (source === 'invalid'). */
  invalidReason?: string;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TIER_RANK: Record<TierLevel, number> = { public: 1, confidential: 2, personal: 3 };

function isSafeRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => !DANGEROUS_KEYS.has(key))
  );
}

function ownEntry(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isTierLevel(value: unknown): value is TierLevel {
  return value === 'public' || value === 'confidential' || value === 'personal';
}

function clampTier(tier: TierLevel, ceiling: TierLevel): TierLevel {
  return TIER_RANK[tier] <= TIER_RANK[ceiling] ? tier : ceiling;
}

function invalidPolicy(surface: string, channelId: string, reason: string): ChannelModePolicy {
  return {
    surface,
    channelId,
    mode: 'team',
    rules: CHANNEL_MODE_RULES.team,
    maxTier: 'public',
    approvers: [],
    source: 'invalid',
    invalidReason: reason,
  };
}

function defaultPolicy(surface: string, channelId: string): ChannelModePolicy {
  return {
    surface,
    channelId,
    mode: 'owner_direct',
    rules: CHANNEL_MODE_RULES.owner_direct,
    maxTier: CHANNEL_MODE_RULES.owner_direct.tierCeiling,
    approvers: [],
    source: 'default',
  };
}

function parseEntry(surface: string, channelId: string, entry: unknown): ChannelModePolicy {
  if (!isSafeRecord(entry)) return invalidPolicy(surface, channelId, 'entry is not an object');
  const mode = entry.mode;
  if (mode === 'customer') {
    return invalidPolicy(
      surface,
      channelId,
      'customer mode is declared by customer-channel-binding, not channel modes'
    );
  }
  if (mode === 'owner_direct') {
    return { ...defaultPolicy(surface, channelId), source: 'configured' };
  }
  if (mode !== 'team') return invalidPolicy(surface, channelId, `unknown mode '${String(mode)}'`);

  const tenantSlug = typeof entry.tenant_slug === 'string' ? entry.tenant_slug.trim() : '';
  if (!isValidTenantSlug(tenantSlug)) {
    return invalidPolicy(surface, channelId, 'team mode requires a valid tenant_slug');
  }
  const rules = CHANNEL_MODE_RULES.team;
  const configuredTier = entry.max_tier === undefined ? rules.tierCeiling : entry.max_tier;
  if (!isTierLevel(configuredTier)) {
    return invalidPolicy(surface, channelId, `invalid max_tier '${String(entry.max_tier)}'`);
  }
  const approversRaw = entry.approvers === undefined ? [] : entry.approvers;
  if (!Array.isArray(approversRaw) || approversRaw.some((id) => typeof id !== 'string')) {
    return invalidPolicy(surface, channelId, 'approvers must be an array of actor ids');
  }
  const approvers = Array.from(
    new Set((approversRaw as string[]).map((id) => id.trim()).filter((id) => id && id !== '*'))
  );
  return {
    surface,
    channelId,
    mode: 'team',
    rules,
    tenantSlug,
    maxTier: clampTier(configuredTier, rules.tierCeiling),
    approvers,
    source: 'configured',
  };
}

/** Resolve the conversation mode of one channel. Unlisted channels stay owner_direct. */
export function resolveChannelModePolicy(surface: string, channelId: string): ChannelModePolicy {
  const normalizedSurface = String(surface || '')
    .trim()
    .toLowerCase();
  const normalizedChannel = String(channelId || '').trim();
  const raw = getRegisteredEnvText('KYBERION_SURFACE_CHANNEL_MODES')?.trim();
  if (!raw) return defaultPolicy(normalizedSurface, normalizedChannel);

  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw, 'surface channel modes');
  } catch {
    return invalidPolicy(normalizedSurface, normalizedChannel, 'channel modes are not valid JSON');
  }
  if (!isSafeRecord(parsed)) {
    return invalidPolicy(normalizedSurface, normalizedChannel, 'channel modes must be an object');
  }
  const surfaceEntry = ownEntry(parsed, normalizedSurface);
  if (surfaceEntry === undefined) return defaultPolicy(normalizedSurface, normalizedChannel);
  if (!isSafeRecord(surfaceEntry)) {
    return invalidPolicy(normalizedSurface, normalizedChannel, 'surface entry must be an object');
  }
  const entry = normalizedChannel ? ownEntry(surfaceEntry, normalizedChannel) : undefined;
  if (entry === undefined) return defaultPolicy(normalizedSurface, normalizedChannel);
  return parseEntry(normalizedSurface, normalizedChannel, entry);
}

/** Speaker access for a channel: team mode is deny-by-default when no allowlist exists. */
export interface ChannelActorAccessDecision extends Omit<SurfaceAccessDecision, 'reason'> {
  reason: SurfaceAccessDecision['reason'] | 'tenant_member' | 'member_binding_denied';
  /** Team channels: the resolved speaker (member, role, capabilities). */
  speaker?: ChannelSpeakerPrincipal;
}

export interface ChannelAuthorityOptions {
  /** Member registry root seam for hermetic callers. */
  memberRegistry?: MemberRegistryPathOptions;
}

/**
 * Speaker access for a channel. Team channels admit active members of the
 * channel tenant (Team Channel P1) and, as ask-only guests, allowlisted
 * actors; anyone else is denied, as is an identity bound to a suspended
 * member. Owner-direct channels keep the surface allowlist semantics.
 */
export function evaluateChannelActorAccess(
  policy: ChannelModePolicy,
  actorId: string,
  options: ChannelAuthorityOptions = {}
): ChannelActorAccessDecision {
  const decision = evaluateSurfaceActorAccess(policy.surface, actorId, {
    ...(policy.rules.denyUnconfiguredAllowlist ? { defaultAllow: false } : {}),
  });
  if (policy.source === 'invalid') {
    return { ...decision, allowed: false, source: 'invalid', reason: 'invalid_allowlist' };
  }
  if (policy.mode !== 'team') return decision;
  const speaker = resolveChannelSpeaker(policy, actorId, options.memberRegistry);
  if (speaker.denied) {
    return { ...decision, allowed: false, reason: 'member_binding_denied', speaker };
  }
  if (speaker.role) return { ...decision, allowed: true, reason: 'tenant_member', speaker };
  return { ...decision, speaker };
}

export interface ChannelEngagementInput {
  text: string;
  /** The agent's own user id on the surface (e.g. Slack bot user id). */
  agentUserId?: string;
  /** True when the message is a reply inside an existing thread. */
  isThreadReply: boolean;
  /** Lazily checks whether the agent already posted in this thread. */
  agentParticipatesInThread?: () => boolean | Promise<boolean>;
}

export interface ChannelEngagementDecision {
  respond: boolean;
  reason: 'mode_does_not_require_mention' | 'mentioned' | 'participating_thread' | 'not_addressed';
  /** Message text with the agent's own mention removed. */
  text: string;
}

function mentionToken(agentUserId: string): RegExp {
  const escaped = agentUserId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`<@${escaped}(?:\\|[^>]*)?>`, 'gu');
}

/** Decide whether the agent should answer a message, and strip its own mention. */
export async function decideChannelEngagement(
  policy: ChannelModePolicy,
  input: ChannelEngagementInput
): Promise<ChannelEngagementDecision> {
  const agentUserId = input.agentUserId?.trim();
  const mentioned = agentUserId ? mentionToken(agentUserId).test(input.text) : false;
  // Remove only the mention token and the spacing right after it, so
  // multi-line messages (code blocks, lists) keep their layout.
  const text = agentUserId
    ? input.text.replace(new RegExp(`${mentionToken(agentUserId).source}[ \\t]?`, 'gu'), '').trim()
    : input.text;
  if (!policy.rules.requireMention) {
    return { respond: true, reason: 'mode_does_not_require_mention', text };
  }
  if (mentioned) return { respond: true, reason: 'mentioned', text };
  if (input.isThreadReply && input.agentParticipatesInThread) {
    if (await input.agentParticipatesInThread()) {
      return { respond: true, reason: 'participating_thread', text };
    }
  }
  return { respond: false, reason: 'not_addressed', text };
}

export interface ChannelApprovalAuthorityDecision {
  allowed: boolean;
  reason:
    | 'allowlisted_actor'
    | 'member_approver'
    | 'channel_approver'
    | 'not_channel_approver'
    | 'member_binding_denied'
    | 'mode_forbids';
  /** Id to record as the decider: `user:<member_id>` for a member, else the actor id. */
  decidedBy: string;
}

/**
 * Whether `actorId` may decide an approval posted in this channel. Team
 * channels accept members whose tenant role carries `surface.decision.write`
 * (owner / approver); the channel `approvers` list remains a transitional
 * fallback for actors not yet linked to a member.
 */
export function evaluateChannelApprovalAuthority(
  policy: ChannelModePolicy,
  actorId: string,
  options: ChannelAuthorityOptions = {}
): ChannelApprovalAuthorityDecision {
  const actor = String(actorId || '').trim();
  switch (policy.rules.approvalAuthority) {
    case 'allowlisted_actor':
      return { allowed: true, reason: 'allowlisted_actor', decidedBy: actor };
    case 'channel_approvers': {
      if (!actor || policy.source === 'invalid') {
        return { allowed: false, reason: 'not_channel_approver', decidedBy: actor };
      }
      const speaker = resolveChannelSpeaker(policy, actor, options.memberRegistry);
      const decidedBy = speaker.principalId ?? actor;
      if (speaker.denied) return { allowed: false, reason: 'member_binding_denied', decidedBy };
      if (speakerCan(speaker, 'decide')) {
        return { allowed: true, reason: 'member_approver', decidedBy };
      }
      // A linked member's role is authoritative: the fallback list only
      // covers actors that are not members of the channel tenant yet.
      if (!speaker.role && policy.approvers.includes(actor)) {
        return { allowed: true, reason: 'channel_approver', decidedBy };
      }
      return { allowed: false, reason: 'not_channel_approver', decidedBy };
    }
    default:
      return { allowed: false, reason: 'mode_forbids', decidedBy: actor };
  }
}

/**
 * Turn scope for a channel: team channels run as their tenant at the capped
 * tier; owner_direct leaves scope to the process (undefined).
 */
export function channelTurnScope(
  policy: ChannelModePolicy
): { tier: TierLevel; tenant_slug: string } | undefined {
  if (policy.mode !== 'team' || !policy.tenantSlug) return undefined;
  return { tier: policy.maxTier, tenant_slug: policy.tenantSlug };
}

/**
 * Disclosure directive prepended to a team turn's context so the reasoning
 * layer knows it is speaking to several people, not to its owner.
 */
export function buildChannelDisclosureDirective(
  policy: ChannelModePolicy,
  speaker?: ChannelSpeakerPrincipal
): string | undefined {
  if (policy.mode !== 'team') return undefined;
  const allowed =
    policy.maxTier === 'public'
      ? 'public knowledge only'
      : `public knowledge and confidential knowledge of tenant '${policy.tenantSlug}' only`;
  const speakerLine = speaker
    ? speaker.role
      ? `Current speaker: ${speaker.principalId} (role '${speaker.role}' on tenant '${policy.tenantSlug}').`
      : 'Current speaker is not a registered member of this tenant: answer questions only; do not start missions, task sessions or approval requests for them.'
    : undefined;
  return [
    '[channel-policy] This is a shared team channel: several team members read every reply.',
    `Disclose ${allowed}. Never reveal personal-tier material (the owner's private identity, vision, connections, credentials) or another tenant's data.`,
    'If a request needs such material, say it must be handled in the owner channel instead.',
    ...(speakerLine ? [speakerLine] : []),
  ].join('\n');
}
