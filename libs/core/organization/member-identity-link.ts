import { nowIso } from '../foundation/time.js';
import {
  readMemberProfile,
  writeMemberProfile,
  type MemberExternalIdentity,
  type MemberProfile,
  type MemberRegistryPathOptions,
} from './member-registry.js';

/**
 * Team Channel P1: link / unlink an external identity (e.g. a Slack user id
 * under issuer `https://slack.com`) on an existing member. Mirrors the
 * concierge `PATCH /api/members/:id` identity edit so the CLI facade
 * (`pnpm organization member link-identity`) and the HTTP surface keep one
 * rule: identities are unique across members (enforced by
 * `writeMemberProfile`) and the member must already exist.
 *
 * Callers run inside an execution context allowed to write
 * `knowledge/personal/members/`.
 */

export type MemberIdentityLinkResult =
  | { status: 'linked' | 'already_linked' | 'unlinked' | 'not_linked'; member: MemberProfile }
  | { status: 'member_not_found' };

function normalizeIdentity(identity: MemberExternalIdentity): MemberExternalIdentity {
  const issuer = identity.issuer.trim();
  const subject = identity.subject.trim();
  if (!issuer || !subject) {
    throw new Error('[member-identity-link] issuer and subject are required');
  }
  const email = identity.email?.trim();
  return { issuer, subject, ...(email ? { email } : {}) };
}

function sameIdentity(a: MemberExternalIdentity, b: MemberExternalIdentity): boolean {
  return a.issuer === b.issuer && a.subject === b.subject;
}

export function linkMemberExternalIdentity(
  memberId: string,
  identity: MemberExternalIdentity,
  options: MemberRegistryPathOptions = {}
): MemberIdentityLinkResult {
  const next = normalizeIdentity(identity);
  const existing = readMemberProfile(memberId, options);
  if (!existing) return { status: 'member_not_found' };
  const identities = existing.external_identities ?? [];
  if (identities.some((entry) => sameIdentity(entry, next))) {
    return { status: 'already_linked', member: existing };
  }
  const member = writeMemberProfile(
    { ...existing, external_identities: [...identities, next], updated_at: nowIso() },
    options
  );
  return { status: 'linked', member };
}

export function unlinkMemberExternalIdentity(
  memberId: string,
  identity: MemberExternalIdentity,
  options: MemberRegistryPathOptions = {}
): MemberIdentityLinkResult {
  const target = normalizeIdentity(identity);
  const existing = readMemberProfile(memberId, options);
  if (!existing) return { status: 'member_not_found' };
  const identities = existing.external_identities ?? [];
  const remaining = identities.filter((entry) => !sameIdentity(entry, target));
  if (remaining.length === identities.length) return { status: 'not_linked', member: existing };
  const member = writeMemberProfile(
    { ...existing, external_identities: remaining, updated_at: nowIso() },
    options
  );
  return { status: 'unlinked', member };
}
