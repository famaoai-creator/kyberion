import { describe, expect, it } from 'vitest';
import {
  buildApprovalPrimaryActions,
  inferPolicyCategoryFromApproval,
  isApprovalPrimaryAction,
  primaryActionToStoreDecision,
} from './approval-primary-actions.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';

function record(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'channel-approval',
    storageChannel: 'presence',
    channel: 'presence',
    threadTs: 'ts-1',
    correlationId: 'corr-1',
    requestedBy: 'agent:test',
    requestedAt: '2026-11-22T00:00:00.000Z',
    title: 'Allow file:write',
    summary: 'write a deliverable',
    status: 'pending',
    accountability: {
      finalDecision: 'human_only',
      payloadHash: 'abc',
      effectBinding: 'file:write',
    },
    ...overrides,
  } as ApprovalRequestRecord;
}

describe('approval primary actions', () => {
  it('maps Deny / Allow once / Always onto binary settle', () => {
    expect(primaryActionToStoreDecision('deny')).toBe('rejected');
    expect(primaryActionToStoreDecision('allow_once')).toBe('approved');
    expect(primaryActionToStoreDecision('allow_always')).toBe('approved');
    expect(isApprovalPrimaryAction('allow_always')).toBe(true);
    expect(isApprovalPrimaryAction('approve')).toBe(false);
  });

  it('binds Why + three primary buttons to the presented digest', () => {
    const set = buildApprovalPrimaryActions(record());
    expect(set.why.length).toBeGreaterThan(0);
    expect(set.buttons.map((b) => b.kind)).toEqual(['deny', 'allow_once', 'allow_always']);
    expect(set.buttons.every((b) => b.presentedDigestCompact.length === 12)).toBe(true);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.enabled).toBe(true);
  });

  it('disables Always for send_out category', () => {
    const draft = record({ title: 'Outbound webhook send_out', summary: 'egress' });
    expect(inferPolicyCategoryFromApproval(draft)).toBe('send_out');
    const set = buildApprovalPrimaryActions(draft);
    expect(set.policyCategory).toBe('send_out');
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.enabled).toBe(false);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.disabledReason).toBe(
      'always_forbidden_for_category'
    );
  });

  it('disables Always without effect binding', () => {
    const set = buildApprovalPrimaryActions(record({ accountability: undefined }));
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.enabled).toBe(false);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.disabledReason).toBe(
      'always_requires_effect_binding'
    );
  });

  it('disables Always when the category cannot be inferred (fail-closed)', () => {
    const draft = record({ title: 'Generic request', summary: 'needs a decision' });
    expect(inferPolicyCategoryFromApproval(draft)).toBeUndefined();
    const set = buildApprovalPrimaryActions(draft);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.enabled).toBe(false);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.disabledReason).toBe(
      'always_requires_known_category'
    );
  });
});
