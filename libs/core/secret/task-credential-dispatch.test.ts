import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mintScopeEnvelope,
  withScopeEnvelope,
  resetScopeEnvelopeState,
} from '../scope-envelope.js';
import { registerSecretResolver, resetSecretResolver } from './secret-resolver.js';
import {
  resolveTaskCredential,
  withTaskCredentialBinding,
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
  resetSecretResolver();
  resetScopeEnvelopeState();
  vi.unstubAllEnvs();
});
describe('configured task credential dispatch', () => {
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
  it('keeps empty bindings final, avoids duplicate binding and leaves operator delegation unchanged', async () => {
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
    await withScopeEnvelope(envelope(), () =>
      withConfiguredTaskCredentials('WI-operator', async () => 'operator')
    );
    expect(bindTask).toHaveBeenCalledTimes(1);
  });
});
