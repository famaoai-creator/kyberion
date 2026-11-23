/**
 * Real secure-io + tier-guard (no I/O mocks): the service-preset cache's tenant
 * partition is protected by the cache floor's tenant_scope rule, so a process
 * bound to one tenant cannot write another tenant's cache entries.
 *
 * Hermetic: the governance policy and schemas are copied into a fresh
 * KYBERION_ROOT under active/shared/tmp (pattern: hearing-storage-boundary.test.ts),
 * so the cache partitions are created there, never in the live checkout.
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as sourceContext } from '../authority.js';
import { rootDir } from '../path-resolver.js';
import * as sourceIO from '../secure-io.js';

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, `active/shared/tmp/service-preset-cache-guard-${process.pid}`);
const TENANT_A = `spc-a-${process.pid}`;
const TENANT_B = `spc-b-${process.pid}`;
const savedRoot = process.env.KYBERION_ROOT;

let cache: typeof import('./service-preset-cache.js');
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');

beforeAll(async () => {
  sourceContext('ecosystem_architect', () => {
    sourceIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"spc-guard-fixture"}');
    const copy = (relative: string): void => {
      for (const name of sourceIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = sourceIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name)) {
          const target = path.join(ROOT, file);
          sourceIO.safeMkdir(path.dirname(target), { recursive: true });
          sourceIO.safeCopyFileSync(source, target);
        }
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  cache = await import('./service-preset-cache.js');
  expect((await import('../path-resolver.js')).rootDir()).toBe(ROOT);
}, 60_000);

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  sourceContext('ecosystem_architect', () =>
    sourceIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
});

const runScoped = <T>(tenant: string, run: () => Promise<T>): Promise<T> =>
  authority.withExecutionContextAsync('sovereign_concierge', run, 'sovereign', tenant);

describe('service-preset cache tenant partitions under tier-guard', () => {
  const scope = () => ({ tier: 'confidential' as const, tenant: TENANT_A, projectId: 'proj-a' });
  const partition = () =>
    path.join(ROOT, cache.servicePresetCachePartitionRoot('confidential', TENANT_A));

  it('denies a process bound to another tenant writing into that partition', async () => {
    await expect(
      runScoped(TENANT_B, () =>
        cache.fetchWithServicePresetCache('web', 'read:k', () => ({ v: 1 }), {
          scope: scope(),
          ttlMs: 60_000,
        })
      )
    ).rejects.toThrow(/POLICY_VIOLATION.*tenant|tenant.*denied/i);
    expect(sourceIO.safeExistsSync(partition())).toBe(false);
  });

  it('lets the bound tenant write its own partition', async () => {
    await runScoped(TENANT_A, () =>
      cache.fetchWithServicePresetCache('web', 'read:k', () => ({ v: 1 }), {
        scope: scope(),
        ttlMs: 60_000,
      })
    );
    expect(io.safeExistsSync(partition())).toBe(true);
  });
});
