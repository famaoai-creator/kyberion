import * as path from 'node:path';
import { PARTITIONED_RUNTIME_STATE_ROOTS as FOUNDATION_STATE_ROOTS } from './foundation/runtime-state-roots.js';
import { describe, expect, it } from 'vitest';
import { rootDir } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  SYSTEM_PARTITION,
  PARTITIONED_RUNTIME_STATE_ROOTS,
  partitionedRuntimeStateKnowledgePath,
  partitionedRuntimeStateTierInPath,
  protectedRuntimeStatePrefixes,
  classifyStorageFloorPath,
  protectedStorageFloorPrefixes,
  resolveStorageFloor,
  storageFloorRelativePath,
  storageFloorTier,
  storageFloorTierInPath,
} from './storage-layout.js';

describe('storage-layout floors', () => {
  it('re-exports the single foundation state-root registry used by secure I/O', () => {
    expect(PARTITIONED_RUNTIME_STATE_ROOTS).toBe(FOUNDATION_STATE_ROOTS);
  });

  it('places platform-wide data under the system partition', () => {
    expect(storageFloorRelativePath('cache', SYSTEM_PARTITION, 'voice', 'whisper.cpp')).toBe(
      'active/shared/cache/system/voice/whisper.cpp'
    );
    expect(resolveStorageFloor('scratch', SYSTEM_PARTITION, 'ocr', 'job-1')).toBe(
      path.join(rootDir(), 'active/shared/tmp/system/ocr/job-1')
    );
  });

  it('places data-bearing content under <tier>/<tenant|shared>', () => {
    expect(
      storageFloorRelativePath(
        'staging',
        { kind: 'tier', tier: 'confidential', tenant: 'acme' },
        'ingest',
        'job-7/contract.pdf'
      )
    ).toBe('active/shared/staging/confidential/acme/ingest/job-7/contract.pdf');
    expect(storageFloorRelativePath('artifact', { kind: 'tier', tier: 'public' }, 'reports')).toBe(
      'active/shared/artifacts/public/shared/reports'
    );
  });

  it('rejects reserved or malformed tenants and traversal segments', () => {
    const tier = (tenant: string) => ({
      kind: 'tier' as const,
      tier: 'confidential' as const,
      tenant,
    });
    expect(() => storageFloorRelativePath('cache', tier('shared'), 'x')).toThrow(/TENANT_INVALID/);
    expect(() => storageFloorRelativePath('cache', tier('public'), 'x')).toThrow(/TENANT_INVALID/);
    expect(() => storageFloorRelativePath('cache', tier('../acme'), 'x')).toThrow(/TENANT_INVALID/);
    expect(() => storageFloorRelativePath('cache', SYSTEM_PARTITION, '..')).toThrow(/SEGMENT/);
    expect(() => storageFloorRelativePath('cache', SYSTEM_PARTITION, 'd', 'a/../b')).toThrow(
      /SEGMENT/
    );
    expect(() =>
      storageFloorRelativePath(
        'cache',
        { kind: 'tier', tier: 'secret' as unknown as 'public' },
        'd'
      )
    ).toThrow(/TIER_INVALID/);
  });

  it('classifies floor paths, including legacy unpartitioned ones', () => {
    expect(classifyStorageFloorPath('active/shared/tmp/system/ocr/a.png')).toEqual({
      floor: 'scratch',
      partition: SYSTEM_PARTITION,
    });
    expect(
      classifyStorageFloorPath(path.join(rootDir(), 'active/shared/cache/personal/acme/x'))
    ).toEqual({
      floor: 'cache',
      partition: { kind: 'tier', tier: 'personal', tenant: 'acme' },
    });
    expect(classifyStorageFloorPath('active/shared/artifacts/public/shared/r.md')).toEqual({
      floor: 'artifact',
      partition: { kind: 'tier', tier: 'public', tenant: undefined },
    });
    expect(classifyStorageFloorPath('active/shared/tmp/voice-out/a.wav')).toEqual({
      floor: 'scratch',
      partition: { kind: 'legacy' },
    });
    expect(classifyStorageFloorPath('active/shared/runtime/x')).toBeNull();
    expect(classifyStorageFloorPath('active/shared/tmpfoo/x')).toBeNull();
  });

  it('finds a floor tier anywhere in a path, independent of the project root', () => {
    expect(storageFloorTierInPath('/elsewhere/checkout/active/shared/cache/confidential/a/x')).toBe(
      'confidential'
    );
    expect(storageFloorTierInPath('C:\\repo\\active\\shared\\tmp\\personal\\shared\\x')).toBe(
      'personal'
    );
    expect(storageFloorTierInPath('/repo/active/shared/tmp/system/x')).toBeUndefined();
    expect(storageFloorTierInPath('/repo/active/shared/tmp/confidential-notes/x')).toBeUndefined();
  });

  it('reports the tier of tier partitions only', () => {
    expect(storageFloorTier('active/shared/staging/confidential/acme/a')).toBe('confidential');
    expect(storageFloorTier('active/shared/staging/system/a')).toBeUndefined();
    expect(storageFloorTier('active/shared/tmp/foo')).toBeUndefined();
  });

  it('lists personal and confidential prefixes for every floor', () => {
    expect(protectedStorageFloorPrefixes()).toEqual([
      'active/shared/tmp/personal/',
      'active/shared/tmp/confidential/',
      'active/shared/staging/personal/',
      'active/shared/staging/confidential/',
      'active/shared/cache/personal/',
      'active/shared/cache/confidential/',
      'active/shared/artifacts/personal/',
      'active/shared/artifacts/confidential/',
    ]);
  });

  it('keeps security-policy tenant_scope.protected_prefixes in sync with the floors', () => {
    const policy = JSON.parse(
      safeReadFile(path.join(rootDir(), 'knowledge/product/governance/security-policy.json'), {
        encoding: 'utf8',
      }) as string
    ) as { default_allow: string[]; tenant_scope: { protected_prefixes: string[] } };
    for (const prefix of protectedStorageFloorPrefixes()) {
      expect(policy.tenant_scope.protected_prefixes).toContain(prefix);
    }
    for (const root of ['tmp', 'staging', 'cache', 'artifacts']) {
      expect(policy.default_allow).toContain(`active/shared/${root}/`);
    }
  });
});

describe('durable partitioned runtime state', () => {
  it('registers hearing independently of metrics-ledger lifecycle', () => {
    expect(PARTITIONED_RUNTIME_STATE_ROOTS.hearing).toBe('active/shared/runtime/hearing');
    expect(
      partitionedRuntimeStateKnowledgePath(
        'active/shared/runtime/hearing/personal/shared/all/a.json'
      )
    ).toBe('knowledge/personal/shared/all/a.json');
    expect(
      partitionedRuntimeStateKnowledgePath(
        'active/shared/runtime/hearing/confidential/acme/tenant/a.json'
      )
    ).toBe('knowledge/confidential/acme/tenant/a.json');
    expect(
      partitionedRuntimeStateKnowledgePath(
        'active/shared/runtime/hearing-else/personal/shared/a.json'
      )
    ).toBeUndefined();
    expect(
      partitionedRuntimeStateKnowledgePath(
        'active/shared/runtime/usage-ledger/personal/shared/a.json'
      )
    ).toBeUndefined();
  });

  it('recognizes state tiers across roots and separators without matching adjacent names', () => {
    expect(
      partitionedRuntimeStateTierInPath(
        '/other/root/active/shared/runtime/hearing/personal/shared/a'
      )
    ).toBe('personal');
    expect(
      partitionedRuntimeStateTierInPath(
        'C:\\repo\\active\\shared\\runtime\\hearing\\confidential\\acme\\a'
      )
    ).toBe('confidential');
    expect(partitionedRuntimeStateTierInPath('active/shared/runtime/hearing/personal')).toBe(
      'personal'
    );
    expect(
      partitionedRuntimeStateTierInPath('active/shared/runtime/hearing/personal-notes/a')
    ).toBeUndefined();
    expect(
      partitionedRuntimeStateTierInPath('active/shared/runtime/hearing-else/personal/a')
    ).toBeUndefined();
  });

  it('registers protected state partitions with only the dedicated receipt grant and no shared exemptions', () => {
    const policy = JSON.parse(
      safeReadFile(path.join(rootDir(), 'knowledge/product/governance/security-policy.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(protectedRuntimeStatePrefixes()).toEqual([
      'active/shared/runtime/hearing/personal/',
      'active/shared/runtime/hearing/confidential/',
      'active/shared/runtime/discussion-create-requests/personal/',
      'active/shared/runtime/discussion-create-requests/confidential/',
    ]);
    for (const prefix of protectedRuntimeStatePrefixes())
      expect(policy.tenant_scope.protected_prefixes).toContain(prefix);
    expect(
      policy.tenant_scope.shared_prefixes.some((prefix: string) => prefix.includes('/hearing/'))
    ).toBe(false);
    expect(
      policy.tenant_scope.shared_prefixes.some((prefix: string) =>
        prefix.includes('/discussion-create-requests/')
      )
    ).toBe(false);
    for (const field of ['default_allow', 'persona_permissions', 'authority_permissions'])
      expect(JSON.stringify(policy[field])).not.toContain('runtime/discussion-create-requests');
    const receiptGrant = policy.authority_role_permissions.discussion_request_store;
    expect(receiptGrant).toEqual({
      allow_read: [
        'active/shared/runtime/discussion-create-requests/confidential/${KYBERION_TENANT}/',
      ],
      allow_write: [
        'active/shared/runtime/discussion-create-requests/confidential/${KYBERION_TENANT}/',
      ],
    });
    for (const [role, grant] of Object.entries(policy.authority_role_permissions))
      if (role !== 'discussion_request_store')
        expect(JSON.stringify(grant)).not.toContain('runtime/discussion-create-requests');
    for (const field of [
      'default_allow',
      'persona_permissions',
      'authority_permissions',
      'authority_role_permissions',
    ]) {
      expect(JSON.stringify(policy[field])).not.toContain('runtime/hearing');
    }
  });
});
