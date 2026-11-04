import { describe, expect, it } from 'vitest';
import type { NeedsYouItem } from '@agent/core/surface/needs-you';
import { customerDecisionCardHref, resolveInboxAnchor } from './needs-you-card';

function approvalItem(id: string, group: NeedsYouItem[] = []): NeedsYouItem {
  return {
    id: `approval:external-operation/${id}`,
    reason: 'approval',
    title: { text: id },
    requester: { label: { text: 'Planner' }, agent: true },
    overdue: false,
    actions: ['approve', 'reject', 'later'],
    group_size: 1 + group.length,
    ...(group.length ? { group } : {}),
    approval: { id } as never,
  } as NeedsYouItem;
}

describe('resolveInboxAnchor (review UX-L6)', () => {
  const folded = approvalItem('a-2');
  const lead = approvalItem('a-1', [folded]);
  const other = approvalItem('b-1');

  it('lands on the card, or on the lead card of the folded group that holds it', () => {
    expect(resolveInboxAnchor([lead, other], new Set(), '#decide-approval-b-1')).toEqual({
      scrollTo: 'decide-approval-b-1',
    });
    expect(resolveInboxAnchor([lead, other], new Set(), '#decide-approval-a-2')).toEqual({
      scrollTo: 'decide-approval-a-1',
    });
  });

  it('reveals a card the viewer set aside before landing on it', () => {
    expect(resolveInboxAnchor([lead, other], new Set([other.id]), '#decide-approval-b-1')).toEqual({
      scrollTo: 'decide-approval-b-1',
      reveal: other.id,
    });
  });

  it('ignores an empty or unknown anchor', () => {
    expect(resolveInboxAnchor([lead], new Set(), '')).toBeNull();
    expect(resolveInboxAnchor([lead], new Set(), '#decide-approval-zzz')).toBeNull();
  });
});

describe('customerDecisionCardHref (review H2 / UX-M1)', () => {
  it("opens the tenant's customer-decision card on 組織", () => {
    expect(customerDecisionCardHref('famao-ai')).toBe('/org?tenant=famao-ai#customer-decisions');
    expect(customerDecisionCardHref()).toBe('/org#customer-decisions');
  });
});
