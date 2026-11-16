/** Approval-time rules of credential lending in the grant store (design §2.3–2.4). */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./service-credential-grant-scope.js', async (original) => {
  const actual = await original<typeof import('./service-credential-grant-scope.js')>();
  return {
    ...actual,
    // The authenticated human-only decision rule itself is covered by its own tests.
    serviceAllocationApprovedByOwner: (
      approval: { workflow?: { approvals?: { approvedBy?: string }[] } },
      owner: string
    ) => approval.workflow?.approvals?.[0]?.approvedBy === owner,
  };
});
import {
  assertCredentialLendingEligible,
  credentialLendingApprovedByOwner,
  normalizeGrantDraft,
  registerCredentialLendingPolicy,
  validateGrantRecord,
} from './grant-store.js';
import type { ApprovalRequestRecord } from './approval-store.js';
import {
  assertCredentialEligible,
  buildCredentialRecord,
  lendingFromRecord,
  type CredentialEligibilityDeps,
} from '../secret/credential-custody.js';

const approvedBy = (who: string) =>
  ({
    workflow: {
      approvals: [
        { status: 'approved', decidedByType: 'human', authenticated: true, approvedBy: who },
      ],
    },
  }) as unknown as ApprovalRequestRecord;
const owned: Record<string, string[]> = { owner: ['home'], cfo: ['parent'] };
const deps: CredentialEligibilityDeps = {
  personalOwnerOf: (t) => (t === 'home' ? 'user:owner' : undefined),
  installationPerson: () => 'owner',
  borrowerAttested: () => true,
};
registerCredentialLendingPolicy({
  ownsTenant: (m, t) => owned[m]?.includes(t) ?? false,
  installationPerson: deps.installationPerson,
  assertEligible: (lending, borrower, now) =>
    assertCredentialEligible(lending, borrower, now, deps),
});
afterEach(() => undefined);

describe('credential lending approval', () => {
  const tenantKey = lendingFromRecord(
    buildCredentialRecord({
      credentialRef: 'tenant:parent:anthropic',
      value: 'sk-ant-test-0001',
      registeredBy: 'user:cfo',
    })
  );
  const pro = lendingFromRecord(
    buildCredentialRecord({
      credentialRef: 'person:owner:claude-subscription',
      plan: 'pro',
      value: 'sk-ant-oat-test-0001',
      registeredBy: 'user:owner',
    })
  );

  it('requires the person owner, or an owner member of the owner tenant', () => {
    expect(credentialLendingApprovedByOwner(pro, approvedBy('user:owner'))).toBe(true);
    expect(credentialLendingApprovedByOwner(pro, approvedBy('user:cfo'))).toBe(false);
    expect(credentialLendingApprovedByOwner(tenantKey, approvedBy('user:cfo'))).toBe(true);
    expect(credentialLendingApprovedByOwner(tenantKey, approvedBy('user:owner'))).toBe(false);
    // S1: a person ref naming someone other than the installation person is never approvable.
    const alice = lendingFromRecord(
      buildCredentialRecord({
        credentialRef: 'person:alice:anthropic',
        value: 'sk-ant-alice-0001',
        registeredBy: 'user:alice',
      })
    );
    expect(credentialLendingApprovedByOwner(alice, approvedBy('user:alice'))).toBe(false);
  });

  it('checks eligibility before the approval request and at apply', () => {
    expect(() =>
      assertCredentialLendingEligible({ credential_lending: pro, tenant_slug: 'home' })
    ).not.toThrow();
    expect(() =>
      assertCredentialLendingEligible({ credential_lending: pro, tenant_slug: 'parent' })
    ).toThrow(/\[CREDENTIAL_KIND_NOT_ELIGIBLE\]/);
  });

  it('normalizes and validates the lending scope on the grant record', () => {
    const draft = normalizeGrantDraft({
      capability: 'credential.use',
      tenant_slug: 'child',
      credential_provider: 'anthropic',
      credential_ref: 'anthropic/API_KEY',
      credential_lending: tenantKey,
      purpose: 'lend',
    });
    expect(draft.credential_lending).toEqual(tenantKey);
    expect(() =>
      normalizeGrantDraft({
        capability: 'credential.use',
        tenant_slug: 'child',
        credential_provider: 'claude-cli',
        credential_ref: 'anthropic/API_KEY',
        credential_lending: tenantKey,
        purpose: 'lend',
      })
    ).toThrow(/must agree/);
    const record = {
      schema_version: 'grant-record.v1',
      grant_id: 'GRT-20261116-0000000000aa',
      capability: 'credential.use',
      scope: {
        tenant_slug: 'child',
        credential_provider: 'anthropic',
        credential_ref: 'anthropic/API_KEY',
        credential_lending: tenantKey,
      },
      purpose: 'lend',
      granted_by: { actor_id: 'user:cfo', role: 'operator', assurance: 'A1' },
      granted_at: '2026-11-16T00:00:00.000Z',
      expires_at: '2026-12-16T00:00:00.000Z',
      audit_event_id: 'audit',
      basis: { approval_request_id: 'a', approval_channel: 'grant-standing' },
    };
    expect(validateGrantRecord(record)).toEqual({ valid: true, errors: [] });
    expect(
      validateGrantRecord({
        ...record,
        scope: {
          ...record.scope,
          credential_lending: { ...tenantKey, kind: 'subscription_token' },
        },
      }).valid
    ).toBe(false);
  });
});
