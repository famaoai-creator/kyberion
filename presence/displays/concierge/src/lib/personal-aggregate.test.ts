import { describe, expect, it } from 'vitest';
import type { CeoSurfaceSummary } from '@agent/core/ceo-surface-summary';
import { buildPersonalAggregate } from './personal-aggregate';
import type { ConciergeViewerContext } from './viewer-context';

function viewer(tenantSlugs: string[] | 'all'): ConciergeViewerContext {
  return {
    role: 'readonly',
    tenantSlugs,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'token',
  };
}

function home(slug: string, approvals: number, title = ''): CeoSurfaceSummary {
  return {
    generated_at: '2026-10-10T00:00:00.000Z',
    briefing: {
      sentence_ja: '',
      counts: {
        active_missions: 1,
        pending_approvals: approvals,
        unread_outcomes: 0,
        exceptions: 0,
      },
    },
    intent_inbox: [],
    approval_queue: title
      ? [
          {
            id: `${slug}-1`,
            channel: 'chronos',
            storage_channel: 'chronos',
            title,
            reason: '',
            requested_at: '2026-10-10T00:00:00.000Z',
            tenant_slug: slug,
          },
        ]
      : [],
    outcome_feed: [],
    exception_feed: [],
  };
}

describe('buildPersonalAggregate', () => {
  it('reads each company through a viewer narrowed to exactly that tenant', () => {
    const reads: Array<{ tenants: string[] | 'all'; untenanted: boolean }> = [];
    const aggregate = buildPersonalAggregate(viewer('all'), ['acme', 'beta'], {
      readCompanyHome: (narrowed) => {
        reads.push({
          tenants: narrowed.tenantSlugs,
          untenanted: Boolean(narrowed.includeUntenanted),
        });
        const slug = narrowed.tenantSlugs === 'all' ? 'all' : (narrowed.tenantSlugs[0] ?? 'system');
        return home(
          slug,
          slug === 'acme' ? 2 : 0,
          slug === 'acme' ? 'Approve the acme budget' : ''
        );
      },
      displayName: (slug) => (slug === 'acme' ? 'Acme' : null),
    });
    expect(reads).toEqual([
      { tenants: ['acme'], untenanted: false },
      { tenants: ['beta'], untenanted: false },
      { tenants: [], untenanted: true },
    ]);
    expect(aggregate.companies).toEqual([
      {
        tenant_slug: 'acme',
        display_name: 'Acme',
        counts: { active_missions: 1, pending_approvals: 2, unread_outcomes: 0, exceptions: 0 },
        headline: 'Approve the acme budget',
      },
      {
        tenant_slug: 'beta',
        display_name: 'beta',
        counts: { active_missions: 1, pending_approvals: 0, unread_outcomes: 0, exceptions: 0 },
      },
    ]);
    expect(aggregate.system).toEqual({
      counts: { active_missions: 1, pending_approvals: 0, unread_outcomes: 0, exceptions: 0 },
    });
  });

  it('gives an explicitly scoped viewer no system card', () => {
    const reads: boolean[] = [];
    const aggregate = buildPersonalAggregate(viewer(['acme', 'beta']), ['acme', 'beta'], {
      readCompanyHome: (narrowed) => {
        reads.push(Boolean(narrowed.includeUntenanted));
        return home('acme', 0);
      },
      displayName: () => null,
    });
    expect(aggregate.system).toBeUndefined();
    expect(reads).toEqual([false, false]);
  });

  it('skips an allowed slug the viewer scope does not include and truncates long headlines', () => {
    const aggregate = buildPersonalAggregate(viewer(['acme']), ['acme', 'beta'], {
      readCompanyHome: () => home('acme', 1, 'x'.repeat(200)),
      displayName: () => null,
    });
    expect(aggregate.companies.map((card) => card.tenant_slug)).toEqual(['acme']);
    expect(aggregate.companies[0].headline).toHaveLength(121);
  });
});
