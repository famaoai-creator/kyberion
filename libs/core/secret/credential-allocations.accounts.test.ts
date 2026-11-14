import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { GrantRecord } from '../governance/grant-store.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
import { withExecutionContext } from '../authority.js';
import { assertAccountCredentialMaterialRead } from '../foundation/credential-material-capability.js';
import {
  resolveTaskCredential,
  resolveTaskServiceCredential,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
const state = vi.hoisted(() => ({
  claim: 'claim-a',
  revoked: false,
  approved: true,
  duplicate: false,
  unrelated: false,
  generation: '11111111-1111-4111-8111-111111111111',
  pending: false,
  owner: 'user:owner',
  key: 'synthetic-account-token',
  read: vi.fn(),
}));
const binding = (): ServiceBindingRecord => ({
  binding_id: 'slack-owner',
  service_id: 'slack',
  service_type: 'api',
  scope: 'person',
  target: 'owner-workspace',
  owner_kind: 'person',
  owner_ref: state.owner,
  auth_mode: 'secret-guard',
  secret_refs: ['SLACK_TOKEN'],
  allowed_actions: ['read'],
  approval_policy: { read: 'allowed' },
});
const grant = (other = false): GrantRecord => ({
  schema_version: 'grant-record.v1',
  grant_id: other ? 'GRT-OTHER' : 'GRT-OWNER',
  capability: 'credential.use',
  scope: {
    tenant_slug: 'alpha',
    service_allocation: {
      binding_id: other ? 'slack-other' : 'slack-owner',
      service_id: 'slack',
      owner_ref: 'user:owner',
      target: 'owner-workspace',
      secret_refs: ['SLACK_TOKEN'],
      allowed_actions: ['read'],
      ...(other && state.unrelated ? { task_id: 'other-task' } : {}),
    },
  },
  purpose: 'test',
  granted_by: { actor_id: 'user:owner', role: 'sovereign', assurance: 'A2' },
  granted_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  audit_event_id: 'test',
});
vi.mock('../governance/grant-store.js', () => ({
  listGrants: () => [grant(), ...(state.duplicate || state.unrelated ? [grant(true)] : [])],
  loadGrant: (_tenant: string, id: string) => (id === 'GRT-OWNER' ? grant() : grant(true)),
  grantStatusAt: () => (state.revoked ? 'revoked' : 'active'),
  verifyGrantBasis: () => state.approved,
}));
vi.mock('./shell-task-credential-binding.js', () => ({
  assertTaskCredentialClaim: () => {
    if (!state.claim) throw new Error('claim denied');
    return state.claim;
  },
}));
vi.mock('../service/service-binding-reader.js', () => ({
  loadServiceBindingRecord: () => binding(),
}));
vi.mock('./secret-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./secret-guard.js')>()),
  localAccountMaterialAccountId: () => 'a'.repeat(64),
  loadAllocatedLocalAccountRegistration: () => {
    assertAccountCredentialMaterialRead('alpha', 'a'.repeat(64), null);
    state.read('registration');
    return {
      generation: state.generation,
      ...(state.pending ? { pendingApprovalId: 'pending' } : {}),
    };
  },
  loadAllocatedLocalAccountMaterial: () => {
    assertAccountCredentialMaterialRead('alpha', 'a'.repeat(64), state.generation);
    state.read('material');
    return { SLACK_TOKEN: state.key };
  },
}));
import {
  bindAllocatedTaskCredentials,
  installLocalCredentialAllocations,
} from './credential-allocations.js';
import { resetSecretResolver } from './secret-resolver.js';
const input = {
  scope: {
    tier: 'confidential' as const,
    tenant_slug: 'alpha',
    mission_id: 'MSN-TEST',
    task_id: 'task-a',
  },
  workItemId: 'WI-test',
};
const tenant = <T>(run: () => T) =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', 'alpha', undefined, {
    missionId: 'MSN-TEST',
    taskId: 'task-a',
  });
const expected = {
  serviceBindingId: 'slack-owner',
  serviceId: 'slack',
  sourceOwnerRef: 'user:owner',
  allocationGrantId: 'GRT-OWNER',
};
beforeEach(() => {
  Object.assign(state, {
    claim: 'claim-a',
    revoked: false,
    approved: true,
    duplicate: false,
    unrelated: false,
    generation: '11111111-1111-4111-8111-111111111111',
    pending: false,
    owner: 'user:owner',
    key: 'synthetic-account-token',
  });
  state.read.mockClear();
  resetSecretResolver();
  installLocalCredentialAllocations();
});
afterEach(() => {
  resetSecretResolver();
  vi.unstubAllEnvs();
});
describe('registered personal account tenant allocation', () => {
  it('uses exact allocation provenance and keeps generic credential access closed', async () =>
    tenant(async () => {
      const result = await bindAllocatedTaskCredentials(input);
      expect(result?.secretProvenance?.SLACK_TOKEN).toEqual(expected);
      await withTaskCredentialBinding(result!, async () => {
        expect(resolveTaskCredential('SLACK_TOKEN')).toBeNull();
        expect(resolveTaskServiceCredential('SLACK_TOKEN', expected)).toBe(
          'synthetic-account-token'
        );
        expect(() =>
          resolveTaskServiceCredential('SLACK_TOKEN', { ...expected, serviceBindingId: 'other' })
        ).toThrow('PROVENANCE');
      });
    }));
  it.each(['generation', 'pending', 'owner', 'revoked', 'approved', 'claim', 'key'] as const)(
    'invalidates consumption after %s changes',
    async (field) =>
      tenant(async () => {
        const result = await bindAllocatedTaskCredentials(input);
        await withTaskCredentialBinding(result!, async () => {
          if (field === 'generation') state.generation = '22222222-2222-4222-8222-222222222222';
          if (field === 'pending') state.pending = true;
          if (field === 'owner') state.owner = 'user:other';
          if (field === 'revoked') state.revoked = true;
          if (field === 'approved') state.approved = false;
          if (field === 'claim') state.claim = 'claim-b';
          if (field === 'key') state.key = 'changed';
          expect(() => resolveTaskServiceCredential('SLACK_TOKEN', expected)).toThrow();
        });
      })
  );
  it('refuses ambiguous references before material reads, but ignores allocations scoped to other tasks', async () =>
    tenant(async () => {
      state.duplicate = true;
      await expect(bindAllocatedTaskCredentials(input)).rejects.toThrow('ALLOCATION_DENIED');
      expect(state.read).not.toHaveBeenCalled();
      state.duplicate = false;
      state.unrelated = true;
      expect((await bindAllocatedTaskCredentials(input))?.secretProvenance?.SLACK_TOKEN).toEqual(
        expected
      );
    }));
  it('does not read without an active claim or owner approval', async () =>
    tenant(async () => {
      state.claim = '';
      await expect(bindAllocatedTaskCredentials(input)).rejects.toThrow('claim denied');
      expect(state.read).not.toHaveBeenCalled();
      state.claim = 'claim-a';
      state.approved = false;
      expect(await bindAllocatedTaskCredentials(input)).toBeNull();
      expect(state.read).not.toHaveBeenCalled();
    }));
});
