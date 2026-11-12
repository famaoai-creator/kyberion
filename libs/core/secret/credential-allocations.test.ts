import { assertServiceCredentialAllocation } from '../governance/service-credential-allocation.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantRecord } from '../governance/grant-store.js';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import {
  credentialExecutionIdentity,
  resolveTaskCredential,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { resolveRole, withExecutionContext } from '../authority.js';
import { isCredentialMaterialCapability } from '../foundation/credential-material-capability.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { mintScopeEnvelope, withScopeEnvelope } from '../scope-envelope.js';
const state = vi.hoisted(() => ({
  key: 'allocated-test-key',
  revoked: false,
  expired: false,
  approved: true,
  claim: 'claim-a',
  read: vi.fn(),
  admitted: vi.fn(),
  extraProvider: false,
  serviceVerify: vi.fn(),
}));
const grant = (): GrantRecord => ({
  schema_version: 'grant-record.v1',
  grant_id: 'GRT-20261101-123456abcdef',
  capability: 'credential.use',
  scope: {
    tenant_slug: 'alpha',
    credential_provider: 'anthropic',
    credential_ref: 'anthropic/API_KEY',
  },
  purpose: 'reasoning',
  granted_by: { actor_id: 'user:owner', role: 'sovereign', assurance: 'A1' },
  granted_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  audit_event_id: 'audit',
  ...(state.revoked
    ? { revoked: { at: new Date().toISOString(), by: 'user:owner', audit_event_id: 'revoked' } }
    : {}),
});
vi.mock('../governance/service-credential-allocation-verifier.js', () => ({
  verifyServiceCredentialAllocation: state.serviceVerify,
}));
vi.mock('../governance/grant-store.js', () => ({
  listGrants: () => [
    grant(),
    ...(state.extraProvider
      ? [
          {
            ...grant(),
            grant_id: 'GRT-OTHER',
            scope: {
              tenant_slug: 'alpha',
              credential_provider: 'openai-api',
              credential_ref: 'openai/API_KEY',
            },
          },
        ]
      : []),
  ],
  loadGrant: (tenant: string) => (tenant === 'alpha' ? grant() : null),
  verifyGrantBasis: () => state.approved,
  grantStatusAt: () => (state.revoked ? 'revoked' : state.expired ? 'expired' : 'active'),
}));
vi.mock('./shell-task-credential-binding.js', () => ({
  assertTaskCredentialClaim: () => {
    state.admitted();
    if (!state.claim) throw new Error('claim denied');
    return state.claim;
  },
}));
vi.mock('../foundation/json.js', async (original) => {
  const actual = await original<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJson: (path: string) => {
      const normalized = path.replaceAll('\\', '/');
      if (!normalized.includes('/personal/connections/')) return actual.readJson(path);
      state.read(path);
      // G2: the live material grant (not a reader role) authorizes the read.
      expect(resolveRole()).not.toBe('credential_material_reader');
      expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(true);
      expect(normalized).toMatch(/knowledge\/personal\/connections\/anthropic\.json$/);
      return { api_key: state.key };
    },
  };
});
import {
  bindAllocatedTaskCredentials,
  installLocalCredentialAllocations,
} from './credential-allocations.js';
import {
  getSecretResolver,
  registerSecretResolver,
  resetSecretResolver,
} from './secret-resolver.js';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'alpha',
  mission_id: 'MSN-TEST',
  task_id: 'task-a',
};
const input = { scope, workItemId: 'WI-test' };
const tenant = <T>(run: () => T) =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', 'alpha', undefined, {
    missionId: scope.mission_id,
    taskId: scope.task_id,
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.key = 'allocated-test-key';
  state.revoked = false;
  state.expired = false;
  state.approved = true;
  state.claim = 'claim-a';
  state.extraProvider = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretResolver();
});
describe('local credential allocation broker', () => {
  it('never reads excluded provider material or couples its freshness to an allowed task', async () => {
    state.extraProvider = true;
    const envelope = mintScopeEnvelope({
      identity: { tenant_slug: 'alpha', mission_id: scope.mission_id, task_id: scope.task_id },
      env: { KYBERION_TIER: 'confidential', KYBERION_TENANT: 'alpha' },
      policy: {
        purpose: 'provider isolation regression',
        allowed_reasoning_backends: ['anthropic'],
      },
    });
    await withScopeEnvelope(envelope, () =>
      tenant(async () => {
        const binding = await bindAllocatedTaskCredentials(input);
        expect(binding?.secrets).toEqual({ ANTHROPIC_API_KEY: 'allocated-test-key' });
        await withTaskCredentialBinding(binding!, async () => {
          expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('allocated-test-key');
          expect(resolveTaskCredential('OPENAI_API_KEY')).toBeNull();
        });
        expect(
          state.read.mock.calls.every(([path]) => String(path).endsWith('/anthropic.json'))
        ).toBe(true);
      })
    );
  });
  it('installs a default resolver and yields to an explicitly registered upstream', () => {
    resetSecretResolver();
    expect(installLocalCredentialAllocations()).toBe(true);
    expect(getSecretResolver()?.name).toBe('local-credential-allocations');
    registerSecretResolver({
      name: 'external-test',
      resolve: () => null,
      bindTask: async () => null,
    });
    expect(getSecretResolver()?.name).toBe('external-test');
    const configuredResolver = getSecretResolver();
    expect(installLocalCredentialAllocations()).toBe(false);
    expect(getSecretResolver()).toBe(configuredResolver);
    const selected = { binding_id: 'test-binding' } as ServiceBindingRecord;
    state.serviceVerify.mockReturnValue(grant());
    expect(assertServiceCredentialAllocation(selected, scope, { action: 'read' })).toMatchObject({
      capability: 'credential.use',
    });
    expect(state.serviceVerify).toHaveBeenCalledWith(selected, scope, { action: 'read' });
    expect(getSecretResolver()?.name).toBe('external-test');
  });
  it('binds only the declared provider key and keeps claim checks live', async () =>
    tenant(async () => {
      const binding = await bindAllocatedTaskCredentials(input);
      expect(binding?.secrets).toEqual({ ANTHROPIC_API_KEY: 'allocated-test-key' });
      expect(credentialExecutionIdentity()).toEqual({
        tenantSlug: 'alpha',
        missionId: 'MSN-TEST',
        taskId: 'task-a',
      });
      await withTaskCredentialBinding(binding!, async () => {
        expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('allocated-test-key');
        state.claim = 'claim-b';
        expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
          'CREDENTIAL_ALLOCATION_DENIED'
        );
      });
    }));
  it.each(['revoked', 'expired', 'approved'] as const)(
    'rejects %s changes before the next managed send',
    async (field) =>
      tenant(async () => {
        const binding = await bindAllocatedTaskCredentials(input);
        await withTaskCredentialBinding(binding!, async () => {
          expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('allocated-test-key');
          state[field] = field !== 'approved';
          expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
            'CREDENTIAL_ALLOCATION_DENIED'
          );
        });
      })
  );
  it('invalidates a binding when the stored key rotates', async () =>
    tenant(async () => {
      const binding = await bindAllocatedTaskCredentials(input);
      await withTaskCredentialBinding(binding!, async () => {
        state.key = 'allocated-test-kex';
        expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
          'CREDENTIAL_ALLOCATION_DENIED'
        );
      });
    }));
  it('does not read material without an active claim or valid approval', async () =>
    tenant(async () => {
      state.claim = '';
      await expect(bindAllocatedTaskCredentials(input)).rejects.toThrow('claim denied');
      expect(state.read).not.toHaveBeenCalled();
      state.claim = 'claim-a';
      state.approved = false;
      expect(await bindAllocatedTaskCredentials(input)).toBeNull();
      expect(state.read).not.toHaveBeenCalled();
    }));
  it('has no personal fallback for a different tenant', async () =>
    runInExecutionScope({ tenantBound: true, tenantSlug: 'beta' }, async () => {
      state.approved = true;
      const binding = await bindAllocatedTaskCredentials({
        scope: { ...scope, tenant_slug: 'beta' },
        workItemId: 'WI-beta',
      });
      expect(binding).toBeNull();
      expect(state.read).not.toHaveBeenCalled();
    }));
});
