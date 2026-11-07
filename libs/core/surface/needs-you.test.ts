import { describe, expect, it } from 'vitest';
import type { CeoApprovalItem } from './ceo-surface-summary.js';
import type { DecisionBrief } from './decision-brief.js';
import {
  NEEDS_YOU_OVERDUE_AFTER_MS,
  buildNeedsYouQueue,
  narrowNeedsYouItem,
  pageNeedsYou,
  summarizeNeedsYou,
  type NeedsYouSourceData,
} from './needs-you.js';
import { invokeSurfaceOperation } from './surface-operation-registry.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function brief(overrides: Partial<DecisionBrief> = {}): DecisionBrief {
  return {
    ask: { key: 'ux_a_generic_ask', params: { action: 'publish' } },
    why: [{ key: 'ux_a_generic_why' }],
    onApprove: { key: 'ux_a_generic_on_approve' },
    onReject: { key: 'ux_a_generic_on_reject' },
    ifSilent: { key: 'ux_a_if_silent_wait' },
    requester: { key: 'ux_a_actor_agent', params: { name: 'Planner' } },
    state: 'pending',
    groupKey: 'famao-ai|vcs:pr_create|same',
    details: [],
    ...overrides,
  };
}

function approval(id: string, overrides: Partial<CeoApprovalItem> = {}): CeoApprovalItem {
  return {
    id,
    channel: 'external-operation',
    storage_channel: 'external-operation',
    title: `Approval required: ${id}`,
    reason: '',
    requested_at: iso(-HOUR),
    tenant_slug: 'famao-ai',
    organization_id: 'famao-ai',
    brief: brief(),
    ...overrides,
  };
}

const EMPTY: NeedsYouSourceData = {
  approvals: [],
  outcomes: [],
  knowledge: [],
  clarifications: [],
  failures: [],
};
const ALL: SurfaceAuthorizationContext = {
  role: 'readonly',
  tenantSlugs: 'all',
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential', 'public'],
};

describe('needs-you count definition', () => {
  it('counts only open items: pending, not expired, open inbox statuses, queued candidates', () => {
    const items = buildNeedsYouQueue(
      {
        ...EMPTY,
        approvals: [
          approval('a-open', { brief: brief({ groupKey: 'g1' }) }),
          approval('a-expired', { brief: brief({ groupKey: 'g2', state: 'expired' }) }),
          approval('a-resolved', { brief: brief({ groupKey: 'g3', state: 'resolved' }) }),
          // No brief: falls back to expires_at.
          approval('a-nobrief-expired', { brief: undefined, expires_at: iso(-HOUR) }),
        ],
        outcomes: [
          {
            entry_id: 'o-unread',
            title: 'Report',
            summary: '',
            artifact_paths: [],
            status: 'unread',
            updated_at: iso(-HOUR),
          },
          {
            entry_id: 'o-accepted',
            title: 'Done',
            summary: '',
            artifact_paths: [],
            status: 'accepted',
            updated_at: iso(-HOUR),
          },
          {
            entry_id: 'o-changes',
            title: 'Back',
            summary: '',
            artifact_paths: [],
            status: 'changes_requested',
            updated_at: iso(-HOUR),
          },
          {
            entry_id: 'INBOX-CDH-1',
            title: 'Customer asked',
            summary: '',
            artifact_paths: [],
            status: 'unread',
            updated_at: iso(-HOUR),
            kind: 'customer_decision_handoff',
          },
        ],
        knowledge: [
          {
            id: 'k1',
            kind: 'sop',
            summary: 's',
            source: 'x',
            sensitivity_tier: 'public',
            occurrences: 1,
            queued_at: iso(-HOUR),
            status: 'queued',
          },
          {
            id: 'k2',
            kind: 'sop',
            summary: 's',
            source: 'x',
            sensitivity_tier: 'public',
            occurrences: 1,
            queued_at: iso(-HOUR),
            status: 'approved',
          },
        ],
        clarifications: [{ mission_id: 'MSN-1', title: 'Stalled', reason: 'stale', age_days: 3 }],
        failures: [
          { id: 'f1', title: 'Broke', text: '', surface: 'presence', created_at: iso(-HOUR) },
        ],
      },
      { viewer: ALL, now: NOW }
    );
    expect(items.map((item) => item.id).sort()).toEqual(
      [
        'approval:external-operation/a-open',
        'clarification:MSN-1',
        'decision:INBOX-CDH-1',
        'failure:f1',
        'knowledge:k1',
        'review:o-unread',
      ].sort()
    );
    // H2: a customer-decision hand-off can be closed by the operator, and its
    // title never shows the raw agenda id.
    const decision = items.find((item) => item.id === 'decision:INBOX-CDH-1')!;
    expect(decision.actions).toEqual(['mark_handled', 'open', 'later']);
    expect(decision.title).toEqual({ key: 'ia_inbox_decision_title' });
    const summary = summarizeNeedsYou(items);
    expect(summary).toMatchObject({
      ok: true,
      total: 6,
      byReason: { approval: 1, decision: 1, review: 1, knowledge: 1, clarification: 1, failure: 1 },
    });
  });

  it('folds identical approvals into one item that keeps the true count (U4)', () => {
    const items = buildNeedsYouQueue(
      {
        ...EMPTY,
        approvals: [
          approval('a1', { requested_at: iso(-3 * HOUR) }),
          approval('a2', { requested_at: iso(-2 * HOUR) }),
          approval('a3', { requested_at: iso(-1 * HOUR) }),
          approval('b1', { brief: brief({ groupKey: 'other' }) }),
        ],
      },
      { viewer: ALL, now: NOW }
    );
    expect(items).toHaveLength(2);
    const folded = items.find((item) => item.group_size > 1)!;
    expect(folded.group_size).toBe(3);
    expect(folded.group?.map((other) => other.approval?.id)).toHaveLength(2);
    // Every folded record stays decidable on its own.
    expect(folded.group?.every((other) => other.actions.includes('approve'))).toBe(true);
    const summary = summarizeNeedsYou(items);
    expect(summary.total).toBe(2);
    expect(summary.byReason.approval).toBe(2);
    // The oldest wait includes records folded inside a group.
    expect(summary.oldestWaitingSince).toBe(iso(-3 * HOUR));
  });

  it('dedupes an approval read through two views before folding', () => {
    const items = buildNeedsYouQueue(
      { ...EMPTY, approvals: [approval('a1'), approval('a1'), approval('a2')] },
      { viewer: ALL, now: NOW }
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.group_size).toBe(2);
  });

  it('dedupes the same record read twice', () => {
    const items = buildNeedsYouQueue(
      {
        ...EMPTY,
        clarifications: [
          { mission_id: 'MSN-1', title: 'Stalled', reason: 'stale', age_days: 3 },
          { mission_id: 'MSN-1', title: 'Stalled', reason: 'stale', age_days: 3 },
        ],
      },
      { viewer: ALL, now: NOW }
    );
    expect(items).toHaveLength(1);
  });

  it('marks overdue by past deadline, or by a long wait without one, and sorts overdue first', () => {
    const items = buildNeedsYouQueue(
      {
        ...EMPTY,
        approvals: [
          approval('due-later', { brief: brief({ groupKey: 'x', deadline: iso(HOUR) }) }),
          approval('due-past', { brief: brief({ groupKey: 'y', deadline: iso(-HOUR) }) }),
        ],
        failures: [
          {
            id: 'old',
            title: 'Old',
            text: '',
            surface: 'p',
            created_at: iso(-NEEDS_YOU_OVERDUE_AFTER_MS - HOUR),
          },
          { id: 'new', title: 'New', text: '', surface: 'p', created_at: iso(-HOUR) },
        ],
      },
      { viewer: ALL, now: NOW }
    );
    const overdue = items.filter((item) => item.overdue).map((item) => item.id);
    expect(overdue.sort()).toEqual(['approval:external-operation/due-past', 'failure:old']);
    expect(items[0]!.overdue).toBe(true);
    expect(items[1]!.overdue).toBe(true);
    expect(summarizeNeedsYou(items).overdue).toBe(2);
  });

  it('labels the asker as an agent when it is one', () => {
    const [item] = buildNeedsYouQueue(
      { ...EMPTY, approvals: [approval('a1')] },
      { viewer: ALL, now: NOW }
    );
    expect(item!.requester.agent).toBe(true);
    const [human] = buildNeedsYouQueue(
      { ...EMPTY, approvals: [approval('a2', { brief: brief({ requester: { text: 'Aiko' } }) })] },
      { viewer: ALL, now: NOW }
    );
    expect(human!.requester.agent).toBe(false);
  });

  it('offers only the actions that apply per reason', () => {
    const items = buildNeedsYouQueue(
      {
        ...EMPTY,
        outcomes: [
          {
            entry_id: 'r',
            title: 'R',
            summary: '',
            artifact_paths: [],
            status: 'unread',
            updated_at: iso(-HOUR),
          },
        ],
        failures: [{ id: 'f', title: 'F', text: '', surface: 'p', created_at: iso(-HOUR) }],
        knowledge: [
          {
            id: 'k',
            kind: 'sop',
            summary: '',
            source: '',
            sensitivity_tier: 'public',
            occurrences: 1,
            queued_at: iso(-HOUR),
            learningReviewUrl: 'http://x/',
          },
        ],
      },
      { viewer: ALL, now: NOW }
    );
    const by = Object.fromEntries(items.map((item) => [item.reason, item.actions]));
    expect(by.review).toEqual(['approve', 'request_changes', 'reject', 'later']);
    expect(by.failure).toEqual(['later']);
    expect(by.knowledge).toEqual(['open', 'later']);
  });
});

describe('needs-you scope narrowing', () => {
  const data: NeedsYouSourceData = {
    ...EMPTY,
    approvals: [
      approval('famao', { brief: brief({ groupKey: 'f' }) }),
      approval('acme', {
        tenant_slug: 'acme',
        organization_id: 'acme',
        brief: brief({ groupKey: 'a' }),
      }),
      approval('personal', {
        tenant_slug: undefined,
        organization_id: undefined,
        brief: brief({ groupKey: 'p' }),
      }),
    ],
  };
  const ids = (items: ReturnType<typeof buildNeedsYouQueue>) =>
    items.map((item) => item.approval?.id).sort();

  it('drops items that name a tenant outside the viewer', () => {
    const viewer = {
      tenantSlugs: ['famao-ai'],
      organizationIds: 'all',
      projectIds: 'all',
    } as const;
    expect(ids(buildNeedsYouQueue(data, { viewer, now: NOW }))).toEqual(['famao', 'personal']);
  });

  it('a client tenant narrows but never widens', () => {
    const viewer = {
      tenantSlugs: ['famao-ai'],
      organizationIds: 'all',
      projectIds: 'all',
    } as const;
    expect(
      ids(buildNeedsYouQueue(data, { viewer, narrowing: { tenant: 'famao-ai' }, now: NOW }))
    ).toEqual(['famao']);
    expect(buildNeedsYouQueue(data, { viewer, narrowing: { tenant: 'acme' }, now: NOW })).toEqual(
      []
    );
  });

  it('counts after narrowing, so a folded group counts only its in-scope members', () => {
    const shared = brief({ groupKey: 'same' });
    const items = buildNeedsYouQueue(
      {
        ...EMPTY,
        approvals: [
          approval('in-1', { brief: shared }),
          approval('in-2', { brief: shared }),
          approval('out', { tenant_slug: 'acme', brief: shared }),
        ],
      },
      { viewer: { tenantSlugs: ['famao-ai'], organizationIds: 'all', projectIds: 'all' }, now: NOW }
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.group_size).toBe(2);
  });

  it('organization and project narrowing keep only items that name them', () => {
    expect(
      narrowNeedsYouItem({ tenant_slug: 'a', organization_id: 'o1' }, ALL, {
        organization_id: 'o1',
      })
    ).toBe(true);
    expect(narrowNeedsYouItem({ tenant_slug: 'a' }, ALL, { organization_id: 'o1' })).toBe(false);
    expect(
      narrowNeedsYouItem(
        { project_id: 'p2' },
        { tenantSlugs: 'all', organizationIds: 'all', projectIds: ['p1'] }
      )
    ).toBe(false);
  });
});

describe('needs-you paging', () => {
  const items = buildNeedsYouQueue(
    {
      ...EMPTY,
      failures: Array.from({ length: 5 }, (_, index) => ({
        id: `f${index}`,
        title: 'F',
        text: '',
        surface: 'p',
        created_at: iso(-(index + 1) * HOUR),
      })),
      clarifications: [{ mission_id: 'MSN-1', title: 'S', reason: 'stale', age_days: 1 }],
    },
    { viewer: ALL, now: NOW }
  );

  it('filters by reason and pages with a cursor', () => {
    const first = pageNeedsYou(items, { reason: 'failure', limit: 2 });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    const last = pageNeedsYou(items, { reason: 'failure', limit: 2, cursor: '4' });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
  });

  it('filters overdue', () => {
    expect(pageNeedsYou(items, { overdue: true }).total).toBe(0);
  });
});

describe('needs-you registry operations', () => {
  const data = (): NeedsYouSourceData => ({
    ...EMPTY,
    approvals: [
      approval('a1'),
      approval('a2'),
      approval('x', { tenant_slug: 'acme', brief: brief({ groupKey: 'z' }) }),
    ],
  });
  const viewer: SurfaceAuthorizationContext = {
    role: 'readonly',
    tenantSlugs: ['famao-ai'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
  };

  it('summary uses the one count definition under the viewer scope', () => {
    const result = invokeSurfaceOperation('needs-you.summary', {}, { viewer, needsYou: data });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({ total: 1, byReason: { approval: 1 } });
  });

  it('list accepts query-string filters and returns the contract shape', () => {
    const result = invokeSurfaceOperation(
      'needs-you.list',
      { reason: 'approval', overdue: 'false', limit: '10' },
      { viewer, needsYou: data }
    );
    expect(result.ok).toBe(true);
    const page = result.ok ? (result.data as ReturnType<typeof pageNeedsYou>) : null;
    expect(page?.total).toBe(1);
    expect(page?.items[0]?.group_size).toBe(2);
  });

  it('rejects an unknown reason', () => {
    const result = invokeSurfaceOperation(
      'needs-you.list',
      { reason: 'nope' },
      { viewer, needsYou: data }
    );
    expect(result.ok).toBe(false);
  });
});
