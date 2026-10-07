import { describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  computeApprovalPayloadHash: (
    (await importOriginal()) as typeof import('@agent/core/governance/approval-store')
  ).computeApprovalPayloadHash,
  loadApprovalRequest: load,
  createApprovalRequest: create,
}));

import {
  decisionApprovalPayloadHash,
  requestDecisionApproval,
  verifyDecisionApprovalRef,
} from './organization_decision_approval.js';
import type { OrganizationDecisionRecord } from '@agent/core/organization/organization-operating-model';

const decision = {
  decision_id: 'DEC-1',
  organization_id: 'ORG-1',
  tier: 'confidential',
  tenant_slug: 'acme',
  title: 'Pick vendor',
  options: ['a', 'b'],
} as OrganizationDecisionRecord;

function decided(overrides: Record<string, unknown> = {}) {
  return {
    status: 'approved',
    decidedByType: 'human',
    authenticated: true,
    decidedAuthMethod: 'surface_session',
    accountability: {
      finalDecision: 'human_only',
      effectBinding: 'organization:decision:DEC-1:approved',
      payloadHash: decisionApprovalPayloadHash(decision, 'a'),
    },
    scope: { organization_id: 'ORG-1', tier: 'confidential', tenant_slug: 'acme' },
    justification: {
      requestedEffects: [
        'organization:decision:DEC-1:approved',
        'organization:decision:DEC-1:rejected',
      ],
    },
    ...overrides,
  };
}

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

  it('opens a human-only request scoped to the decision and its proposed option', () => {
    create.mockReturnValue({ id: 'REQ-1', storageChannel: 'terminal' });
    const result = requestDecisionApproval({
      decision,
      chosenOption: 'a',
      requestedBy: 'organization_operator',
    });
    expect(result).toEqual({
      ref: 'terminal:REQ-1',
      request_id: 'REQ-1',
      effect: 'organization:decision:DEC-1:approved',
    });
    const params = create.mock.calls[0]![1];
    expect(params.accountability).toEqual({
      finalDecision: 'human_only',
      payloadHash: decisionApprovalPayloadHash(decision, 'a'),
      effectBinding: 'organization:decision:DEC-1:approved',
    });
    expect(params.scope).toEqual({
      tier: 'confidential',
      tenant_slug: 'acme',
      organization_id: 'ORG-1',
    });
    expect(() =>
      requestDecisionApproval({ decision, chosenOption: 'z', requestedBy: 'x' })
    ).toThrow(/not one of the decision options/);
  });

  it('accepts the requested approval only for the option it named', () => {
    load.mockReturnValue(decided());
    expect(verifyDecisionApprovalRef('terminal:REQ-1', decision, 'approved', 'a')).toBe(
      'terminal:REQ-1'
    );
    expect(() => verifyDecisionApprovalRef('terminal:REQ-1', decision, 'approved', 'b')).toThrow(
      /different option/
    );
  });

  it('treats a human denial of the approval request as the rejection', () => {
    load.mockReturnValue(decided({ status: 'rejected' }));
    expect(verifyDecisionApprovalRef('terminal:REQ-1', decision, 'rejected')).toBe(
      'terminal:REQ-1'
    );
    expect(() => verifyDecisionApprovalRef('terminal:REQ-1', decision, 'approved', 'a')).toThrow(
      /bound/
    );
  });
});
