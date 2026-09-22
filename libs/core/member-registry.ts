/**
 * FD-07: the minimal member registry (plan §2.3 / §2.5 principle 1 — humans
 * are members, identified as `user:<member_id>`). One file per member under
 * `knowledge/personal/members/{member_id}.json`, following the same
 * path-resolution / schema-validation / secure-io pattern as
 * `tenant-registry.ts`.
 *
 * Human roles (`owner` / `approver` / `operator` / `viewer`) live ONLY in a
 * member's per-tenant `memberships` — never on a tenant profile's
 * `assigned_role`, and never as an authority role on an agent.
 *
 * `external_identities` binds external IdP identities (OIDC `iss` + `sub`,
 * e.g. a Google account) to the member — the authn `oidc-jwt` provider uses
 * `findMemberByExternalIdentity` to resolve a verified external subject to
 * the member it names, so the member's own memberships become the scope.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord, readTextFile } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import { resolveOperatorDisplayName } from './operator-identity.js';
import { listTenantProfileSlugs, type TenantRegistryPathOptions } from './tenant-registry.js';
import {
  safeExistsSync,
  safeMkdir,
  safeLstat,
  safeReaddir,
  safeWriteFile,
  assertSafeRepositoryPath,
} from './secure-io.js';
import { isValidMemberId } from './member-id-grammar.js';

export { isValidMemberId };

const OWNER_MEMBER_ID = 'owner';
// Resolved at module load against the real repo root on purpose (same
// rationale as tenant-registry.ts): the schema is tracked source, not
// fixture data — hermetic tests that pass a fixture rootDir still validate
// against the canonical schema.
const MEMBER_PROFILE_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/member-profile.schema.json'
);

export type MemberRole = 'owner' | 'approver' | 'operator' | 'viewer';
export type MemberStatus = 'active' | 'suspended';

export interface MemberMembership {
  tenant_slug: string;
  role: MemberRole;
}

export interface MemberAccessRegistration {
  label: string;
}

/** A verified external IdP identity bound to the member (OIDC iss+sub). */
export interface MemberExternalIdentity {
  issuer: string;
  subject: string;
  email?: string;
}

export interface MemberProfile {
  member_id: string;
  display_name: string;
  status: MemberStatus;
  memberships: MemberMembership[];
  access_registrations: MemberAccessRegistration[];
  external_identities?: MemberExternalIdentity[];
  created_at: string;
  updated_at: string;
}

/**
 * Path-resolution seam (mirrors TenantRegistryPathOptions): defaults preserve
 * real repo root; hermetic tests pass a fixture rootDir.
 */
export interface MemberRegistryPathOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

function validateMemberProfile(
  profile: unknown,
  sourcePath = MEMBER_PROFILE_SCHEMA_PATH
): MemberProfile {
  return defineCatalog<MemberProfile>({
    id: 'member-profile',
    path: sourcePath,
    schema: MEMBER_PROFILE_SCHEMA_PATH,
  }).validate(profile, sourcePath);
}

function assertMemberId(id: string): void {
  if (!isValidMemberId(id) || id.startsWith('ext-')) {
    // 'ext-' is reserved for unregistered external subjects (authn-providers
    // oidc path): a member profile with that id would silently grant
    // memberships to an unverified external identity via actor-id matching.
    throw new Error(`[member-registry] invalid member id '${id}'`);
  }
}

export function memberProfileDir(options: MemberRegistryPathOptions = {}): string {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  return path.join(rootDir, 'knowledge', 'personal', 'members');
}

export function memberProfilePath(
  memberId: string,
  options: MemberRegistryPathOptions = {}
): string {
  assertMemberId(memberId);
  return path.join(memberProfileDir(options), `${memberId}.json`);
}

/** Codepoint-sorted member ids of every member profile file in the directory. */
export function listMemberIds(options: MemberRegistryPathOptions = {}): string[] {
  const dir = memberProfileDir(options);
  let safeDir: string;
  try {
    safeDir = assertSafeRepositoryPath(dir, {
      allowMissingLeaf: true,
      rootDir: options.rootDir,
    });
  } catch {
    return [];
  }
  if (!safeExistsSync(safeDir)) return [];
  return safeReaddir(safeDir)
    .filter((entry) => entry.endsWith('.json'))
    .filter((entry) => {
      try {
        return safeLstat(path.join(safeDir, entry)).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.slice(0, -'.json'.length))
    .filter((id) => isValidMemberId(id) && !id.startsWith('ext-'))
    .sort();
}

/**
 * Strict variant for fail-closed security scans (`memberBindingDenied`,
 * `externalIdentityBindingDenied`, `findMemberByExternalIdentity`,
 * `resolveMemberByPrincipal`'s label scan). `listMemberIds` deliberately
 * collapses "cannot verify" into "empty registry" — fine for listing UIs,
 * but a tampered or unreadable members directory must NOT look identical to
 * a genuinely empty one for binding checks: a suspended member's binding
 * would silently degrade to unregistered. So this variant propagates
 * `assertSafeRepositoryPath` failures and keeps entries whose `lstat`
 * failed (the follow-up `readMemberProfile` then reports them as errors,
 * which the deny scans translate into "cannot disprove → deny"). A truly
 * missing/empty directory still returns `[]`.
 */
function listMemberIdsStrict(options: MemberRegistryPathOptions = {}): string[] {
  const dir = memberProfileDir(options);
  const safeDir = assertSafeRepositoryPath(dir, {
    allowMissingLeaf: true,
    rootDir: options.rootDir,
  });
  if (!safeExistsSync(safeDir)) return [];
  return (
    safeReaddir(safeDir)
      // Keep every `.json` entry — including non-regular ones (directory /
      // symlink replacing a profile). `readMemberProfile` adjudicates them
      // ('member profile must be a regular file' / symlink rejection), which
      // the deny scans translate into "cannot disprove → deny".
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((id) => isValidMemberId(id) && !id.startsWith('ext-'))
      .sort()
  );
}

function assertMemberProfileShape(profile: unknown): asserts profile is MemberProfile {
  const id =
    isRecord(profile) && typeof profile.member_id === 'string' ? profile.member_id : 'unknown';
  try {
    validateMemberProfile(profile, `member profile '${id}'`);
  } catch (error) {
    throw new Error(`[member-registry] invalid member profile '${id}': ${error}`);
  }
}

/**
 * Reads and schema-validates a member profile. Returns null when the profile
 * file does not exist; throws when it exists but cannot be read, is corrupt,
 * or is schema-invalid.
 */
export function readMemberProfile(
  memberId: string,
  options: MemberRegistryPathOptions = {}
): MemberProfile | null {
  const file = memberProfilePath(memberId, options);
  let safeFile: string;
  try {
    safeFile = assertSafeRepositoryPath(file, {
      allowMissingLeaf: true,
      rootDir: options.rootDir,
    });
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    if (reason.includes('[RESOURCE_PATH_SYMLINK]')) {
      throw new Error(`[member-registry] member profile '${memberId}' traverses a symbolic link`);
    }
    throw new Error(`[member-registry] member profile '${memberId}' could not be inspected safely`);
  }
  if (!safeExistsSync(safeFile)) return null;
  let source: string;
  try {
    if (!safeLstat(safeFile).isFile()) {
      throw new Error('member profile must be a regular file');
    }
    source = readTextFile(safeFile);
  } catch (error) {
    throw new Error(
      `[member-registry] member profile '${memberId}' could not be read (${file}): ${String(
        (error as Error)?.message ?? error
      )}`
    );
  }
  let profile: unknown;
  try {
    profile = parseSafeJsonInput(source, `member profile '${memberId}'`);
  } catch (error) {
    throw new Error(
      `[member-registry] member profile '${memberId}' is not valid JSON (${file}): ${(error as Error).message}`
    );
  }
  assertMemberProfileShape(profile);
  if (profile.member_id !== memberId) {
    throw new Error(
      `[member-registry] member profile file '${file}' declares member_id '${profile.member_id}' (expected '${memberId}')`
    );
  }
  return profile;
}

/**
 * Create or update a member profile through the same schema and path
 * boundary used by the registry reader. Callers must already be running
 * inside an authorized (personal-tier) execution context.
 */
export function writeMemberProfile(
  profile: MemberProfile,
  options: MemberRegistryPathOptions = {}
): MemberProfile {
  assertMemberId(profile.member_id);
  assertMemberProfileShape(profile);
  // External identities must be unique across members: the first match wins
  // at lookup time, so a duplicated iss+sub would silently bind the wrong
  // member.
  for (const identity of profile.external_identities ?? []) {
    for (const otherId of listMemberIds(options)) {
      if (otherId === profile.member_id) continue;
      const other = readMemberProfile(otherId, options);
      if (
        other?.external_identities?.some(
          (entry) => entry.issuer === identity.issuer && entry.subject === identity.subject
        )
      ) {
        throw new Error(
          `[member-registry] external identity '${identity.issuer}#${identity.subject}' is already bound to member '${otherId}'`
        );
      }
    }
  }
  const file = memberProfilePath(profile.member_id, options);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(profile, null, 2) + '\n', { encoding: 'utf8' });
  return profile;
}

/**
 * Bootstrap the owner member from `my-identity.json` (via
 * `resolveOperatorDisplayName`), with an `owner` membership for every tenant
 * currently in the tenant registry. Idempotent and additive: an existing
 * owner record is never downgraded — this only ever adds a membership for a
 * tenant the owner record does not yet know about.
 */
export function ensureOwnerMember(
  options: MemberRegistryPathOptions & TenantRegistryPathOptions = {}
): MemberProfile {
  const tenantSlugs = listTenantProfileSlugs(options);
  const now = nowIso();
  const existing = readMemberProfile(OWNER_MEMBER_ID, options);
  if (existing) {
    const missing = tenantSlugs.filter(
      (slug) => !existing.memberships.some((membership) => membership.tenant_slug === slug)
    );
    if (missing.length === 0) return existing;
    const merged: MemberProfile = {
      ...existing,
      memberships: [
        ...existing.memberships,
        ...missing.map((tenant_slug) => ({ tenant_slug, role: 'owner' as const })),
      ],
      updated_at: now,
    };
    return writeMemberProfile(merged, options);
  }

  const profile: MemberProfile = {
    member_id: OWNER_MEMBER_ID,
    display_name: resolveOperatorDisplayName(OWNER_MEMBER_ID),
    status: 'active',
    memberships: tenantSlugs.map((tenant_slug) => ({ tenant_slug, role: 'owner' as const })),
    access_registrations: [],
    created_at: now,
    updated_at: now,
  };
  return writeMemberProfile(profile, options);
}

export interface ResolveMemberByPrincipalInput {
  principalId?: string | null;
  source: 'token' | 'loopback' | 'anonymous';
  registrationLabel?: string | null;
  /**
   * The authn-verified member binding (e.g. an OIDC principal whose
   * external identity mapped to a member). When present it is authoritative:
   * resolution succeeds only if the named member exists and is active —
   * it never falls back to label/loopback resolution that could bind a
   * different member.
   */
  memberId?: string | null;
}

/**
 * Reverse-resolve a server-trusted viewer principal to its member record
 * (plan §2.3 "viewer 解決"). Loopback always resolves to the owner member (if
 * one has been provisioned); a token resolves via the label its
 * chronos-access.json registration carries, matched against the member's
 * `access_registrations`. Unregistered / suspended principals resolve to
 * null so callers fall back to their pre-FD-07 behavior (backward
 * compatible, additive).
 */
/** Canonical actor id (`actor.ts` `humanActor`) of the owner member. */
export function ownerAccountableHumanId(): string {
  return `user:${OWNER_MEMBER_ID}`;
}

/**
 * FD-10 item 4 / FD-07 item 7 (§2.5 principle 3): resolve an
 * `accountable_human_id` to the member it names. Accepts either the actor id
 * (`user:<member_id>`) or a bare member id; anything else (legacy synthetic
 * labels like `human:operator`, or a member id that does not exist) resolves
 * to `null` rather than throwing — orphan/legacy detection reads this as "did
 * not resolve", not as an error.
 */
export function resolveAccountableHuman(
  id: string,
  options: MemberRegistryPathOptions = {}
): MemberProfile | null {
  const trimmed = String(id || '').trim();
  if (!trimmed) return null;
  const memberId = trimmed.startsWith('user:') ? trimmed.slice('user:'.length) : trimmed;
  if (!isValidMemberId(memberId)) return null;
  try {
    return readMemberProfile(memberId, options);
  } catch {
    return null;
  }
}

/**
 * Resolve an active member by a verified external IdP identity (OIDC
 * `iss` + `sub`). Returns null when no active member binds that identity —
 * callers fall back to their unregistered-principal path (fail closed).
 * Suspended members never match: they resolve exactly like unregistered
 * identities.
 */
export function findMemberByExternalIdentity(
  issuer: string,
  subject: string,
  options: MemberRegistryPathOptions = {}
): MemberProfile | null {
  const iss = issuer.trim();
  const sub = subject.trim();
  if (!iss || !sub) return null;
  // Strict enumeration: a tampered members directory must not collapse into
  // "no members" — callers pair this with `externalIdentityBindingDenied`
  // (or fail closed themselves) so an unverifiable registry never degrades
  // a bound identity to unregistered.
  for (const memberId of listMemberIdsStrict(options)) {
    // An unreadable/corrupt profile cannot prove a binding — skip it rather
    // than aborting the scan for every other external login.
    let profile: MemberProfile | null = null;
    try {
      profile = readMemberProfile(memberId, options);
    } catch {
      continue;
    }
    if (
      profile &&
      profile.status === 'active' &&
      (profile.external_identities ?? []).some(
        (identity) => identity.issuer === iss && identity.subject === sub
      )
    ) {
      return profile;
    }
  }
  return null;
}

/**
 * Companion to `resolveMemberByPrincipal` for fail-closed callers: returns
 * true when the principal carries a member BINDING that did not resolve to
 * an active member — an asserted `memberId` that is missing/inactive, or a
 * token `registrationLabel` matching a member's `access_registrations` whose
 * profile is suspended (or unreadable). Callers use this to distinguish a
 * bound-but-denied principal (hard deny) from a genuinely unregistered one
 * (legacy fallback). A suspended member's label binding must never degrade
 * into "unregistered" — for a localadmin-class credential that is a
 * privilege upgrade to owner.
 */
export function memberBindingDenied(
  input: ResolveMemberByPrincipalInput,
  options: MemberRegistryPathOptions = {}
): boolean {
  const memberId = input.memberId?.trim();
  if (memberId) return true;
  if (input.source !== 'token') return false;
  const label = input.registrationLabel?.trim();
  if (!label) return false;
  let ids: string[];
  try {
    ids = listMemberIdsStrict(options);
  } catch {
    // The registry cannot be enumerated — the binding can neither be
    // proven nor disproven. Fail closed.
    return true;
  }
  for (const id of ids) {
    try {
      const profile = readMemberProfile(id, options);
      if (profile === null) {
        // The file vanished mid-scan — the binding cannot be disproven.
        return true;
      }
      if (profile?.access_registrations.some((registration) => registration.label === label)) {
        return true;
      }
    } catch {
      // An unreadable profile cannot disprove the binding either — a
      // suspended member's label must never degrade to "unregistered".
      return true;
    }
  }
  return false;
}

/**
 * Companion to `findMemberByExternalIdentity` for fail-closed callers:
 * returns true when ANY member profile binds this `iss`+`sub` — including a
 * suspended one `findMemberByExternalIdentity` correctly skips. A suspended
 * member's external identity must fail closed, not degrade into the
 * unregistered `ext-` path where a `kyberion_role` claim could grant
 * localadmin.
 */
export function externalIdentityBindingDenied(
  issuer: string,
  subject: string,
  options: MemberRegistryPathOptions = {}
): boolean {
  const iss = issuer.trim();
  const sub = subject.trim();
  if (!iss || !sub) return false;
  let memberIds: string[];
  try {
    memberIds = listMemberIdsStrict(options);
  } catch {
    // The registry cannot be enumerated — the binding can neither be
    // proven nor disproven. Fail closed.
    return true;
  }
  for (const memberId of memberIds) {
    try {
      const profile = readMemberProfile(memberId, options);
      if (profile === null) {
        // The file vanished mid-scan — the binding cannot be disproven.
        return true;
      }
      if (
        profile.status !== 'active' &&
        (profile.external_identities ?? []).some(
          (identity) => identity.issuer === iss && identity.subject === sub
        )
      ) {
        return true;
      }
    } catch {
      // An unreadable profile cannot disprove the binding either — deny.
      return true;
    }
  }
  return false;
}

export function resolveMemberByPrincipal(
  input: ResolveMemberByPrincipalInput,
  options: MemberRegistryPathOptions = {}
): MemberProfile | null {
  const memberId = input.memberId?.trim();
  if (memberId) {
    // Authenticated member binding wins outright — an inactive or missing
    // member resolves to null (unregistered), never to another member.
    const profile = isValidMemberId(memberId) ? readMemberProfile(memberId, options) : null;
    return profile?.status === 'active' ? profile : null;
  }
  if (input.source === 'loopback') {
    const owner = readMemberProfile(OWNER_MEMBER_ID, options);
    return owner && owner.status === 'active' ? owner : null;
  }
  if (input.source === 'token') {
    const label = input.registrationLabel?.trim();
    if (!label) return null;
    // Strict enumeration — same fail-closed rationale as the external
    // identity scan: "cannot enumerate" must not look like "no binding".
    for (const memberId of listMemberIdsStrict(options)) {
      let profile: MemberProfile | null = null;
      try {
        profile = readMemberProfile(memberId, options);
      } catch {
        // A corrupt profile aborts nothing — it is handled by the caller's
        // `memberBindingDenied` fail-closed check, which denies when the
        // binding cannot be disproven.
        continue;
      }
      if (
        profile &&
        profile.status === 'active' &&
        profile.access_registrations.some((registration) => registration.label === label)
      ) {
        return profile;
      }
    }
    return null;
  }
  return null;
}
