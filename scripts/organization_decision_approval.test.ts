import { describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/approval-store', () => ({ loadApprovalRequest: load }));

import { verifyDecisionApprovalRef } from './organization_decision_approval.js';
import type { OrganizationDecisionRecord } from '@agent/core/organization-operating-model';

const decision = {
  decision_id: 'DEC-1',
  organization_id: 'ORG-1',
  tier: 'confidential',
  tenant_slug: 'acme',
} as OrganizationDecisionRecord;

describe('organization decision approval binding', () => {
  it('rejects a human approval from another tenant', () => {
    load.mockReturnValue({
      status: 'approved',
      decidedByType: 'human',
      authenticated: true,
      decidedAuthMethod: 'surface_session',
      accountability: {
        finalDecision: 'human_only',
        effectBinding: 'organization:decision:DEC-1:approved',
      },
      scope: { organization_id: 'ORG-1', tier: 'confidential', tenant_slug: 'other' },
      justification: { requestedEffects: ['organization:decision:DEC-1:approved'] },
    });
    expect(() => verifyDecisionApprovalRef('local:APP-1', decision, 'approved')).toThrow(/bound/);
  });

  it('accepts an authenticated human approval for the exact decision', () => {
    load.mockReturnValue({
      status: 'approved',
      decidedByType: 'human',
      authenticated: true,
      decidedAuthMethod: 'surface_session',
      accountability: {
        finalDecision: 'human_only',
        effectBinding: 'organization:decision:DEC-1:approved',
      },
      scope: { organization_id: 'ORG-1', tier: 'confidential', tenant_slug: 'acme' },
      justification: { requestedEffects: ['organization:decision:DEC-1:approved'] },
    });
    expect(verifyDecisionApprovalRef('local:APP-1', decision, 'approved')).toBe('local:APP-1');
  });

  it('rejects a local-token decision even when its scope matches', () => {
    load.mockReturnValue({
      status: 'approved',
      decidedByType: 'human',
      authenticated: true,
      decidedAuthMethod: 'local_token',
      accountability: {
        finalDecision: 'human_only',
        effectBinding: 'organization:decision:DEC-1:approved',
      },
      scope: { organization_id: 'ORG-1', tier: 'confidential', tenant_slug: 'acme' },
      justification: { requestedEffects: ['organization:decision:DEC-1:approved'] },
    });
    expect(() => verifyDecisionApprovalRef('local:APP-1', decision, 'approved')).toThrow(/bound/);
  });
});
