import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./approval-store-reader.js', async (original) => ({
  ...(await original<typeof import('./approval-store-reader.js')>()),
  loadApprovalRequest: mocks.load,
}));
import {
  normalizeGrantDraft,
  grantApprovalPayload,
  grantApprovalEffectBinding,
  validateGrantRecord,
  verifyGrantBasis,
  type GrantRecord,
  type ServiceCredentialAllocationScope,
} from './grant-store.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { serviceAllocationApprovedByOwner } from './service-credential-grant-scope.js';
import type { ApprovalRequestRecord } from './approval-store.js';
const allocation: ServiceCredentialAllocationScope = {
  binding_id: 'personal-slack',
  target: 'workspace:acme',
  owner_ref: 'user:alice',
  service_id: 'slack',
  secret_refs: ['SLACK_TOKEN'],
  allowed_actions: ['read'],
  project_id: 'project-a',
  mission_id: 'MSN-A',
  task_id: 'task-a',
};
const draft = {
  capability: 'credential.use',
  tenant_slug: 'acme',
  service_allocation: allocation,
  purpose: 'Company work',
  ttl_days: 7,
};
function fixture() {
  const normalized = normalizeGrantDraft(draft);
  const payloadHash = computeApprovalPayloadHash(grantApprovalPayload(normalized));
  const effectBinding = grantApprovalEffectBinding(normalized);
  const record: GrantRecord = {
    schema_version: 'grant-record.v1',
    grant_id: 'GRT-20261101-123456abcdef',
    capability: 'credential.use',
    scope: { tenant_slug: 'acme', service_allocation: allocation },
    purpose: draft.purpose,
    granted_by: { actor_id: 'user:alice', role: 'sovereign', assurance: 'A2' },
    granted_at: '2026-11-01T00:00:00.000Z',
    expires_at: '2026-11-08T00:00:00.000Z',
    audit_event_id: 'audit',
    basis: { approval_request_id: 'approval-test', approval_channel: 'grant-standing' },
  };
  const approval = {
    status: 'approved',
    consumption: {
      consumer: 'grant_standing',
      effectRef: record.grant_id,
      consumedAt: record.granted_at,
    },
    accountability: { finalDecision: 'human_only', effectBinding, payloadHash },
    workflow: {
      approvals: [
        {
          status: 'approved',
          decidedByType: 'human',
          authenticated: true,
          authMethod: 'surface_session',
          approvedBy: 'user:alice',
          payloadHash,
          effectBinding,
        },
      ],
    },
  } as unknown as ApprovalRequestRecord;
  mocks.load.mockReturnValue(approval);
  return { record, approval };
}
describe('service credential grant scope', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['', ' '.repeat(3), 'x'.repeat(2049), 'target\nother'])(
    'rejects invalid target',
    (target) => {
      expect(() =>
        normalizeGrantDraft({ ...draft, service_allocation: { ...allocation, target } })
      ).toThrow();
    }
  );
  it('normalizes bounded scopes and keeps reasoning grants compatible', () => {
    expect(
      normalizeGrantDraft({
        ...draft,
        service_allocation: { ...allocation, allowed_actions: ['write', 'read', 'read'] },
      }).service_allocation?.allowed_actions
    ).toEqual(['read', 'write']);
    expect(
      normalizeGrantDraft({
        capability: 'credential.use',
        tenant_slug: 'acme',
        credential_provider: 'anthropic',
        credential_ref: 'anthropic/API_KEY',
        purpose: 'Reasoning',
      }).credential_ref
    ).toBe('anthropic/API_KEY');
    expect(() =>
      normalizeGrantDraft({
        ...draft,
        credential_provider: 'anthropic',
        credential_ref: 'anthropic/API_KEY',
      })
    ).toThrow(/exclusive/);
    expect(() => normalizeGrantDraft({ ...draft, capability: 'meeting.recording' })).toThrow(
      /exclusive/
    );
    expect(() =>
      normalizeGrantDraft({
        ...draft,
        service_allocation: { ...allocation, allowed_actions: ['*'] },
      })
    ).toThrow();
    expect(() =>
      normalizeGrantDraft({ ...draft, service_allocation: { ...allocation, owner_ref: 'user:' } })
    ).toThrow();
  });
  it('requires the actual authenticated owner, not a claimed grantor', () => {
    const { record, approval } = fixture();
    expect(validateGrantRecord(record).valid).toBe(true);
    expect(verifyGrantBasis(record)).toBe(true);
    expect(serviceAllocationApprovedByOwner(approval, 'user:bob')).toBe(false);
    expect(
      verifyGrantBasis({ ...record, granted_by: { ...record.granted_by, actor_id: 'user:bob' } })
    ).toBe(false);
    approval.workflow!.approvals![0]!.approvedBy = 'user:bob';
    expect(verifyGrantBasis(record)).toBe(false);
    approval.workflow!.approvals![0]!.approvedBy = 'user:alice';
    approval.workflow!.approvals![0]!.authenticated = false;
    expect(verifyGrantBasis(record)).toBe(false);
  });
  it.each([
    { binding_id: 'other' },
    { target: 'workspace:other' },
    { owner_ref: 'user:bob' },
    { service_id: 'github' },
    { secret_refs: ['OTHER_TOKEN'] },
    { allowed_actions: ['write'] },
    { project_id: 'other' },
    { mission_id: 'MSN-B' },
    { task_id: 'other' },
  ])('hash-binds every allocation field %j', (change) => {
    const { record } = fixture();
    const changed = { ...allocation, ...change };
    expect(
      grantApprovalPayload(normalizeGrantDraft({ ...draft, service_allocation: changed }))
    ).not.toEqual(grantApprovalPayload(normalizeGrantDraft(draft)));
    expect(
      verifyGrantBasis({ ...record, scope: { ...record.scope, service_allocation: changed } })
    ).toBe(false);
  });
  it('rejects untyped authority metadata and revoked approval', () => {
    const { record, approval } = fixture();
    expect(
      validateGrantRecord({
        ...record,
        scope: {
          ...record.scope,
          service_allocation: { ...allocation, metadata: { owner: 'user:alice' } },
        },
      }).valid
    ).toBe(false);
    approval.revocation = {} as NonNullable<ApprovalRequestRecord['revocation']>;
    expect(verifyGrantBasis(record)).toBe(false);
  });
});
