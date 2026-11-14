import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mintScopeEnvelope,
  withScopeEnvelope,
  resetScopeEnvelopeState,
  currentScopeEnvelope,
} from '../scope-envelope.js';
import { registerSecretResolver, resetSecretResolver } from './secret-resolver.js';
import {
  hasTaskCredentialBinding,
  resolveProviderApiCredential,
  resolveTaskCredential,
  resolveTaskProviderEnvironment,
  withTaskCredentialBinding,
  registerCredentialScopeReader,
  selectProviderCredential,
} from '../foundation/credential-binding.js';
import { withConfiguredTaskCredentials } from './task-credential-dispatch.js';
const envelope = (tenantSlug?: string) =>
  mintScopeEnvelope({
    env: {
      KYBERION_TIER: tenantSlug ? 'confidential' : 'public',
      MISSION_ID: tenantSlug ? `MSN-${tenantSlug}` : 'MSN-OPERATOR',
      ...(tenantSlug ? { KYBERION_TENANT: tenantSlug, KYBERION_TASK_ID: 'task-a' } : {}),
    },
    policy: { purpose: 'trusted credential test' },
  });
afterEach(() => {
  // Restore the actual envelope projection after fault-injection cases.
  registerCredentialScopeReader(() => {
    const identity = currentScopeEnvelope()?.identity;
    return (
      identity && {
        tenantSlug: identity.tenant_slug,
        missionId: identity.mission_id,
        taskId: identity.task_id,
      }
    );
  });
  resetSecretResolver();
  resetScopeEnvelopeState();
  vi.unstubAllEnvs();
});
describe('configured task credential dispatch', () => {
  it.each([undefined, 'beta'])(
    'rejects a missing or stale tenant projection (%s) before selecting operator credentials',
    async (projectedTenant) => {
      vi.stubEnv('KYBERION_TENANT', '');
      vi.stubEnv('MISSION_ID', '');
      vi.stubEnv('KYBERION_TASK_ID', '');
      vi.stubEnv('KYBERION_SCOPE_ENV_PATH', 'active/shared/tmp/absent-dispatch-scope.env');
      resetSecretResolver();
      const active = envelope('alpha');
      registerCredentialScopeReader(() =>
        projectedTenant ? { tenantSlug: projectedTenant } : undefined
      );
      const provider = vi.fn();
      const run = vi.fn(async () =>
        provider(selectProviderCredential(['TEST_BOUND_KEY'], 'synthetic-operator-key'))
      );
      await expect(
        withScopeEnvelope(active, () => withConfiguredTaskCredentials('WI-alpha', run))
      ).rejects.toThrow('CREDENTIAL_SCOPE_DENIED');
      expect(run).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    }
  );

  it('isolates concurrent tenant bindings after asynchronous resolution', async () => {
    registerSecretResolver({
      name: 'scoped-resolver',
      resolve: () => null,
      async bindTask({ scope, workItemId }) {
        await Promise.resolve();
        return {
          tenantSlug: scope.tenant_slug!,
          missionId: scope.mission_id,
          taskId: scope.task_id,
          secrets: { TEST_BOUND_KEY: workItemId },
        };
      },
    });
    const results = await Promise.all(
      ['alpha', 'beta'].map((tenantSlug) =>
        withScopeEnvelope(envelope(tenantSlug), () =>
          withConfiguredTaskCredentials(`WI-${tenantSlug}`, async () => {
            await Promise.resolve();
            return resolveTaskCredential('TEST_BOUND_KEY');
          })
        )
      )
    );
    expect(results).toEqual(['WI-alpha', 'WI-beta']);
    expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeUndefined();
  });
  it('keeps empty bindings final, avoids duplicate binding and rejects unproved personal dispatch', async () => {
    vi.stubEnv('TEST_BOUND_KEY', 'operator-key');
    const bindTask = vi.fn(async ({ scope }: { scope: { tenant_slug?: string } }) => ({
      tenantSlug: scope.tenant_slug!,
      secrets: {},
    }));
    registerSecretResolver({ name: 'empty-resolver', resolve: () => null, bindTask });
    await withScopeEnvelope(envelope('alpha'), () =>
      withConfiguredTaskCredentials('WI-alpha', async () => {
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeNull();
      })
    );
    expect(bindTask).toHaveBeenCalledTimes(1);
    await withScopeEnvelope(envelope('alpha'), () =>
      withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () =>
        withConfiguredTaskCredentials('WI-alpha', async () => {})
      )
    );
    expect(bindTask).toHaveBeenCalledTimes(1);
    await expect(
      withScopeEnvelope(envelope(), () =>
        withConfiguredTaskCredentials('WI-operator', async () => 'operator')
      )
    ).rejects.toThrow('CREDENTIAL_PERSONAL_CLAIM_DENIED');
    expect(bindTask).toHaveBeenCalledTimes(1);
  });

  it('mints a lineage-only binding when no resolver or binder is configured', async () => {
    // No resolver registered at all: a fresh tenant still executes claimed
    // WorkItems inside a binding that grants zero credentials.
    await withScopeEnvelope(envelope('alpha'), () =>
      withConfiguredTaskCredentials('WI-alpha', async () => {
        expect(hasTaskCredentialBinding()).toBe(true);
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeNull();
      })
    );
    // A resolver without bindTask behaves the same way.
    registerSecretResolver({ name: 'resolve-only', resolve: () => null });
    await withScopeEnvelope(envelope('alpha'), () =>
      withConfiguredTaskCredentials('WI-alpha', async () => {
        expect(hasTaskCredentialBinding()).toBe(true);
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeNull();
      })
    );
    // A binder that declines (null) also falls back to lineage-only.
    resetSecretResolver();
    registerSecretResolver({
      name: 'declining-resolver',
      resolve: () => null,
      bindTask: () => null,
    });
    await withScopeEnvelope(envelope('alpha'), () =>
      withConfiguredTaskCredentials('WI-alpha', async () => {
        expect(hasTaskCredentialBinding()).toBe(true);
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeNull();
      })
    );
  });

  it('keeps every credential consumption fail-closed inside the lineage binding', async () => {
    vi.stubEnv('TEST_BOUND_KEY', 'operator-key');
    resetSecretResolver();
    await withScopeEnvelope(envelope('alpha'), () =>
      withConfiguredTaskCredentials('WI-alpha', async () => {
        expect(hasTaskCredentialBinding()).toBe(true);
        // Scoped miss, never an operator-env fallback.
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeNull();
        expect(selectProviderCredential(['TEST_BOUND_KEY'], 'operator-key')).toBeUndefined();
        // Provider env access is denied outright — no isolated env is bound.
        expect(() => resolveTaskProviderEnvironment('claude-cli')).toThrow(
          '[CREDENTIAL_PROVIDER_DENIED]'
        );
        // API key selection finds nothing bound and refuses the operator value.
        expect(() => resolveProviderApiCredential(['TEST_BOUND_KEY'], 'operator-key')).toThrow(
          '[CREDENTIAL_KEY_UNAVAILABLE]'
        );
      })
    );
  });

  it('refuses unproved and unenveloped claimed dispatch without entering the callback', async () => {
    const run = vi.fn(async () => {});
    await expect(
      withScopeEnvelope(envelope(), () => withConfiguredTaskCredentials('WI-operator', run))
    ).rejects.toThrow('CREDENTIAL_PERSONAL_CLAIM_DENIED');
    await expect(withConfiguredTaskCredentials('WI-no-envelope', run)).rejects.toThrow(
      'CREDENTIAL_BINDING_UNAVAILABLE'
    );
    expect(run).not.toHaveBeenCalled();
    // Direct operator setup remains separate from the claimed dispatch helper.
    expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeUndefined();
  });
});
