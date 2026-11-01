import * as path from 'node:path';
import { PARTITIONED_RUNTIME_STATE_ROOTS as FOUNDATION_STATE_ROOTS } from './foundation/runtime-state-roots.js';
import { describe, expect, it } from 'vitest';
import { rootDir } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  autonomyLearningCapability,
  isAutonomyLearningCapability,
} from './foundation/autonomy-learning-capability.js';
import {
  SYSTEM_PARTITION,
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
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
  STORAGE_DATA_TIERS,
  TENANT_RUNTIME_PARTITION_ROOTS,
  TENANT_STORE_LEDGER_ROOTS,
  tenantRuntimePartitionOf,
  tenantRuntimePartitionPaths,
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
    expect(PARTITIONED_RUNTIME_STATE_ROOTS.grants).toBe('active/shared/runtime/grants');
    expect(
      partitionedRuntimeStateKnowledgePath(
        'active/shared/runtime/grants/confidential/acme/GRT-20261019-aaaaaaaaaaaa.json'
      )
    ).toBe('knowledge/confidential/acme/GRT-20261019-aaaaaaaaaaaa.json');
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
      'active/shared/runtime/dot/personal/',
      'active/shared/runtime/dot/confidential/',
      'active/shared/runtime/pipeline-library-runs/personal/',
      'active/shared/runtime/pipeline-library-runs/confidential/',
      'active/shared/runtime/autonomy-learning/personal/',
      'active/shared/runtime/autonomy-learning/confidential/',
      'active/shared/runtime/external-operations/personal/',
      'active/shared/runtime/external-operations/confidential/',
      'active/shared/runtime/hearing/personal/',
      'active/shared/runtime/hearing/confidential/',
      'active/shared/runtime/discussion-create-requests/personal/',
      'active/shared/runtime/discussion-create-requests/confidential/',
      'active/shared/runtime/grants/personal/',
      'active/shared/runtime/grants/confidential/',
      'active/shared/runtime/customer-decision-invites/personal/',
      'active/shared/runtime/customer-decision-invites/confidential/',
      'active/shared/runtime/browser-bridge-mailbox/personal/',
      'active/shared/runtime/browser-bridge-mailbox/confidential/',
    ]);
    for (const prefix of protectedRuntimeStatePrefixes())
      expect(policy.tenant_scope.protected_prefixes).toContain(prefix);
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
    // Invite records: only the tenant-bound invite store role, only its own tenant.
    expect(policy.authority_role_permissions.customer_decision_invite_store).toEqual({
      allow_read: [
        'active/shared/runtime/customer-decision-invites/confidential/${KYBERION_TENANT}/',
      ],
      allow_write: [
        'active/shared/runtime/customer-decision-invites/confidential/${KYBERION_TENANT}/',
      ],
    });
    for (const [role, grant] of Object.entries(policy.authority_role_permissions))
      if (role !== 'customer_decision_invite_store')
        expect(JSON.stringify(grant)).not.toContain('runtime/customer-decision-invites');
    for (const field of ['default_allow', 'persona_permissions', 'authority_permissions'])
      expect(JSON.stringify(policy[field])).not.toContain('runtime/customer-decision-invites');
    // Credential allocation administration and dispatch metadata access reuse
    // the existing GrantStore. Both grants are confined to the selected tenant;
    // the dispatch reader cannot mutate approvals or allocation records.
    const allocationPartition = 'active/shared/runtime/grants/confidential/${KYBERION_TENANT}/';
    expect(policy.authority_role_permissions.credential_allocation_manager).toEqual({
      allow_read: [allocationPartition],
      allow_write: [allocationPartition],
    });
    expect(policy.authority_role_permissions.credential_allocation_reader).toEqual({
      allow_read: [allocationPartition],
    });
    for (const store of ['hearing', 'grants', 'autonomy-learning']) {
      expect(
        policy.tenant_scope.shared_prefixes.some((prefix: string) => prefix.includes(`/${store}/`))
      ).toBe(false);
      for (const field of ['default_allow', 'persona_permissions', 'authority_permissions']) {
        expect(JSON.stringify(policy[field])).not.toContain(`runtime/${store}`);
      }
      for (const [role, grant] of Object.entries(policy.authority_role_permissions)) {
        if (store === 'autonomy-learning' && role === 'autonomy_learning_store') continue;
        if (
          store === 'grants' &&
          ['credential_allocation_manager', 'credential_allocation_reader'].includes(role)
        )
          continue;
        expect(JSON.stringify(grant)).not.toContain(`runtime/${store}`);
      }
    }
    // The learning mediator has exact tenant file/directory policy grants;
    // its mandatory capability further limits directory grants to mkdir and
    // rejects the virtual knowledge aliases as actual data destinations.
    const runtime = 'active/shared/runtime/autonomy-learning';
    const tenantDirectory = runtime + '/confidential/${KYBERION_TENANT}';
    const exactGrant = [
      tenantDirectory,
      tenantDirectory + '/autonomy-outcomes.jsonl',
      'knowledge/confidential/${KYBERION_TENANT}/autonomy-outcomes.jsonl',
      tenantDirectory + '/autonomy-action-overrides.json',
      'knowledge/confidential/${KYBERION_TENANT}/autonomy-action-overrides.json',
      runtime,
      runtime + '/confidential',
      'knowledge/confidential/${KYBERION_TENANT}',
    ];
    expect(policy.authority_role_permissions.autonomy_learning_store).toEqual({
      allow_read: exactGrant,
      allow_write: exactGrant,
    });
    const capability = autonomyLearningCapability('tenant-a');
    const tenantRoot = runtime + '/confidential/tenant-a';
    expect(capability).toEqual({
      tenantSlug: 'tenant-a',
      readExact: [
        tenantRoot + '/autonomy-outcomes.jsonl',
        tenantRoot + '/autonomy-action-overrides.json',
      ],
      writeExact: [
        tenantRoot + '/autonomy-outcomes.jsonl',
        tenantRoot + '/autonomy-action-overrides.json',
      ],
      mkdirExact: [
        runtime,
        runtime + '/confidential',
        tenantRoot,
        tenantRoot + '/compaction-archive',
      ],
      // Write-time window retention: only the outcomes ledger's own rewrite
      // siblings and its sibling archive (one path component each).
      namePrefixExact: [
        tenantRoot + '/autonomy-outcomes.jsonl.compacting-',
        tenantRoot + '/autonomy-outcomes.jsonl.compact-out-',
        tenantRoot + '/autonomy-outcomes.jsonl.compact-restore-',
        tenantRoot + '/compaction-archive/',
      ],
    });
    expect(isAutonomyLearningCapability(capability)).toBe(true);
    expect(isAutonomyLearningCapability({ ...capability, writeExact: [tenantRoot] })).toBe(false);
    expect(
      isAutonomyLearningCapability({
        ...capability,
        namePrefixExact: [...(capability.namePrefixExact ?? []), tenantRoot + '/'],
      })
    ).toBe(false);
    expect(isAutonomyLearningCapability({ ...capability, tenantSlug: 'tenant-b' })).toBe(false);
  });
});

describe('tenant approval partitions', () => {
  it('registers the root as a partitioned ledger root (not state) with only its two store roles', () => {
    expect(PARTITIONED_RUNTIME_LEDGER_ROOTS.tenant_approvals).toBe(
      'active/shared/runtime/tenant-approvals'
    );
    expect(Object.values(PARTITIONED_RUNTIME_STATE_ROOTS)).not.toContain(
      'active/shared/runtime/tenant-approvals'
    );
    const policy = JSON.parse(
      safeReadFile(path.join(rootDir(), 'knowledge/product/governance/security-policy.json'), {
        encoding: 'utf8',
      }) as string
    );
    for (const tier of ['personal', 'confidential'])
      expect(policy.tenant_scope.protected_prefixes).toContain(
        `active/shared/runtime/tenant-approvals/${tier}/`
      );
    expect(
      policy.tenant_scope.shared_prefixes.some((prefix: string) =>
        prefix.includes('/tenant-approvals/')
      )
    ).toBe(false);
    for (const field of ['default_allow', 'persona_permissions', 'authority_permissions'])
      expect(JSON.stringify(policy[field])).not.toContain('runtime/tenant-approvals');
    const own = [
      'active/shared/runtime/tenant-approvals/personal/${KYBERION_TENANT}/',
      'active/shared/runtime/tenant-approvals/confidential/${KYBERION_TENANT}/',
    ];
    expect(policy.authority_role_permissions.tenant_approval_store).toEqual({
      allow_read: own,
      allow_write: own,
    });
    const tiers = [
      'active/shared/runtime/tenant-approvals/personal/',
      'active/shared/runtime/tenant-approvals/confidential/',
    ];
    expect(policy.authority_role_permissions.tenant_approval_partition_index_reader).toEqual({
      allow_read: tiers,
      deny_read_descendants: tiers,
      allow_write: [],
    });
    for (const [role, grant] of Object.entries(policy.authority_role_permissions))
      if (role !== 'tenant_approval_store' && role !== 'tenant_approval_partition_index_reader')
        expect(JSON.stringify(grant)).not.toContain('runtime/tenant-approvals');
  });
});

describe('tenant runtime partitions', () => {
  it('enumerates every key of both partition registries exactly once', () => {
    const keys = TENANT_RUNTIME_PARTITION_ROOTS.map((entry) => entry.key).sort();
    expect(keys).toEqual(
      [
        ...Object.keys(PARTITIONED_RUNTIME_LEDGER_ROOTS),
        ...Object.keys(PARTITIONED_RUNTIME_STATE_ROOTS),
      ].sort()
    );
    for (const entry of TENANT_RUNTIME_PARTITION_ROOTS) {
      const ledger = Object.hasOwn(PARTITIONED_RUNTIME_LEDGER_ROOTS, entry.key);
      expect(entry.family).toBe(ledger ? 'ledger' : 'state');
      expect(entry.appendOnly).toBe(ledger);
      expect(entry.hashChained).toBe(entry.key === 'tenant_ledger');
      const store = Object.values(TENANT_STORE_LEDGER_ROOTS).find((s) => s.root === entry.root);
      expect(entry.storeRole).toBe(store?.storeRole);
    }
  });

  it('lists one partition per tier and root, filtered by the exists probe', () => {
    const all = tenantRuntimePartitionPaths('acme');
    expect(all).toHaveLength(TENANT_RUNTIME_PARTITION_ROOTS.length * STORAGE_DATA_TIERS.length);
    expect(all.map((p) => p.path)).toContain(
      'active/shared/runtime/tenant-ledger/confidential/acme'
    );
    const present = new Set(['active/shared/runtime/grants/personal/acme']);
    expect(tenantRuntimePartitionPaths('acme', (p) => present.has(p))).toEqual([
      expect.objectContaining({ key: 'grants', tier: 'personal', tenant: 'acme' }),
    ]);
  });

  it('rejects invalid and reserved tenant slugs', () => {
    for (const bad of ['shared', 'system', 'public', 'confidential', 'Acme', '../x', 'a', ''])
      expect(() => tenantRuntimePartitionPaths(bad)).toThrow(/STORAGE_LAYOUT_TENANT_INVALID/);
  });

  it('never reports system/ or <tier>/shared as a tenant and round-trips real partitions', () => {
    for (const entry of TENANT_RUNTIME_PARTITION_ROOTS) {
      expect(tenantRuntimePartitionOf(`${entry.root}/system/x.jsonl`)).toBeUndefined();
      expect(tenantRuntimePartitionOf(`${entry.root}/confidential/shared/x`)).toBeUndefined();
      expect(tenantRuntimePartitionOf(`${entry.root}/confidential/system/x`)).toBeUndefined();
      expect(tenantRuntimePartitionOf(`${entry.root}/confidential`)).toBeUndefined();
    }
    for (const partition of tenantRuntimePartitionPaths('acme')) {
      const expected = {
        key: partition.key,
        root: partition.root,
        tier: partition.tier,
        tenant: 'acme',
      };
      expect(tenantRuntimePartitionOf(partition.path)).toEqual(expected);
      expect(tenantRuntimePartitionOf(path.join(rootDir(), partition.path, 'f.jsonl'))).toEqual(
        expected
      );
    }
    expect(tenantRuntimePartitionOf('active/shared/runtime/unregistered/confidential/acme')).toBe(
      undefined
    );
  });
});
