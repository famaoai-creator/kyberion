import { describe, expect, it, vi } from 'vitest';
const approval = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../governance/approval-store.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store.js')>()),
  loadApprovalRequest: approval.load,
}));
import {
  normalizeGrantDraft,
  grantApprovalPayload,
  grantApprovalEffectBinding,
  validateGrantRecord,
  verifyGrantBasis,
  type GrantRecord,
} from '../governance/grant-store.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
const draft = {
  capability: 'credential.use',
  tenant_slug: 'alpha',
  credential_provider: 'anthropic',
  credential_ref: 'anthropic/API_KEY',
  purpose: 'Reasoning',
  ttl_days: 7,
};
describe('credential standing grant contract', () => {
  it('keeps consumed approval bound to the exact credential reference and lifetime', () => {
    const normalized = normalizeGrantDraft(draft);
    const record: GrantRecord = {
      schema_version: 'grant-record.v1',
      grant_id: 'GRT-20261101-123456abcdef',
      capability: 'credential.use',
      scope: {
        tenant_slug: 'alpha',
        credential_provider: 'anthropic',
        credential_ref: 'anthropic/API_KEY',
      },
      purpose: 'Reasoning',
      granted_by: { actor_id: 'user:test', role: 'sovereign', assurance: 'A1' },
      granted_at: '2026-11-01T00:00:00.000Z',
      expires_at: '2026-11-08T00:00:00.000Z',
      audit_event_id: 'audit',
      basis: { approval_request_id: 'approval-test', approval_channel: 'grant-standing' },
    };
    approval.load.mockReturnValue({
      status: 'approved',
      consumption: {
        consumer: 'grant_standing',
        effectRef: record.grant_id,
        consumedAt: record.granted_at,
      },
      accountability: {
        effectBinding: grantApprovalEffectBinding(normalized),
        payloadHash: computeApprovalPayloadHash(grantApprovalPayload(normalized)),
      },
    });
    expect(validateGrantRecord(record).valid).toBe(true);
    expect(verifyGrantBasis(record)).toBe(true);
    expect(
      verifyGrantBasis({ ...record, scope: { ...record.scope, credential_ref: 'another/API_KEY' } })
    ).toBe(false);
    expect(verifyGrantBasis({ ...record, expires_at: '2026-11-09T00:00:00.000Z' })).toBe(false);
  });
  it('binds the approved payload and effect to the canonical provider as well as the tenant', () => {
    const a = normalizeGrantDraft(draft);
    const b = normalizeGrantDraft({ ...draft, credential_provider: 'openai-api' });
    expect(grantApprovalPayload(a)).toMatchObject({
      credential_provider: 'anthropic',
      tenant_slug: 'alpha',
    });
    expect(grantApprovalPayload(a)).not.toEqual(grantApprovalPayload(b));
    expect(grantApprovalEffectBinding(a)).not.toBe(grantApprovalEffectBinding(b));
    expect(() => normalizeGrantDraft({ ...draft, credential_provider: undefined })).toThrow(
      'credential_provider is required'
    );
  });
  it('rejects stored credential grants that omit the provider or human approval basis', () => {
    const record = {
      schema_version: 'grant-record.v1',
      grant_id: 'GRT-20261101-123456abcdef',
      capability: 'credential.use',
      scope: { tenant_slug: 'alpha' },
      purpose: 'Reasoning',
      granted_by: { actor_id: 'user:test', role: 'sovereign', assurance: 'A1' },
      granted_at: '2026-11-01T00:00:00.000Z',
      expires_at: '2026-11-08T00:00:00.000Z',
      audit_event_id: 'audit',
    };
    expect(validateGrantRecord(record).errors).toEqual(
      expect.arrayContaining([
        'scope.credential_provider is required',
        'external_io capability requires basis.approval_request_id',
      ])
    );
  });
});
