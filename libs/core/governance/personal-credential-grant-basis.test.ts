import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./approval-store-reader.js', async (original) => ({
  ...(await original<typeof import('./approval-store-reader.js')>()),
  loadApprovalRequest: mocks.load,
}));
import { verifyPersonalCredentialGrantBasis } from './personal-credential-grant.js';
import {
  personalCredentialGrantPayload,
  personalCredentialGrantEffect,
  type PersonalCredentialGrantRecord,
} from './personal-credential-grant-scope.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import type { ApprovalRequestRecord } from './approval-store.js';

function fixture() {
  const scope = {
    owner_ref: 'user:owner',
    nhi_id: 'kyberion://agent/_/_/personal',
    binding_id: 'personal-slack',
    service_id: 'slack',
    target: 'synthetic',
    secret_refs: ['SLACK_TOKEN'],
    allowed_actions: ['read'],
    generation: '12345678-1234-4123-8123-123456789abc',
    project_id: 'project-a',
    mission_id: 'MSN-A',
    task_id: 'task-a',
  };
  const at = new Date(Date.now() - 1000).toISOString();
  const record: PersonalCredentialGrantRecord = {
    schema_version: 'grant-record.v1',
    grant_id: 'GRT-20261114-123456abcdef',
    capability: 'credential.personal_use',
    custody: { kind: 'person', ref: 'owner' },
    scope,
    purpose: 'synthetic consent',
    granted_by: { actor_id: 'user:owner', role: 'member_self', assurance: 'A2' },
    granted_at: at,
    expires_at: new Date(Date.parse(at) + 86400_000).toISOString(),
    audit_event_id: 'audit',
    basis: { approval_request_id: 'approval', approval_channel: 'grant-standing' },
  };
  const draft = { scope, purpose: record.purpose, ttl_days: 1 };
  const payloadHash = computeApprovalPayloadHash(personalCredentialGrantPayload(draft));
  const effectBinding = personalCredentialGrantEffect(draft);
  const ownerDecision = {
    role: 'owner',
    status: 'approved',
    decidedByType: 'human',
    authenticated: true,
    approvedBy: 'user:owner',
    authMethod: 'surface_session',
    payloadHash,
    effectBinding,
  };
  const approval = {
    status: 'approved',
    scope: { tier: 'personal', nhi_id: scope.nhi_id },
    requestedByContext: { actorId: scope.nhi_id },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
    consumption: { consumer: 'grant_standing', effectRef: record.grant_id, consumedAt: at },
    workflow: {
      approvals: [
        { ...ownerDecision, approvedBy: 'user:other', authMethod: 'passkey' },
        ownerDecision,
      ],
    },
  } as unknown as ApprovalRequestRecord;
  mocks.load.mockReturnValue(approval);
  return { record, approval };
}
describe('personal credential grant approval basis', () => {
  beforeEach(() => vi.clearAllMocks());
  it('does not upgrade legacy consent by adding a runtime marker to its grant record', () => {
    const { record } = fixture();
    expect(verifyPersonalCredentialGrantBasis(record)).toBe(true);
    expect(
      verifyPersonalCredentialGrantBasis({
        ...record,
        scope: { ...record.scope, runtime_use: 'selected-read-api-v1' },
      })
    ).toBe(false);
  });
  it('requires the owner decision even if another human decision precedes it', () => {
    const { record, approval } = fixture();
    expect(verifyPersonalCredentialGrantBasis(record)).toBe(true);
    approval.workflow!.approvals.pop();
    expect(verifyPersonalCredentialGrantBasis(record)).toBe(false);
  });
  it('rejects revoked approval, foreign custody and changed grant identity', () => {
    const { record, approval } = fixture();
    expect(
      verifyPersonalCredentialGrantBasis({ ...record, custody: { kind: 'person', ref: 'other' } })
    ).toBe(false);
    expect(
      verifyPersonalCredentialGrantBasis({ ...record, grant_id: 'GRT-20261114-aaaaaaaaaaaa' })
    ).toBe(false);
    approval.revocation = {} as NonNullable<ApprovalRequestRecord['revocation']>;
    expect(verifyPersonalCredentialGrantBasis(record)).toBe(false);
  });
});
