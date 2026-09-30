import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const members = vi.hoisted(() => ({
  byMember: {} as Record<string, { id: string; display_name: string; role?: 'owner' | 'approver' }>,
}));

vi.mock('./front-desk-member', () => ({
  resolveConciergeDecidedBy: vi.fn((viewer: { memberId?: string }) =>
    viewer.memberId ? (members.byMember[viewer.memberId] ?? null) : null
  ),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: vi.fn(() => ['acme', 'other-co']),
}));
vi.mock('@agent/core/organization/member-registry', () => ({ ensureOwnerMember: vi.fn() }));

import * as pathResolver from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import {
  actOnCharter,
  acceptCharterForViewer,
  charterTenants,
  previewCharter,
  readCharterOverview,
} from './charter-server';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const viewer = (memberId: string, tenants: string[] | 'all' = ['acme']) =>
  ({ tenantSlugs: tenants, source: 'token', memberId, role: 'localadmin' }) as never;
const form = (over: Record<string, unknown> = {}) => ({
  tenant_slug: 'acme',
  per_action: 100_000,
  per_day: 200_000,
  per_month: 1_000_000,
  max_loss_per_incident: 100_000,
  allow_named_spend: true,
  supersedes_decision_rights: false,
  deputies: ['user:carol'],
  expires_in_days: 90,
  ...over,
});

describe('charter-server', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-srv-${randomUUID()}`
    );
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
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    members.byMember = {
      owner: { id: 'user:owner', display_name: 'Owner', role: 'owner' },
      carol: { id: 'user:carol', display_name: 'Carol', role: 'approver' },
      mallory: { id: 'user:mallory', display_name: 'Mallory', role: 'approver' },
    };
  });

  it('the tenant list is the viewer scope; a requested tenant only narrows', () => {
    expect(charterTenants(viewer('owner', 'all'))).toEqual(['acme', 'other-co']);
    expect(charterTenants(viewer('owner', ['acme']))).toEqual(['acme']);
    expect(charterTenants(viewer('owner', ['acme']), 'other-co')).toEqual([]);
    expect(charterTenants(viewer('owner', 'all'), 'other-co')).toEqual(['other-co']);
  });

  it('preview: owner gets the statement and digest; everyone else is refused with a reason', () => {
    const ok = previewCharter(viewer('owner'), form(), opts(), NOW);
    expect(ok).toMatchObject({ ok: true, replaces: null });
    expect(ok.ok && ok.statement).toContain('user:owner');
    expect(ok.ok && ok.statement_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(previewCharter(viewer('carol'), form(), opts(), NOW)).toMatchObject({
      ok: false,
      status: 403,
      error: 'owner_required',
    });
    expect(previewCharter(viewer('nobody'), form(), opts(), NOW)).toMatchObject({
      ok: false,
      status: 403,
      error: 'member_required',
    });
    expect(previewCharter(viewer('owner', ['other-co']), form(), opts(), NOW)).toMatchObject({
      ok: false,
      status: 403,
      error: 'tenant_out_of_scope',
    });
    expect(previewCharter(viewer('owner'), form({ per_action: 1.5 }), opts(), NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('accept binds the statement the human saw: a different digest is a 409 and writes nothing', () => {
    const shown = previewCharter(viewer('owner'), form(), opts(), NOW);
    if (!shown.ok) throw new Error('preview failed');
    const wrong = previewCharter(viewer('owner'), form({ per_action: 1 }), opts(), NOW);
    if (!wrong.ok) throw new Error('preview failed');
    expect(
      acceptCharterForViewer(viewer('owner'), form(), wrong.statement_sha256, opts(), NOW)
    ).toMatchObject({ ok: false, status: 409, error: 'statement_changed' });
    expect(acceptCharterForViewer(viewer('owner'), form(), 'nothex', opts(), NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(readCharterOverview(viewer('owner'), null, opts(), NOW).tenants[0].charter).toBeNull();
    const done = acceptCharterForViewer(
      viewer('owner'),
      form(),
      shown.statement_sha256,
      opts(),
      NOW
    );
    expect(done).toMatchObject({
      ok: true,
      charter_id: expect.stringMatching(/^chr-acme-20261001-/),
    });
  });

  it('non-owners cannot accept even with a valid digest', () => {
    const shown = previewCharter(viewer('owner'), form({ per_action: 5 }), opts(), NOW);
    if (!shown.ok) throw new Error('x');
    expect(
      acceptCharterForViewer(
        viewer('carol'),
        form({ per_action: 5 }),
        shown.statement_sha256,
        opts(),
        NOW
      )
    ).toMatchObject({ ok: false, status: 403, error: 'owner_required' });
  });

  it('overview: who can create, who can stop; the active charter is shown with limits', () => {
    const asOwner = readCharterOverview(viewer('owner'), null, opts(), NOW);
    expect(asOwner.member).toEqual({ id: 'user:owner', display_name: 'Owner' });
    expect(asOwner.tenants[0]).toMatchObject({
      tenant_slug: 'acme',
      role: 'owner',
      can_create: true,
      can_stop: true,
    });
    expect(asOwner.tenants[0].charter?.money.per_action).toBe(100_000);
    const asDeputy = readCharterOverview(viewer('carol'), null, opts(), NOW).tenants[0];
    expect(asDeputy).toMatchObject({ role: 'approver', can_create: false, can_stop: true });
    const asOther = readCharterOverview(viewer('mallory'), null, opts(), NOW).tenants[0];
    expect(asOther).toMatchObject({ can_create: false, can_stop: false });
  });

  it('amending replaces the charter (preview reports which one)', () => {
    const f = form({ per_action: 60_000 });
    const shown = previewCharter(viewer('owner'), f, opts(), NOW);
    if (!shown.ok) throw new Error('x');
    expect(shown.replaces).toMatch(/^chr-acme-/);
    const done = acceptCharterForViewer(viewer('owner'), f, shown.statement_sha256, opts(), NOW);
    expect(done.ok).toBe(true);
    expect(
      readCharterOverview(viewer('owner'), null, opts(), NOW).tenants[0].charter?.money.per_action
    ).toBe(60_000);
  });

  it('stop / resume / retire: accountable human or deputy only', () => {
    expect(actOnCharter(viewer('mallory'), 'acme', 'stop', opts(), NOW)).toMatchObject({
      ok: false,
      status: 403,
      error: 'not_responsible',
    });
    expect(actOnCharter(viewer('owner', ['other-co']), 'acme', 'stop', opts(), NOW)).toMatchObject({
      ok: false,
      error: 'tenant_out_of_scope',
    });
    expect(actOnCharter(viewer('owner'), 'acme', 'stop', opts(), NOW)).toMatchObject({ ok: true });
    expect(
      readCharterOverview(viewer('owner'), null, opts(), NOW).tenants[0].charter?.report
        .tripwires_standing
    ).toEqual(['manual-stop']);
    expect(actOnCharter(viewer('carol'), 'acme', 'clear', opts(), NOW)).toMatchObject({ ok: true });
    expect(
      readCharterOverview(viewer('owner'), null, opts(), NOW).tenants[0].charter?.report
        .tripwires_standing
    ).toEqual([]);
    expect(actOnCharter(viewer('owner'), 'acme', 'retire', opts(), NOW)).toMatchObject({
      ok: true,
    });
    expect(readCharterOverview(viewer('owner'), null, opts(), NOW).tenants[0].charter).toBeNull();
    expect(actOnCharter(viewer('owner'), 'acme', 'stop', opts(), NOW)).toMatchObject({
      ok: false,
      status: 404,
      error: 'no_active_charter',
    });
  });
});
