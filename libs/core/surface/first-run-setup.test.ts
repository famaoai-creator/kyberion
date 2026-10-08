import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const issued = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../secret/secret-guard.js', () => ({
  secretGuard: {
    loadConnectionDocument: (id: string) => ({ ...(store.get(id) ?? {}) }),
    storeConnectionDocument: (id: string, patch: Record<string, unknown>) => {
      store.set(id, { ...(store.get(id) ?? {}), ...patch });
      return { path: id, changedKeys: Object.keys(patch) };
    },
  },
}));
vi.mock('../chronos-access-registry.js', () => ({
  issueChronosAccessToken: (input: Record<string, unknown>) => {
    issued.push(input);
    return { token: `raw-token-${issued.length}`, registration: { label: input.label } };
  },
}));
vi.mock('./operator-identity.js', () => ({
  resolveOperatorDisplayName: (fallback?: string) => fallback ?? 'operator',
}));

import {
  FIRST_RUN_DOCUMENT,
  FIRST_RUN_MAX_FAILED_ATTEMPTS,
  FirstRunError,
  claimFirstRun,
  isInstanceOwner,
  issueFirstRunSetupCode,
  readFirstRunStatus,
} from './first-run-setup.js';
import { readMemberProfile, writeMemberProfile } from '../organization/member-registry.js';
import { readTenantProfile, writeTenantProfile } from '../organization/tenant-registry.js';

const NOW = Date.parse('2026-10-09T00:00:00.000Z');

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FirstRunError);
    expect((error as FirstRunError).code).toBe(code);
    return;
  }
  throw new Error(`expected FirstRunError(${code})`);
}

describe('first-run setup', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const audit = vi.fn();
  const opts = (over: { now?: number } = {}) => ({ rootDir: root, now: NOW, audit, ...over });

  beforeAll(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });
  const freshRoot = () => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `first-run-${randomUUID()}`
    );
  };
  afterEach(() => {
    if (root) safeRmSync(root, { recursive: true, force: true });
    store.clear();
    issued.length = 0;
    audit.mockReset();
  });

  it('is unclaimed on a fresh instance and stores only the code hash', () => {
    freshRoot();
    expect(readFirstRunStatus(opts())).toEqual({ state: 'unclaimed', code_active: false });
    const { code, expires_at } = issueFirstRunSetupCode({}, opts());
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    expect(expires_at).toBe('2026-10-09T00:30:00.000Z');
    const doc = store.get(FIRST_RUN_DOCUMENT)!;
    expect(JSON.stringify(doc)).not.toContain(code.replace(/-/g, ''));
    expect(readFirstRunStatus(opts())).toMatchObject({ state: 'unclaimed', code_active: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'code_issued' }));
  });

  it('claims: creates tenant + owner, issues a token once, then closes for good', () => {
    freshRoot();
    const { code } = issueFirstRunSetupCode({}, opts());
    const result = claimFirstRun(
      {
        code: code.toLowerCase(),
        tenant_slug: 'acme',
        tenant_display_name: 'Acme',
        display_name: 'Hana',
      },
      opts()
    );
    expect(result).toMatchObject({
      token: 'raw-token-1',
      member_id: 'owner',
      tenant_slug: 'acme',
      tenant_slugs: ['acme'],
      registration_label: 'owner-first-run-20261009000000',
    });
    expect(issued[0]).toMatchObject({
      role: 'localadmin',
      tenantSlugs: ['acme'],
      memberId: 'owner',
    });
    expect(readTenantProfile('acme', { rootDir: root })).toMatchObject({ display_name: 'Acme' });
    const owner = readMemberProfile('owner', { rootDir: root })!;
    expect(owner).toMatchObject({
      display_name: 'Hana',
      memberships: [{ tenant_slug: 'acme', role: 'owner' }],
      access_registrations: [{ label: 'owner-first-run-20261009000000' }],
    });
    expect(isInstanceOwner(owner, { rootDir: root })).toBe(true);
    expect(readFirstRunStatus(opts()).state).toBe('claimed');
    expectCode(
      () => claimFirstRun({ code, tenant_slug: 'acme', display_name: 'Again' }, opts()),
      'claimed'
    );
    expectCode(() => issueFirstRunSetupCode({}, opts()), 'claimed');
  });

  it('stays closed when an owner can already sign in, even without the claim marker', () => {
    freshRoot();
    writeMemberProfile(
      {
        member_id: 'owner',
        display_name: 'Owner',
        status: 'active',
        memberships: [{ tenant_slug: 'acme', role: 'owner' }],
        access_registrations: [],
        external_identities: [{ issuer: 'https://idp.example', subject: 's-1' }],
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
      },
      { rootDir: root }
    );
    expect(readFirstRunStatus(opts()).state).toBe('claimed');
  });

  it('a loopback-provisioned owner without credentials can still claim', () => {
    freshRoot();
    writeMemberProfile(
      {
        member_id: 'owner',
        display_name: 'Owner',
        status: 'active',
        memberships: [],
        access_registrations: [],
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
      },
      { rootDir: root }
    );
    const { code } = issueFirstRunSetupCode({}, opts());
    claimFirstRun({ code, tenant_slug: 'acme', display_name: 'Hana' }, opts());
    const owner = readMemberProfile('owner', { rootDir: root })!;
    expect(owner.created_at).toBe(new Date(NOW).toISOString());
    expect(owner.memberships).toEqual([{ tenant_slug: 'acme', role: 'owner' }]);
  });

  it('rejects expired, wrong and missing codes; locks after the attempt limit', () => {
    freshRoot();
    expectCode(
      () => claimFirstRun({ code: 'X', tenant_slug: 'acme', display_name: 'H' }, opts()),
      'code_not_issued'
    );
    const { code } = issueFirstRunSetupCode({ ttlMinutes: 5 }, opts());
    expectCode(
      () =>
        claimFirstRun(
          { code, tenant_slug: 'acme', display_name: 'H' },
          opts({ now: NOW + 6 * 60_000 })
        ),
      'code_expired'
    );
    for (let i = 1; i < FIRST_RUN_MAX_FAILED_ATTEMPTS; i += 1) {
      expectCode(
        () => claimFirstRun({ code: 'WRONG', tenant_slug: 'acme', display_name: 'H' }, opts()),
        'code_invalid'
      );
    }
    expectCode(
      () => claimFirstRun({ code: 'WRONG', tenant_slug: 'acme', display_name: 'H' }, opts()),
      'code_locked'
    );
    // The real code no longer works once locked.
    expectCode(
      () => claimFirstRun({ code, tenant_slug: 'acme', display_name: 'H' }, opts()),
      'code_not_issued'
    );
    expect(issued).toHaveLength(0);
    expect(readMemberProfile('owner', { rootDir: root })).toBeNull();
  });

  it('validates input before spending a code attempt', () => {
    freshRoot();
    const { code } = issueFirstRunSetupCode({}, opts());
    expectCode(
      () => claimFirstRun({ code, tenant_slug: 'public', display_name: 'H' }, opts()),
      'invalid_input'
    );
    expectCode(
      () => claimFirstRun({ code, tenant_slug: 'acme', display_name: ' ' }, opts()),
      'invalid_input'
    );
    expectCode(
      () =>
        claimFirstRun({ code, tenant_slug: 'acme', display_name: 'H', member_id: 'ext-x' }, opts()),
      'invalid_input'
    );
    expect(store.get(FIRST_RUN_DOCUMENT)?.failed_attempts).toBe(0);
    expectCode(() => issueFirstRunSetupCode({ ttlMinutes: 0 }, opts()), 'invalid_input');
  });

  it('discloses tenant state only to a valid code holder and keeps the code usable', () => {
    freshRoot();
    writeTenantProfile(
      {
        tenant_slug: 'acme',
        tenant_id: 'acme',
        display_name: 'Acme',
        status: 'suspended',
        assigned_role: 'owner',
      },
      { rootDir: root }
    );
    const { code } = issueFirstRunSetupCode({}, opts());
    expectCode(
      () => claimFirstRun({ code: 'WRONG', tenant_slug: 'acme', display_name: 'H' }, opts()),
      'code_invalid'
    );
    expectCode(
      () => claimFirstRun({ code, tenant_slug: 'acme', display_name: 'H' }, opts()),
      'tenant_unavailable'
    );
    const result = claimFirstRun({ code, tenant_slug: 'beta', display_name: 'H' }, opts());
    expect(result.tenant_slug).toBe('beta');
  });

  it('isInstanceOwner requires owner on every registered tenant', () => {
    freshRoot();
    const { code } = issueFirstRunSetupCode({}, opts());
    claimFirstRun({ code, tenant_slug: 'acme', display_name: 'Hana' }, opts());
    const partial = {
      member_id: 'bob',
      display_name: 'Bob',
      status: 'active' as const,
      memberships: [{ tenant_slug: 'acme', role: 'approver' as const }],
      access_registrations: [],
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
    };
    expect(isInstanceOwner(partial, { rootDir: root })).toBe(false);
    expect(isInstanceOwner(null, { rootDir: root })).toBe(false);
  });
});
