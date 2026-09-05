import { describe, expect, it } from 'vitest';
import { parseApprovalsResponse } from './approvals-response';

const approval = {
  id: 'approval-1',
  channel: 'chronos',
  storageChannel: 'chronos',
  title: 'Rotate service key',
  summary: 'A service key rotation requires approval.',
  details: 'The runtime will restart.',
  sourceText: 'Please rotate it.',
  target: {
    serviceId: 'service-1',
    secretKey: 'API_KEY',
    mutation: 'rotate',
    existingValuePresent: true,
  },
  justification: {
    reason: 'The current key is expiring.',
    impactSummary: 'One service restart.',
    evidence: ['evidence-1'],
    requestedEffects: ['rotate secret'],
  },
  risk: {
    level: 'high',
    restartScope: 'service-1',
    requiresStrongAuth: true,
    policyId: 'policy-1',
  },
  workLoop: { project_id: 'project-1', track_id: 'track-1', context: { tenant_slug: 'tenant-a' } },
  requestedAt: '2026-09-04T00:00:00.000Z',
  requestedBy: 'operator',
  missionId: 'mission-1',
  tenantSlug: 'tenant-a',
  status: 'pending',
  kind: 'secret_mutation',
};

describe('approvals response boundary', () => {
  it('accepts the approval fields consumed by ApprovalsWorkspace', () => {
    expect(parseApprovalsResponse({ approvals: [approval], accessRole: 'localadmin' })).toEqual({
      approvals: [approval],
      accessRole: 'localadmin',
    });
  });

  it('accepts an empty queue and optional detail objects', () => {
    expect(parseApprovalsResponse({ approvals: [], accessRole: 'readonly' })).toEqual({
      approvals: [],
      accessRole: 'readonly',
    });
    expect(
      parseApprovalsResponse({
        approvals: [
          {
            id: 'approval-1',
            channel: 'chronos',
            storageChannel: 'chronos',
            title: 'Review',
            summary: 'Review request.',
            requestedAt: '2026-09-04T00:00:00.000Z',
            requestedBy: 'operator',
            status: 'pending',
          },
        ],
        accessRole: 'readonly',
      })
    ).toBeDefined();
  });

  it('rejects malformed nested fields and invalid access roles', () => {
    expect(
      parseApprovalsResponse({
        approvals: [{ ...approval, target: { ...approval.target, existingValuePresent: 'yes' } }],
        accessRole: 'localadmin',
      })
    ).toBeUndefined();
    expect(parseApprovalsResponse({ approvals: [approval], accessRole: 'admin' })).toBeUndefined();
  });

  it('rejects unsafe nested keys and primitive approval entries', () => {
    const unsafe = JSON.parse(
      '{"approvals":[{"id":"approval-1","channel":"chronos","storageChannel":"chronos","title":"Review","summary":"Review","requestedAt":"2026-09-04T00:00:00.000Z","requestedBy":"operator","status":"pending","__proto__":"bad"}],"accessRole":"readonly"}'
    );
    expect(parseApprovalsResponse(unsafe)).toBeUndefined();
    expect(parseApprovalsResponse({ approvals: ['bad'], accessRole: 'readonly' })).toBeUndefined();
  });
});
