import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeExistsSync,
  safeWriteFile,
} from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '../storage-layout.js';
import {
  DEFAULT_INVITE_TTL_MS,
  MAX_INVITE_TTL_MS,
  issueInvite,
  listInvites,
  revokeInvite,
  verifyInviteToken,
} from './invite.js';

const TENANT = 'cd-invite-test';
const OTHER = 'cd-invite-other';
const NOW = '2026-10-24T00:00:00.000Z';
const participant = { name: 'Taro', role: 'decider' as const, actor_id: 'customer:taro' };
const base = {
  tenantSlug: TENANT,
  caseId: 'deal-001',
  agendaId: 'agd-abcdefgh',
  participant,
  createdBy: 'user:tester',
  now: NOW,
};

function tenantDir(tenant: string): string {
  return pathResolver.rootResolve(
    path.posix.join(
      PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites,
      'confidential',
      tenant
    )
  );
}

/**
 * The invite store writes only for a registered active tenant; the guard reads
 * the registry profile raw from the checkout (`null` removes it).
 */
function setProfile(tenant: string, status: string | null): void {
  const file = pathResolver.rootResolve(`knowledge/personal/tenants/${tenant}.json`);
  withExecutionContext(
    'ecosystem_architect',
    () =>
      status === null
        ? safeRmSync(file, { force: true })
        : safeWriteFile(file, JSON.stringify({ tenant_slug: tenant, status })),
    'ecosystem_architect'
  );
}

beforeEach(() => setProfile(TENANT, 'active'));

afterEach(() => {
  for (const tenant of [TENANT, OTHER])
    safeRmSync(tenantDir(tenant), { recursive: true, force: true });
});

afterAll(() => setProfile(TENANT, null));

describe('customer decision invites', () => {
  it('issues and verifies, recording a use', () => {
    const { invite, token } = issueInvite(base);
    expect(invite.invite_id).toMatch(/^inv-[a-f0-9]{16}$/u);
    expect(token.startsWith(`${invite.invite_id}.`)).toBe(true);
    expect(Date.parse(invite.expires_at) - Date.parse(NOW)).toBe(DEFAULT_INVITE_TTL_MS);
    const result = verifyInviteToken(TENANT, token, { now: NOW, action: 'view' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invite.uses).toEqual([{ at: NOW, action: 'view' }]);
    const quiet = verifyInviteToken(TENANT, token, { now: NOW, action: 'respond', record: false });
    expect(quiet.ok && quiet.invite.uses.length).toBe(1);
  });

  it('rejects a wrong secret, unknown id and another tenant', () => {
    const { invite, token } = issueInvite(base);
    const wrong = `${invite.invite_id}.${'A'.repeat(43)}`;
    expect(verifyInviteToken(TENANT, wrong, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    const unknown = `inv-${'0'.repeat(16)}.${'A'.repeat(43)}`;
    expect(verifyInviteToken(TENANT, unknown, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(verifyInviteToken(OTHER, token, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('expires, clamps the ttl and rejects non-positive ttl', () => {
    const { invite, token } = issueInvite({ ...base, ttlMs: 1000 });
    expect(
      verifyInviteToken(TENANT, token, { now: '2026-10-24T00:00:01.000Z', action: 'view' })
    ).toEqual({ ok: false, reason: 'expired' });
    expect(invite.uses).toEqual([]);
    const long = issueInvite({ ...base, ttlMs: MAX_INVITE_TTL_MS * 10 });
    expect(Date.parse(long.invite.expires_at) - Date.parse(NOW)).toBe(MAX_INVITE_TTL_MS);
    expect(() => issueInvite({ ...base, ttlMs: 0 })).toThrow();
    expect(() => issueInvite({ ...base, ttlMs: -5 })).toThrow();
  });

  it('revokes', () => {
    const { invite, token } = issueInvite(base);
    const revoked = revokeInvite(TENANT, invite.invite_id, {
      now: NOW,
      reason: 'sent to wrong person',
    });
    expect(revoked.revoked_reason).toBe('sent to wrong person');
    expect(verifyInviteToken(TENANT, token, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('an inactive tenant: no new invite, uses stop, revoke still works', () => {
    expect(() => issueInvite({ ...base, tenantSlug: OTHER })).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    expect(safeExistsSync(tenantDir(OTHER))).toBe(false);
    const { invite, token } = issueInvite(base);
    setProfile(TENANT, 'suspended');
    expect(() => issueInvite(base)).toThrow(/\[CD_INVITE_TENANT_NOT_REGISTERED\]/u);
    expect(verifyInviteToken(TENANT, token, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    const revoked = revokeInvite(TENANT, invite.invite_id, { now: NOW, reason: 'offboard' });
    expect(revoked.revoked_reason).toBe('offboard');
    // A repeated revoke writes nothing and keeps the first reason.
    expect(revokeInvite(TENANT, invite.invite_id, { now: NOW, reason: 'x' }).revoked_reason).toBe(
      'offboard'
    );
    expect(listInvites(TENANT).map((item) => item.uses.length)).toEqual([0]);
  });

  it('treats malformed input as malformed without file access', () => {
    const bad = [
      '',
      'nope',
      '../../etc/passwd',
      `../inv-${'a'.repeat(16)}.${'A'.repeat(43)}`,
      `inv-${'a'.repeat(16)}.${'A'.repeat(42)}`,
      `inv-${'a'.repeat(16)}.${'A'.repeat(43)}/x`,
      `inv-${'g'.repeat(16)}.${'A'.repeat(43)}`,
    ];
    for (const token of bad) {
      expect(verifyInviteToken(TENANT, token, { now: NOW, action: 'view' })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
    const good = `inv-${'a'.repeat(16)}.${'A'.repeat(43)}`;
    for (const tenant of ['../x', 'A B', '']) {
      expect(verifyInviteToken(tenant, good, { now: NOW, action: 'view' })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
    expect(() => issueInvite({ ...base, caseId: '../x' })).toThrow();
    expect(() => issueInvite({ ...base, agendaId: 'agd-../x' })).toThrow();
    expect(() => issueInvite({ ...base, tenantSlug: '../x' })).toThrow();
    expect(() =>
      issueInvite({ ...base, participant: { ...participant, actor_id: 'taro' } })
    ).toThrow();
  });

  it('never persists the plaintext secret', () => {
    const { invite, token } = issueInvite(base);
    const secret = token.split('.')[1];
    const dir = tenantDir(TENANT);
    const files = safeReaddir(dir);
    expect(files).toEqual([`${invite.invite_id}.json`]);
    const raw = safeReadFile(path.join(dir, files[0]), { encoding: 'utf8' }) as string;
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(token);
    expect(raw).toContain(invite.secret_sha256);
  });

  it('keeps only the last 50 uses', () => {
    const { token } = issueInvite(base);
    for (let i = 0; i < 53; i++) {
      const at = new Date(Date.parse(NOW) + i * 1000).toISOString();
      expect(verifyInviteToken(TENANT, token, { now: at, action: 'view' }).ok).toBe(true);
    }
    const [stored] = listInvites(TENANT);
    expect(stored.uses).toHaveLength(50);
    expect(stored.uses[0].at).toBe(new Date(Date.parse(NOW) + 3000).toISOString());
  });

  it('lists with filters and an empty tenant', () => {
    expect(safeExistsSync(tenantDir(OTHER))).toBe(false);
    expect(listInvites(OTHER)).toEqual([]);
    const a = issueInvite(base).invite;
    const b = issueInvite({ ...base, agendaId: 'agd-zzzzzzzz', caseId: 'deal-002' }).invite;
    expect(
      listInvites(TENANT)
        .map((i) => i.invite_id)
        .sort()
    ).toEqual([a.invite_id, b.invite_id].sort());
    expect(listInvites(TENANT, { agendaId: 'agd-zzzzzzzz' }).map((i) => i.invite_id)).toEqual([
      b.invite_id,
    ]);
    expect(listInvites(TENANT, { caseId: 'deal-001' }).map((i) => i.invite_id)).toEqual([
      a.invite_id,
    ]);
  });
});
