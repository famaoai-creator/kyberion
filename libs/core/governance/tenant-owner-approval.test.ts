import { describe, expect, it } from 'vitest';
import {
  requiresTenantOwnerApproval,
  tenantOwnerApprovalDenied,
  TENANT_OWNER_APPROVAL_REQUIRED,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { buildApprovalPrimaryActions } from '../surface/approval-primary-actions.js';

function ownerGrant(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: '00000000-0000-4000-8000-000000000099',
    kind: 'channel-approval',
    storageChannel: 'grant-standing',
    channel: 'grant-standing',
    threadTs: 'credential.use:acme',
    correlationId: 'corr',
    requestedBy: 'agent:codex',
    requestedAt: '2026-11-22T00:00:00.000Z',
    title: 'Standing grant',
    summary: 'credential.use',
    status: 'pending',
    scope: { tier: 'confidential', tenant_slug: 'acme' },
    workflow: {
      workflowId: 'w',
      mode: 'all_required',
      requiredRoles: ['owner'],
      stages: [],
      approvals: [{ role: 'owner', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: 'hash',
      effectBinding: 'grant-standing:credential.use:acme',
    },
    ...overrides,
  } as ApprovalRequestRecord;
}

describe('tenant Owner approval continuity (PR #1563)', () => {
  it('requires Owner for same-tenant credential Grant standing approvals', () => {
    expect(requiresTenantOwnerApproval(ownerGrant())).toBe(true);
    expect(tenantOwnerApprovalDenied(ownerGrant(), 'member')).toBe(true);
    expect(tenantOwnerApprovalDenied(ownerGrant(), 'owner')).toBe(false);
    expect(TENANT_OWNER_APPROVAL_REQUIRED.code).toBe('APPROVAL_TENANT_OWNER_REQUIRED');
  });

  it('does not treat ordinary approvals as Owner-gated', () => {
    expect(
      requiresTenantOwnerApproval(
        ownerGrant({
          storageChannel: 'presence',
          workflow: {
            workflowId: 'w',
            mode: 'all_required',
            requiredRoles: ['sovereign'],
            stages: [],
            approvals: [{ role: 'sovereign', status: 'pending' }],
          },
        })
      )
    ).toBe(false);
  });

  it('disables PiBot Always on Owner-gated Grant cards (resume via Allow once + CLI)', () => {
    const set = buildApprovalPrimaryActions(ownerGrant());
    expect(set.buttons.find((b) => b.kind === 'allow_once')?.enabled).toBe(true);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.enabled).toBe(false);
    expect(set.buttons.find((b) => b.kind === 'allow_always')?.disabledReason).toBe(
      'grant_resume_not_session_always'
    );
  });
});
