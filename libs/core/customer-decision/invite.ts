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
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, storagePartitionSegments } from '../storage-layout.js';
import { CASE_ID_PATTERN, CUSTOMER_ACTOR_ID_PATTERN } from '../decision-ledger/model.js';

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

export type InviteVerifyFailure = 'malformed' | 'unknown' | 'mismatch' | 'expired' | 'revoked';

export const DEFAULT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_INVITE_USES = 50;

const INVITE_ID_PATTERN = /^inv-[a-f0-9]{16}$/u;
const AGENDA_ID_PATTERN = /^agd-[a-z0-9]{8,40}$/u;
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

function inviteCatalog(tenantSlug: string, inviteId: string) {
  if (!isValidTenantSlug(tenantSlug)) throw new Error('[CD_INVITE_MALFORMED] tenant');
  if (!INVITE_ID_PATTERN.test(inviteId)) throw new Error('[CD_INVITE_MALFORMED] invite id');
  const filePath = assertSafeRepositoryPath(path.join(inviteDir(tenantSlug), `${inviteId}.json`), {
    allowMissingLeaf: true,
  });
  return defineCatalog<CustomerDecisionInvite>({
    id: 'customer-decision-invite',
    path: filePath,
    schema: INVITE_SCHEMA_PATH,
  });
}

/** Null when missing, unreadable, schema-invalid or stored under another tenant/id. */
function readInvite(tenantSlug: string, inviteId: string): CustomerDecisionInvite | null {
  try {
    const catalog = inviteCatalog(tenantSlug, inviteId);
    if (catalog.generation() === null) return null;
    const invite = catalog.load();
    if (invite.invite_id !== inviteId || invite.tenant_slug !== tenantSlug) return null;
    return invite;
  } catch {
    return null;
  }
}

function writeInvite(invite: CustomerDecisionInvite, expectedGeneration: string | null): void {
  const catalog = inviteCatalog(invite.tenant_slug, invite.invite_id);
  safeMkdir(path.dirname(catalog.path()), { recursive: true });
  catalog.publish(invite, expectedGeneration);
}

/** Optimistic read-modify-write; retried because use logging races with revoke. */
function updateInvite(
  tenantSlug: string,
  inviteId: string,
  mutate: (invite: CustomerDecisionInvite) => CustomerDecisionInvite
): CustomerDecisionInvite {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const generation = inviteCatalog(tenantSlug, inviteId).generation();
    const current = readInvite(tenantSlug, inviteId);
    if (!current) throw new Error('[CD_INVITE_UNKNOWN] invite not found');
    const next = mutate(structuredClone(current));
    try {
      writeInvite(next, generation);
      return next;
    } catch (error) {
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
  const [, inviteId, secret] = match;
  const invite = readInvite(tenantSlug, inviteId);
  if (!invite) return { ok: false, reason: 'unknown' };

  const expected = Buffer.from(invite.secret_sha256, 'hex');
  const actual = Buffer.from(sha256Hex(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'mismatch' };
  }
  if (invite.revoked_at) return { ok: false, reason: 'revoked' };
  if (nowMs >= Date.parse(invite.expires_at)) return { ok: false, reason: 'expired' };

  if (opts.record === false) return { ok: true, invite };
  const updated = updateInvite(tenantSlug, inviteId, (current) => {
    current.uses = [
      ...current.uses,
      { at: new Date(nowMs).toISOString(), action: opts.action },
    ].slice(-MAX_INVITE_USES);
    return current;
  });
  return { ok: true, invite: updated };
}

export function revokeInvite(
  tenantSlug: string,
  inviteId: string,
  opts: { now: string; reason: string }
): CustomerDecisionInvite {
  if (!opts.reason?.trim()) throw new Error('[CD_INVITE_INVALID] revoke reason is required');
  const nowIso = new Date(assertIso(opts.now, 'now')).toISOString();
  return updateInvite(tenantSlug, inviteId, (current) => {
    if (!current.revoked_at) {
      current.revoked_at = nowIso;
      current.revoked_reason = opts.reason.trim();
    }
    return current;
  });
}

export function listInvites(
  tenantSlug: string,
  filter: { agendaId?: string; caseId?: string } = {}
): CustomerDecisionInvite[] {
  if (!isValidTenantSlug(tenantSlug)) throw new Error('[CD_INVITE_MALFORMED] tenant');
  const dir = inviteDir(tenantSlug);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => INVITE_ID_PATTERN.test(id))
    .sort()
    .map((id) => readInvite(tenantSlug, id))
    .filter((invite): invite is CustomerDecisionInvite => invite !== null)
    .filter(
      (invite) =>
        (!filter.agendaId || invite.agenda_id === filter.agendaId) &&
        (!filter.caseId || invite.case_id === filter.caseId)
    );
}
