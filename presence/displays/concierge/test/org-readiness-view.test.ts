import { describe, expect, it } from 'vitest';
import { buildOrgReadiness, parseOrgReadiness } from '../src/lib/org-readiness-view';

const base = {
  tenantSlug: 'acme',
  tenantStatus: 'active' as const,
  memberCount: 1,
  pendingInvites: 0,
  organizationConnections: 0,
  charterInForce: false,
};

describe('buildOrgReadiness', () => {
  it('a brand-new organization has only the organization step done', () => {
    const r = buildOrgReadiness(base);
    expect(r.steps.map((s) => [s.id, s.done])).toEqual([
      ['organization', true],
      ['members', false],
      ['connections', false],
      ['charter', false],
    ]);
    expect(r).toMatchObject({ done: 1, total: 4, all_done: false });
  });
  it('the owner alone is not a team; an invite out, or a second member, completes the step', () => {
    expect(buildOrgReadiness({ ...base, pendingInvites: 1 }).steps[1].done).toBe(true);
    expect(buildOrgReadiness({ ...base, memberCount: 2 }).steps[1].done).toBe(true);
    expect(buildOrgReadiness({ ...base, memberCount: 1 }).steps[1].done).toBe(false);
  });
  it('a suspended, archived or missing organization never counts as set up', () => {
    for (const tenantStatus of ['suspended', 'archived', null] as const) {
      expect(buildOrgReadiness({ ...base, tenantStatus }).steps[0].done).toBe(false);
    }
  });
  it('every step points at the settings section that fixes it', () => {
    expect(buildOrgReadiness(base).steps.map((s) => s.href)).toEqual([
      '#settings-members',
      '#settings-invites',
      '#setup-services',
      '#settings-charter',
    ]);
  });
  it('all done when all four are', () => {
    const r = buildOrgReadiness({
      ...base,
      memberCount: 3,
      organizationConnections: 2,
      charterInForce: true,
    });
    expect(r).toMatchObject({ done: 4, all_done: true });
  });
});

describe('parseOrgReadiness', () => {
  it('accepts the server shape and rejects malformed input', () => {
    const ok = {
      ok: true,
      organizations: [
        {
          tenant_slug: 'acme',
          all_done: false,
          steps: [{ id: 'charter', done: false, href: '#x' }],
        },
      ],
    };
    expect(parseOrgReadiness(ok)).toEqual(ok.organizations);
    expect(parseOrgReadiness({ ok: false, organizations: [] })).toBeUndefined();
    expect(parseOrgReadiness({ ok: true, organizations: [{ tenant_slug: 'a' }] })).toBeUndefined();
    expect(parseOrgReadiness(null)).toBeUndefined();
  });
});
