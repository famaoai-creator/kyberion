/**
 * FD-07: the minimal member registry (plan §2.3 / §2.5 principle 1 — humans
 * are members, identified as `user:<member_id>`). One file per member under
 * `knowledge/personal/members/{member_id}.json`, following the same
 * path-resolution / schema-validation / secure-io pattern as
 * `tenant-registry.ts`.
 *
 * Human roles (`owner` / `approver` / `viewer`) live ONLY in a member's
 * per-tenant `memberships` — never on a tenant profile's `assigned_role`,
 * and never as an authority role on an agent.
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

export type MemberRole = 'owner' | 'approver' | 'viewer';
export type MemberStatus = 'active' | 'suspended';

export interface MemberMembership {
  tenant_slug: string;
  role: MemberRole;
}

export interface MemberAccessRegistration {
  label: string;
}

export interface MemberProfile {
  member_id: string;
  display_name: string;
  status: MemberStatus;
  memberships: MemberMembership[];
  access_registrations: MemberAccessRegistration[];
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
  if (!isValidMemberId(id)) {
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
    .filter(isValidMemberId)
    .sort();
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

export function resolveMemberByPrincipal(
  input: ResolveMemberByPrincipalInput,
  options: MemberRegistryPathOptions = {}
): MemberProfile | null {
  if (input.source === 'loopback') {
    const owner = readMemberProfile(OWNER_MEMBER_ID, options);
    return owner && owner.status === 'active' ? owner : null;
  }
  if (input.source === 'token') {
    const label = input.registrationLabel?.trim();
    if (!label) return null;
    for (const memberId of listMemberIds(options)) {
      const profile = readMemberProfile(memberId, options);
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
