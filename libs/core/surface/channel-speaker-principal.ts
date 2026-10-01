import { frontDeskRoleAuthority } from '../front-desk-roles.js';
import {
  externalIdentityBindingDenied,
  findMemberByExternalIdentity,
  type MemberRegistryPathOptions,
  type MemberRole,
} from '../organization/member-registry.js';
import type { TierLevel } from '../types.js';
import type { ChannelModePolicy } from './channel-mode-policy.js';

/**
 * Team Channel P1: who is speaking in a channel.
 *
 * A chat actor id (e.g. Slack `U0123`) resolves to an organization member
 * through the member's `external_identities` — the same issuer + subject
 * binding the OIDC provider uses, so "Sign in with Slack" and the Slack bridge
 * name the same person. The member's role on the channel's tenant then decides
 * what the speaker may do, through the one role → permission table
 * (`frontDeskRoleAuthority`):
 *   - `surface.decision.write` → may decide approvals / mission proposals
 *   - `surface.headless.write` → may request work (missions, task sessions)
 *   - anything else (viewer, unregistered) → may only ask questions.
 *
 * A suspended member's identity (or an unreadable registry) is `denied`: the
 * speaker is refused outright and never degrades to unregistered.
 */

/** OIDC issuer each chat surface's user ids live under. */
export const CHANNEL_IDENTITY_ISSUERS: Readonly<Record<string, string>> = Object.freeze({
  slack: 'https://slack.com',
});

export type ChannelSpeakerCapability = 'ask' | 'request_work' | 'decide';

export interface ChannelSpeakerPrincipal {
  surface: string;
  actorId: string;
  /** `user:<member_id>` when the actor resolved to an active member of the channel tenant. */
  principalId?: string;
  memberId?: string;
  /** The member's role on the channel tenant. */
  role?: MemberRole;
  /** Bound to a suspended member or the registry could not prove otherwise. */
  denied: boolean;
  tenantSlug?: string;
  /** Tiers this speaker may be shown: the channel cap, never wider. */
  tierAccess: TierLevel[];
  capabilities: ChannelSpeakerCapability[];
}

const TIERS_UP_TO: Record<TierLevel, TierLevel[]> = {
  public: ['public'],
  confidential: ['public', 'confidential'],
  personal: ['public', 'confidential', 'personal'],
};

function capabilitiesForRole(role: MemberRole | undefined): ChannelSpeakerCapability[] {
  if (!role) return ['ask'];
  const permissions = frontDeskRoleAuthority(role).permissions;
  return [
    'ask',
    ...(permissions.includes('surface.headless.write') ? (['request_work'] as const) : []),
    ...(permissions.includes('surface.decision.write') ? (['decide'] as const) : []),
  ];
}

/**
 * Resolve the speaker of a team channel. Owner-direct channels are not
 * resolved here — the bridge keeps their existing single-operator semantics.
 */
export function resolveChannelSpeaker(
  policy: ChannelModePolicy,
  actorId: string,
  options: MemberRegistryPathOptions = {}
): ChannelSpeakerPrincipal {
  const actor = String(actorId || '').trim();
  const base: ChannelSpeakerPrincipal = {
    surface: policy.surface,
    actorId: actor,
    denied: false,
    ...(policy.tenantSlug ? { tenantSlug: policy.tenantSlug } : {}),
    tierAccess: TIERS_UP_TO[policy.maxTier],
    capabilities: ['ask'],
  };
  const issuer = CHANNEL_IDENTITY_ISSUERS[policy.surface];
  if (!issuer || !actor || policy.mode !== 'team' || !policy.tenantSlug) return base;

  if (externalIdentityBindingDenied(issuer, actor, options)) {
    return { ...base, denied: true, capabilities: [] };
  }
  let member;
  try {
    member = findMemberByExternalIdentity(issuer, actor, options);
  } catch {
    return { ...base, denied: true, capabilities: [] };
  }
  if (!member) return base;
  const role = member.memberships.find(
    (membership) => membership.tenant_slug === policy.tenantSlug
  )?.role;
  // A member of another tenant is an outsider here: ask-only, no principal.
  if (!role) return base;
  return {
    ...base,
    principalId: `user:${member.member_id}`,
    memberId: member.member_id,
    role,
    capabilities: capabilitiesForRole(role),
  };
}

export function speakerCan(
  speaker: ChannelSpeakerPrincipal,
  capability: ChannelSpeakerCapability
): boolean {
  return !speaker.denied && speaker.capabilities.includes(capability);
}

/** The id an approval record carries for this speaker: the member principal when known. */
export function speakerDecisionId(speaker: ChannelSpeakerPrincipal): string {
  return speaker.principalId ?? speaker.actorId;
}
