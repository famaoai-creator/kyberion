import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { readTextFile } from '../foundation/text.js';
import { readJson, writeJson } from '../foundation/json.js';
import { safeReaddir, safeRmSync } from '../secure-io.js';
import { writeMemberProfile, type MemberProfile } from './member-registry.js';
import { readTenantProfile, writeTenantProfile } from './tenant-registry.js';
import {
  authenticateScimToken,
  issueScimToken,
  listScimTokens,
  readScimLedger,
  resetScimRejectAuditThrottle,
  revokeScimToken,
  sameScimIssuer,
  ScimTokenError,
  type ScimAuditEvent,
} from './scim-token-registry.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const ISSUER = 'https://login.example.com/tenant-1/v2.0';
const REQUEST = { method: 'GET', path: '/scim/v2/Users' };

const member = (over: Partial<MemberProfile>): MemberProfile => ({
  member_id: 'owner',
  display_name: 'Owner',
  status: 'active',
  memberships: [
    { tenant_slug: 'acme', role: 'owner' },
    { tenant_slug: 'beta', role: 'owner' },
  ],
  access_registrations: [],
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  ...over,
});

describe('scim token registry', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let audit: ScimAuditEvent[] = [];
  const opts = () => ({ rootDir: root, audit: (event: ScimAuditEvent) => audit.push(event) });
  const issue = (over: Record<string, unknown> = {}) =>
    issueScimToken(
      {
        tenantSlug: 'acme',
        label: 'Entra ID',
        issuer: ISSUER,
        issuedByMemberId: 'owner',
        now: NOW,
        ...over,
      },
      opts()
    );
  const fail = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ScimTokenError);
      expect((error as ScimTokenError).code).toBe(code);
      return;
    }
    throw new Error(`expected ScimTokenError(${code})`);
  };

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `scim-token-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    for (const slug of ['acme', 'beta']) {
      writeTenantProfile(
        { tenant_slug: slug, display_name: slug, status: 'active', assigned_role: 'owner' },
        { rootDir: root }
      );
    }
    writeMemberProfile(member({}), { rootDir: root });
    writeMemberProfile(
      member({ member_id: 'vera', memberships: [{ tenant_slug: 'acme', role: 'approver' }] }),
      { rootDir: root }
    );
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    audit = [];
    resetScimRejectAuditThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a tenant-bound token, stores only the hash, and audits the issue', () => {
    const { token, record } = issue();
    expect(token).toMatch(/^kscim~acme~scim-[a-f0-9]{16}~[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({
      tenant_slug: 'acme',
      issuer: ISSUER,
      default_role: 'viewer',
      status: 'active',
      issued_by: 'user:owner',
    });
    expect(record).not.toHaveProperty('token_sha256');
    const dir = path.join(root, 'knowledge', 'confidential', 'acme', 'scim', 'tokens');
    const secret = token.split('~')[3];
    for (const file of safeReaddir(dir)) {
      expect(readTextFile(path.join(dir, file))).not.toContain(secret);
    }
    expect(readScimLedger('acme', opts()).at(-1)).toMatchObject({ event: 'issued' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'scim.token.issue',
        tenantSlug: 'acme',
        tokenId: record.token_id,
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('only an active owner of the tenant issues or revokes', () => {
    fail(() => issue({ issuedByMemberId: 'vera' }), 'forbidden');
    fail(() => issue({ tenantSlug: 'gamma' }), 'forbidden');
    const { record } = issue();
    fail(
      () =>
        revokeScimToken(
          { tenantSlug: 'acme', tokenId: record.token_id, revokedByMemberId: 'vera' },
          opts()
        ),
      'forbidden'
    );
  });

  it('never provisions owners and requires an https issuer', () => {
    fail(() => issue({ defaultRole: 'owner' }), 'invalid');
    fail(() => issue({ defaultRole: 'admin' }), 'invalid');
    fail(() => issue({ issuer: 'http://idp.example.com' }), 'invalid');
    fail(() => issue({ issuer: 'https://u:p@idp.example.com' }), 'invalid');
    // Kept exactly as configured: sign-in compares the id_token `iss` verbatim.
    expect(issue({ defaultRole: 'operator', issuer: ` ${ISSUER}/ ` }).record).toMatchObject({
      default_role: 'operator',
      issuer: `${ISSUER}/`,
    });
    expect(sameScimIssuer(`${ISSUER}/`, ISSUER)).toBe(true);
    expect(sameScimIssuer('https://IDP.example.com/a', 'https://idp.example.com/a/')).toBe(true);
    expect(sameScimIssuer('https://idp.example.com/a', 'https://idp.example.com/b')).toBe(false);
    expect(sameScimIssuer('not a url', 'not a url')).toBe(false);
  });

  it('refuses chat-surface identity issuers, at issue time and in a tampered record', () => {
    for (const issuer of ['https://slack.com', 'https://slack.com/', 'https://SLACK.com']) {
      fail(() => issue({ issuer }), 'invalid');
    }
    const { token, record } = issue();
    const recordFile = path.join(
      root,
      'knowledge',
      'confidential',
      'acme',
      'scim',
      'tokens',
      `${record.token_id}.json`
    );
    writeJson(recordFile, {
      ...readJson<Record<string, unknown>>(recordFile),
      issuer: 'https://slack.com',
    });
    expect(authenticateScimToken(token, REQUEST, opts())).toBeNull();
    expect(audit.at(-1)).toMatchObject({ reason: 'unusable_record' });
  });

  it('refuses tokens of a suspended or unregistered tenant (coalesced reject audit)', () => {
    const { token, record } = issue();
    expect(authenticateScimToken(token, REQUEST, opts())?.tenant_slug).toBe('acme');
    const acme = readTenantProfile('acme', { rootDir: root })!;
    writeTenantProfile({ ...acme, status: 'suspended' }, { rootDir: root });
    try {
      audit = [];
      expect(authenticateScimToken(token, REQUEST, opts())).toBeNull();
      expect(authenticateScimToken(token, REQUEST, opts())).toBeNull();
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'scim.token.reject',
          tenantSlug: 'acme',
          tokenId: record.token_id,
          reason: 'tenant_inactive',
        }),
      ]);
    } finally {
      writeTenantProfile(acme, { rootDir: root });
    }
    expect(authenticateScimToken(token, REQUEST, opts())?.tenant_slug).toBe('acme');

    // A tenant that has SCIM records but no registry profile provisions nobody.
    writeMemberProfile(
      member({ member_id: 'gus', memberships: [{ tenant_slug: 'gone', role: 'owner' }] }),
      { rootDir: root }
    );
    const orphan = issue({ tenantSlug: 'gone', issuedByMemberId: 'gus' });
    expect(authenticateScimToken(orphan.token, REQUEST, opts())).toBeNull();
    expect(audit.at(-1)).toMatchObject({ reason: 'tenant_inactive' });
  });

  it('authenticates its own tenant only, and audits every use', () => {
    const { token, record } = issue();
    expect(authenticateScimToken(token, REQUEST, opts())).toEqual({
      token_id: record.token_id,
      tenant_slug: 'acme',
      issuer: ISSUER,
      default_role: 'viewer',
    });
    expect(audit.at(-1)).toMatchObject({ action: 'scim.token.use', result: 'completed' });

    // The same id+secret presented under another tenant finds nothing there.
    const [, , id, secret] = token.split('~');
    expect(authenticateScimToken(`kscim~beta~${id}~${secret}`, REQUEST, opts())).toBeNull();
    // A tenant-B token never authenticates as tenant A.
    const other = issue({ tenantSlug: 'beta' });
    const asA = other.token.replace('kscim~beta~', 'kscim~acme~');
    expect(authenticateScimToken(asA, REQUEST, opts())).toBeNull();
    expect(authenticateScimToken(other.token, REQUEST, opts())?.tenant_slug).toBe('beta');
  });

  it('rejects wrong secrets, non-SCIM credentials and malformed tokens', () => {
    const { token } = issue();
    const wrong = `${token.slice(0, -4)}AAAA`;
    expect(authenticateScimToken(wrong, REQUEST, opts())).toBeNull();
    expect(audit.at(-1)).toMatchObject({ action: 'scim.token.reject', result: 'denied' });
    for (const credential of [
      'a'.repeat(64), // a chronos member / localadmin style token
      'kscim~acme~scim-0123~short',
      'kscim~ACME~scim-0123456789abcdef~' + 'x'.repeat(43),
      '',
      null,
    ]) {
      expect(authenticateScimToken(credential, REQUEST, opts())).toBeNull();
    }
  });

  it('revocation stops authentication and is ledgered + audited', () => {
    const { token, record } = issue();
    const revoked = revokeScimToken(
      { tenantSlug: 'acme', tokenId: record.token_id, revokedByMemberId: 'owner', now: NOW },
      opts()
    );
    expect(revoked).toMatchObject({ status: 'revoked', revoked_by: 'user:owner' });
    expect(authenticateScimToken(token, REQUEST, opts())).toBeNull();
    expect(audit.at(-1)).toMatchObject({ action: 'scim.token.reject', reason: 'revoked' });
    expect(readScimLedger('acme', opts()).at(-1)).toMatchObject({ event: 'revoked' });
    fail(
      () =>
        revokeScimToken(
          { tenantSlug: 'acme', tokenId: record.token_id, revokedByMemberId: 'owner' },
          opts()
        ),
      'revoked'
    );
    expect(listScimTokens('acme', opts()).find((t) => t.token_id === record.token_id)?.status).toBe(
      'revoked'
    );
  });

  it('a record tampered to provision owners is unusable', () => {
    const { token, record } = issue();
    const file = path.join(
      root,
      'knowledge',
      'confidential',
      'acme',
      'scim',
      'tokens',
      `${record.token_id}.json`
    );
    writeJson(file, { ...readJson<Record<string, unknown>>(file), default_role: 'owner' });
    expect(authenticateScimToken(token, REQUEST, opts())).toBeNull();
    expect(audit.at(-1)).toMatchObject({ reason: 'unusable_record' });
  });

  it('coalesces rejections of rotated random tokens instead of flooding the audit chain', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    issue();
    audit = [];
    const random = (tenant: string) =>
      `kscim~${tenant}~scim-${randomUUID().replace(/-/g, '').slice(0, 16)}~${randomUUID()}${randomUUID()}`;
    for (let i = 0; i < 200; i += 1) {
      expect(authenticateScimToken(random('acme'), REQUEST, opts())).toBeNull();
    }
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'scim.token.reject',
        tenantSlug: 'acme',
        reason: 'unknown_or_mismatched',
      }),
    ]);
    // A caller-chosen id is not recorded as if it were a token of the tenant.
    expect(audit[0]).not.toHaveProperty('tokenId');

    // A tenant that does not provision over SCIM gets no entries attributed to it.
    for (let i = 0; i < 50; i += 1) authenticateScimToken(random('ghost'), REQUEST, opts());
    expect(audit).toHaveLength(2);
    expect(audit[1]).not.toHaveProperty('tenantSlug');

    // The next window reports how many were folded in.
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    authenticateScimToken(random('acme'), REQUEST, opts());
    expect(audit.at(-1)).toMatchObject({
      tenantSlug: 'acme',
      metadata: expect.objectContaining({ suppressed_since_last: 199 }),
    });
  });
});
