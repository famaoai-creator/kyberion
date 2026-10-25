/**
 * CD-06: invite links for one customer decision agenda
 * (docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md).
 *
 * A token is `<invite_id>.<secret>`. Only the SHA-256 of the secret is stored;
 * the token is returned once by `issueInvite` and is never persisted or logged.
 * The token encodes no tenant: the caller (a one-tenant customer-room process)
 * passes the tenant it is bound to, and an invite stored under another tenant
 * is simply unknown.
 *
 * Storage: `active/shared/runtime/customer-decision-invites/confidential/<tenant>/<invite_id>.json`
 * — a registered tier/tenant-partitioned runtime state root
 * (`PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites`). Every read
 * and write is schema-validated; an invalid stored file is treated as unknown.
 *
 * All invite I/O runs as the narrow `customer_decision_invite_store` role bound
 * to the tenant, inside an exact resource capability for one invite record (or
 * a read-only listing of the tenant directory), so it needs no confidential
 * persona and never touches another tenant or any knowledge path. A store
 * that cannot be read (permission or I/O failure) is reported as
 * `unavailable`, never as an unknown invite.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { isActiveCustomerTenant } from '../customer-channel-binding.js';
import {
  CUSTOMER_DECISION_INVITE_STORE_ROLE,
  customerDecisionInviteCapability,
} from '../foundation/customer-decision-invite-capability.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
} from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, storagePartitionSegments } from '../storage-layout.js';
import { CASE_ID_PATTERN, CUSTOMER_ACTOR_ID_PATTERN } from '../decision-ledger/model.js';
import { AGENDA_ID_PATTERN } from './model.js';

const logger = createLogger('customer-decision-invite');

export interface CustomerDecisionInviteParticipant {
  name: string;
  role: 'decider' | 'contributor';
  actor_id: string;
}

export interface CustomerDecisionInvite {
  version: '1.0.0';
  invite_id: string;
  tenant_slug: string;
  case_id: string;
  agenda_id: string;
  participant: CustomerDecisionInviteParticipant;
  /** Hex SHA-256 of the secret half of the token. */
  secret_sha256: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  revoked_at?: string;
  revoked_reason?: string;
  /** Only the last {@link MAX_INVITE_USES} entries are kept. */
  uses: Array<{ at: string; action: 'view' | 'respond' }>;
}

/** `unavailable`: the invite store could not be read (permission or I/O failure). */
export type InviteVerifyFailure =
  'malformed' | 'unknown' | 'mismatch' | 'expired' | 'revoked' | 'unavailable';

export const DEFAULT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_INVITE_USES = 50;

const INVITE_ID_PATTERN = /^inv-[a-f0-9]{16}$/u;
const TOKEN_PATTERN = /^(inv-[a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/u;
const INVITE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/customer-decision-invite.schema.json'
);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inviteDir(tenantSlug: string): string {
  return pathResolver.rootResolve(
    path.posix.join(
      PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites,
      ...storagePartitionSegments({ kind: 'tier', tier: 'confidential', tenant: tenantSlug })
    )
  );
}

function inviteFilePath(tenantSlug: string, inviteId: string): string {
  if (!isValidTenantSlug(tenantSlug)) throw new Error('[CD_INVITE_MALFORMED] tenant');
  if (!INVITE_ID_PATTERN.test(inviteId)) throw new Error('[CD_INVITE_MALFORMED] invite id');
  return assertSafeRepositoryPath(path.join(inviteDir(tenantSlug), `${inviteId}.json`), {
    allowMissingLeaf: true,
  });
}

/**
 * Run `fn` as the invite store role bound to `tenantSlug`, inside the exact
 * capability for `target` (one invite file, or the tenant directory for a listing).
 */
function asInviteStore<T>(tenantSlug: string, target: string, write: boolean, fn: () => T): T {
  const capability = customerDecisionInviteCapability(
    tenantSlug,
    pathResolver.toRepoRelative(target),
    write
  );
  return runInResourceAccessScope(capability, () =>
    withExecutionContext(CUSTOMER_DECISION_INVITE_STORE_ROLE, fn, undefined, tenantSlug)
  );
}

function inviteCatalog(filePath: string) {
  return defineCatalog<CustomerDecisionInvite>({
    id: 'customer-decision-invite',
    path: filePath,
    schema: INVITE_SCHEMA_PATH,
  });
}

type InviteRead =
  | { kind: 'found'; invite: CustomerDecisionInvite; generation: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `missing` when no record exists, `invalid` when the stored file is not a
 * schema-valid invite of this tenant/id, `unavailable` when the store cannot
 * be read (permission or I/O failure; logged).
 */
function readInvite(tenantSlug: string, inviteId: string): InviteRead {
  const filePath = inviteFilePath(tenantSlug, inviteId);
  let generation: string | null;
  let raw: string;
  try {
    ({ generation, raw } = asInviteStore(tenantSlug, filePath, false, () => {
      const current = inviteCatalog(filePath).generation();
      return {
        generation: current,
        raw: current === null ? '' : (safeReadFile(filePath, { encoding: 'utf8' }) as string),
      };
    }));
  } catch (error) {
    logger.warn(
      `customer decision invite store unreadable — ${errorText(error)} | ` +
        `check the customer_decision_invite_store grant and the store directory permissions | ` +
        `tenant=${tenantSlug} invite=${inviteId}`
    );
    return { kind: 'unavailable' };
  }
  if (generation === null) return { kind: 'missing' };
  try {
    const invite = inviteCatalog(filePath).validate(JSON.parse(raw), filePath);
    if (invite.invite_id !== inviteId || invite.tenant_slug !== tenantSlug) {
      return { kind: 'invalid' };
    }
    return { kind: 'found', invite, generation };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Optimistic publication: the write only lands when the record still has the
 * generation the caller read. The inter-process lock is taken under the
 * caller's own identity (lock files are not invite records); only the
 * generation check and the record write run inside the invite capability.
 * Not `openJsonState`: it takes its lock inside the same scope as the write,
 * and the one-record capability denies the lock directory.
 */
function writeInvite(invite: CustomerDecisionInvite, expectedGeneration: string | null): void {
  const filePath = inviteFilePath(invite.tenant_slug, invite.invite_id);
  const catalog = inviteCatalog(filePath);
  const validated = catalog.validate(invite, filePath);
  // The store root itself is an unprotected runtime directory (the caller may
  // create it); only the tier/tenant directories below it need the capability.
  safeMkdir(path.dirname(path.dirname(path.dirname(filePath))), { recursive: true });
  withLockSync(`customer-decision-invite-${invite.tenant_slug}-${invite.invite_id}`, () =>
    asInviteStore(invite.tenant_slug, filePath, true, () => {
      const current = catalog.generation();
      if (current !== expectedGeneration) {
        throw new Error(
          `[CD_INVITE_CONFLICT] invite ${invite.invite_id} changed: expected generation ${expectedGeneration ?? 'missing'}, current ${current ?? 'missing'}`
        );
      }
      try {
        // A new record may need its partition; an update writes beside an
        // existing record (the guard refuses every mkdir of an inactive tenant).
        if (expectedGeneration === null) safeMkdir(path.dirname(filePath), { recursive: true });
        writeJson(filePath, validated);
      } catch (error) {
        throw tierPartitionError(invite.tenant_slug, error);
      }
    })
  );
}

const TENANT_NOT_REGISTERED = '[CD_INVITE_TENANT_NOT_REGISTERED]';

function isTenantNotRegistered(error: unknown): boolean {
  return errorText(error).includes(TENANT_NOT_REGISTERED);
}

/**
 * The invite store writes only for a registered active tenant: the guard
 * refuses the tier directory (`…/confidential/`, tier-guard
 * `isScopedStructuralMkdir`) and every write / mkdir of the store role for an
 * inactive tenant except a revoke (foundation/customer-decision-invite-write-content.ts).
 * Name that cause instead of the raw policy refusal; any other error passes through.
 */
function tierPartitionError(tenantSlug: string, error: unknown): unknown {
  const text = errorText(error);
  if (!text.includes('tenant.scope_invalid_prefix') && !text.includes(TENANT_NOT_REGISTERED))
    return error;
  return new Error(
    `${TENANT_NOT_REGISTERED} tenant '${tenantSlug}' is not a registered active tenant, so its customer decision invites cannot be issued or used (only revoked) | ` +
      `register the tenant (knowledge/personal/tenants/${tenantSlug}.json, status active — pnpm onboarding) and send again | tenant=${tenantSlug}`
  );
}

/**
 * Optimistic read-modify-write; retried because use logging races with revoke.
 * `mutate` returns null when the record needs no change (nothing is written).
 * A refusal for an inactive tenant is final, never retried.
 */
function updateInvite(
  tenantSlug: string,
  inviteId: string,
  mutate: (invite: CustomerDecisionInvite) => CustomerDecisionInvite | null
): CustomerDecisionInvite {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = readInvite(tenantSlug, inviteId);
    if (current.kind === 'unavailable')
      throw new Error('[CD_INVITE_UNAVAILABLE] invite store unavailable');
    if (current.kind !== 'found') throw new Error('[CD_INVITE_UNKNOWN] invite not found');
    const next = mutate(structuredClone(current.invite));
    if (next === null) return current.invite;
    try {
      writeInvite(next, current.generation);
      return next;
    } catch (error) {
      if (isTenantNotRegistered(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('[CD_INVITE_WRITE_FAILED]');
}

function assertIso(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`[CD_INVITE_INVALID] ${label} is not a timestamp`);
  return ms;
}

export function issueInvite(input: {
  tenantSlug: string;
  caseId: string;
  agendaId: string;
  participant: CustomerDecisionInviteParticipant;
  createdBy: string;
  now: string;
  ttlMs?: number;
}): { invite: CustomerDecisionInvite; token: string } {
  if (!isValidTenantSlug(input.tenantSlug)) throw new Error('[CD_INVITE_INVALID] tenant slug');
  if (!CASE_ID_PATTERN.test(input.caseId)) throw new Error('[CD_INVITE_INVALID] case id');
  if (!AGENDA_ID_PATTERN.test(input.agendaId)) throw new Error('[CD_INVITE_INVALID] agenda id');
  const participant = input.participant;
  if (
    !participant ||
    typeof participant.name !== 'string' ||
    !participant.name.trim() ||
    (participant.role !== 'decider' && participant.role !== 'contributor') ||
    !CUSTOMER_ACTOR_ID_PATTERN.test(participant.actor_id)
  ) {
    throw new Error('[CD_INVITE_INVALID] participant');
  }
  if (!input.createdBy?.trim()) throw new Error('[CD_INVITE_INVALID] createdBy');
  const ttl = input.ttlMs ?? DEFAULT_INVITE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new Error('[CD_INVITE_INVALID] ttl must be positive');
  const nowMs = assertIso(input.now, 'now');

  const inviteId = `inv-${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  const invite: CustomerDecisionInvite = {
    version: '1.0.0',
    invite_id: inviteId,
    tenant_slug: input.tenantSlug,
    case_id: input.caseId,
    agenda_id: input.agendaId,
    participant: {
      name: participant.name,
      role: participant.role,
      actor_id: participant.actor_id,
    },
    secret_sha256: sha256Hex(secret),
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + Math.min(ttl, MAX_INVITE_TTL_MS)).toISOString(),
    created_by: input.createdBy,
    uses: [],
  };
  writeInvite(invite, null);
  return { invite, token: `${inviteId}.${secret}` };
}

/**
 * The invite id of a well-formed token, else undefined. Format only — the
 * invite is not looked up or verified (for ids-only audit of a refusal).
 */
export function inviteIdOfToken(token: unknown): string | undefined {
  return typeof token === 'string' ? TOKEN_PATTERN.exec(token)?.[1] : undefined;
}

export function verifyInviteToken(
  tenantSlug: string,
  token: string,
  opts: { now: string; action: 'view' | 'respond'; record?: boolean }
): { ok: true; invite: CustomerDecisionInvite } | { ok: false; reason: InviteVerifyFailure } {
  const match = typeof token === 'string' ? TOKEN_PATTERN.exec(token) : null;
  const nowMs = Date.parse(opts?.now);
  if (
    !match ||
    typeof tenantSlug !== 'string' ||
    !isValidTenantSlug(tenantSlug) ||
    !Number.isFinite(nowMs) ||
    (opts.action !== 'view' && opts.action !== 'respond')
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // CD-10: the invites of a tenant that is not registered and active stop
  // working on every path (a quiet `record: false` check too) — the same
  // `unavailable` as a store failure, so the registration state is not revealed.
  if (!isActiveCustomerTenant(tenantSlug)) return { ok: false, reason: 'unavailable' };
  const [, inviteId, secret] = match;
  const read = readInvite(tenantSlug, inviteId);
  if (read.kind === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (read.kind !== 'found') return { ok: false, reason: 'unknown' };
  const invite = read.invite;

  const expected = Buffer.from(invite.secret_sha256, 'hex');
  const actual = Buffer.from(sha256Hex(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'mismatch' };
  }
  if (invite.revoked_at) return { ok: false, reason: 'revoked' };
  if (nowMs >= Date.parse(invite.expires_at)) return { ok: false, reason: 'expired' };

  if (opts.record === false) return { ok: true, invite };
  try {
    const updated = updateInvite(tenantSlug, inviteId, (current) => {
      current.uses = [
        ...current.uses,
        { at: new Date(nowMs).toISOString(), action: opts.action },
      ].slice(-MAX_INVITE_USES);
      return current;
    });
    return { ok: true, invite: updated };
  } catch (error) {
    // The guard refuses the use record of an inactive tenant: the invite stops working.
    if (!isTenantNotRegistered(error)) throw error;
    logger.warn(
      `customer decision invite use refused — the tenant is not a registered active tenant | ` +
        `register or reactivate the tenant, or revoke the invite | tenant=${tenantSlug} invite=${inviteId}`
    );
    return { ok: false, reason: 'unavailable' };
  }
}

export function revokeInvite(
  tenantSlug: string,
  inviteId: string,
  opts: { now: string; reason: string }
): CustomerDecisionInvite {
  if (!opts.reason?.trim()) throw new Error('[CD_INVITE_INVALID] revoke reason is required');
  const nowIso = new Date(assertIso(opts.now, 'now')).toISOString();
  return updateInvite(tenantSlug, inviteId, (current) => {
    // Already revoked: nothing to write (the first revoke stands).
    if (current.revoked_at) return null;
    current.revoked_at = nowIso;
    current.revoked_reason = opts.reason.trim();
    return current;
  });
}

export function listInvites(
  tenantSlug: string,
  filter: { agendaId?: string; caseId?: string } = {}
): CustomerDecisionInvite[] {
  if (!isValidTenantSlug(tenantSlug)) throw new Error('[CD_INVITE_MALFORMED] tenant');
  const dir = inviteDir(tenantSlug);
  const names = asInviteStore(tenantSlug, dir, false, () =>
    safeExistsSync(dir) ? safeReaddir(dir) : []
  );
  const invites: CustomerDecisionInvite[] = [];
  for (const id of names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => INVITE_ID_PATTERN.test(id))
    .sort()) {
    const read = readInvite(tenantSlug, id);
    if (read.kind === 'unavailable')
      throw new Error(`[CD_INVITE_UNAVAILABLE] invite store unavailable (${id})`);
    if (read.kind === 'found') invites.push(read.invite);
  }
  return invites.filter(
    (invite) =>
      (!filter.agendaId || invite.agenda_id === filter.agendaId) &&
      (!filter.caseId || invite.case_id === filter.caseId)
  );
}
