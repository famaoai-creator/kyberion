/**
 * Real secure-io + tier-guard (no mocks): the service-preset cache's tenant
 * partition is protected by the cache floor's tenant_scope rule, so a process
 * bound to one tenant cannot write another tenant's cache entries.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContextAsync } from '../authority.js';
import {
  fetchWithServicePresetCache,
  servicePresetCachePartitionRoot,
} from './service-preset-cache.js';

const TENANT_A = 'spc-iso-tenant-a';
const TENANT_B = 'spc-iso-tenant-b';

const runScoped = <T>(tenant: string, run: () => Promise<T>): Promise<T> =>
  withExecutionContextAsync('sovereign_concierge', run, 'sovereign', tenant);

afterEach(async () => {
  for (const tenant of [TENANT_A, TENANT_B]) {
    await runScoped(tenant, async () =>
      safeRmSync(pathResolver.rootResolve(`active/shared/cache/confidential/${tenant}`), {
        recursive: true,
        force: true,
      })
    );
  }
});

describe('service-preset cache tenant partitions under tier-guard', () => {
  const scope = { tier: 'confidential' as const, tenant: TENANT_A, projectId: 'proj-a' };

  it('lets the bound tenant write its own partition', async () => {
    await runScoped(TENANT_A, () =>
      fetchWithServicePresetCache('web', 'read:k', () => ({ v: 1 }), { scope, ttlMs: 60_000 })
    );
    expect(
      safeExistsSync(
        pathResolver.rootResolve(servicePresetCachePartitionRoot('confidential', TENANT_A))
      )
    ).toBe(true);
  });

  it('denies a process bound to another tenant writing into that partition', async () => {
    await expect(
      runScoped(TENANT_B, () =>
        fetchWithServicePresetCache('web', 'read:k', () => ({ v: 1 }), { scope, ttlMs: 60_000 })
      )
    ).rejects.toThrow(/POLICY_VIOLATION.*tenant|tenant.*denied/i);
    expect(
      safeExistsSync(
        pathResolver.rootResolve(servicePresetCachePartitionRoot('confidential', TENANT_A))
      )
    ).toBe(false);
  });
});
