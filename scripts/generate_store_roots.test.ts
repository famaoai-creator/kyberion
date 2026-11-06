import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/authority';
import { safeWriteFile, safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { clearProcessExitCode, getProcessExitCode } from './lib/harness.js';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveAssetAddress } from '@agent/core/foundation/asset-address';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  STORAGE_FLOOR_ROOTS,
} from '@agent/core/storage-layout';
import { projectStoreRoots, type StoreRootSource } from './lib/store-root-projection.js';
import {
  createStoreRootsGenerator,
  assertCanonicalStoreRootAliases,
  buildStoreRootsBlock,
  projectStoreRootSource,
  spliceStoreRootsBlock,
  STORE_ROOTS_BEGIN,
  STORE_ROOTS_END,
  STORE_ROOTS_OUTPUT,
} from './generate_store_roots.js';
import { GENERATED_ARTIFACT_STEPS } from './resolve_generated.js';

const store = (key: string, order: number): StoreRootSource => ({
  id: key,
  path: `active/shared/runtime/${key}/<tier>/<tenant>`,
  status: 'active',
  custody: { kind: 'tenant' },
  registration: { family: 'state', key, order, retention_path: `active/shared/runtime/${key}` },
});
const policies = [
  { path: 'active/shared/runtime/first' },
  { path: 'active/shared/runtime/second' },
];
const frame = `// before\n${STORE_ROOTS_BEGIN}\nold\n${STORE_ROOTS_END}\n// after\n`;

describe('catalog root projection', () => {
  it('attributes S3 deals to the tenant while keeping customer grouping planned and legacy paths physical', () => {
    const catalog = JSON.parse(
      readTextFile(pathResolver.rootResolve('knowledge/product/governance/store-catalog.json'))
    );
    expect(
      resolveAssetAddress('knowledge/confidential/acme/deals/DEAL-1.json', catalog.stores)
    ).toMatchObject({
      status: 'resolved',
      address: {
        store: 'tenant-deals',
        location: 'active',
        custody: { kind: 'tenant', ref: 'acme' },
        tier: 'confidential',
      },
    });
    expect(
      resolveAssetAddress(
        'knowledge/confidential/acme/customers/client-1/deals/DEAL-1.json',
        catalog.stores
      )
    ).toMatchObject({
      status: 'resolved',
      address: { store: 'tenant-customer-records', location: 'planned' },
    });
    expect(
      resolveAssetAddress('customer/acme/deals/DEAL-1.json', catalog.stores)
    ).not.toMatchObject({
      status: 'resolved',
      address: { store: 'tenant-deals', location: 'active' },
    });
  });
  it('registers the existing mixed system/person attestation root without tenant inference', () => {
    const root = 'active/shared/runtime/provider-attestations';
    const provider: StoreRootSource = {
      id: 'runtime.provider-attestations',
      path: root,
      custody: { kind: 'derived' },
      status: 'active',
      registration: {
        family: 'state',
        key: 'provider_attestations',
        order: 15,
        partition_shape: 'system_person',
        retention_path: root,
      },
    };
    const project = (entry: StoreRootSource) => projectStoreRoots([entry], [{ path: root }]);
    expect(project(provider)).toEqual({
      roots: { state: { provider_attestations: root }, ledger: {}, floor: {} },
      violations: [],
    });
    for (const changed of [
      { ...provider, custody: { kind: 'tenant' as const } },
      { ...provider, registration: { ...provider.registration!, family: 'ledger' as const } },
      { ...provider, path: root + '/<tier>/<tenant>' },
      { ...provider, path: root + '/confidential/<tenant>', tiers: ['confidential'] },
      { ...provider, tiers: ['personal'] },
    ])
      expect(project(changed).violations.join('\n')).toContain(
        'system_person shape requires a derived state store'
      );
    expect(project({ ...provider, path: root + '-other' }).violations.join('\n')).toContain(
      'does not cover root'
    );
    expect(
      project({ ...provider, registration: { ...provider.registration!, key: 'another_store' } })
        .violations
    ).toEqual([]);
    const { partition_shape: _shape, ...unshapedRegistration } = provider.registration!;
    expect(
      project({ ...provider, registration: unshapedRegistration }).violations.join('\n')
    ).toContain('requires a canonical root with tier/tenant binding');
    const catalog = JSON.parse(
      readTextFile(pathResolver.rootResolve('knowledge/product/governance/store-catalog.json'))
    );
    const actual = catalog.stores.find((entry: StoreRootSource) => entry.id === provider.id);
    expect(actual).toMatchObject(provider);
    expect(actual).not.toHaveProperty('tiers');
    for (const file of ['system/attestations.json', 'personal/shared/owner.json']) {
      expect(resolveAssetAddress(`${root}/${file}`, catalog.stores)).toMatchObject({
        status: 'unresolved',
        reason: 'custody_unresolved',
      });
    }
  });
  it('registers the confidential delegation store as a ledger root without inventing legacy custody', () => {
    const catalog = JSON.parse(
      readTextFile(pathResolver.rootResolve('knowledge/product/governance/store-catalog.json'))
    );
    const delegation = catalog.stores.find(
      (entry: StoreRootSource) => entry.id === 'runtime.delegations'
    );
    expect(delegation).toMatchObject({
      path: 'active/shared/runtime/delegation-records/confidential/<tenant>',
      custody: { kind: 'tenant', ref: '<tenant>' },
      tiers: ['confidential'],
      status: 'active',
      legacy_roles: ['delegation_record_store'],
      registration: {
        family: 'ledger',
        key: 'delegations',
        order: 6,
        retention_path: 'active/shared/runtime/delegation-records',
      },
    });
    const projected = projectStoreRoots(
      [delegation],
      [{ path: 'active/shared/runtime/delegation-records' }]
    );
    expect(projected.violations).toEqual([]);
    expect(projected.roots.ledger).toEqual({
      delegations: 'active/shared/runtime/delegation-records',
    });
    expect(projected.roots.state).toEqual({});
  });
  it('orders by explicit registration order independently of catalog order', () => {
    const projection = projectStoreRoots([store('second', 2), store('first', 1)], policies);
    expect(projection.violations).toEqual([]);
    expect(Object.keys(projection.roots.state)).toEqual(['first', 'second']);
    expect(buildStoreRootsBlock(projection.roots)).toBe(
      buildStoreRootsBlock(
        projectStoreRoots([store('first', 1), store('second', 2)], policies).roots
      )
    );
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])('rejects unsafe order %s', (order) => {
    expect(projectStoreRoots([store('first', order)], policies).violations.join('\n')).toContain(
      'positive safe-integer order'
    );
  });
  it('rejects duplicated orders and invalid data before constructing output', () => {
    expect(
      projectStoreRoots([store('first', 1), store('second', 1)], policies).violations.join('\n')
    ).toContain('duplicate registration order state:1');
    expect(() => projectStoreRootSource(frame, [store('first', 0)], policies)).toThrow(
      'positive safe-integer'
    );
  });
  it('preserves current values and insertion order across all public root maps', () => {
    const catalog = JSON.parse(
      readTextFile(pathResolver.rootResolve('knowledge/product/governance/store-catalog.json'))
    );
    const retention = JSON.parse(
      readTextFile(
        pathResolver.rootResolve('knowledge/product/governance/storage-retention-catalog.json')
      )
    );
    const projected = projectStoreRoots(catalog.stores, retention.entries);
    expect(projected.violations).toEqual([]);
    for (const [family, roots] of Object.entries({
      state: PARTITIONED_RUNTIME_STATE_ROOTS,
      ledger: PARTITIONED_RUNTIME_LEDGER_ROOTS,
      floor: STORAGE_FLOOR_ROOTS,
    })) {
      expect(Object.entries(projected.roots[family as keyof typeof projected.roots])).toEqual(
        Object.entries(roots)
      );
    }
  });
});

describe('bounded source generation', () => {
  const roots = projectStoreRoots([store('first', 1)], policies).roots;
  it('preserves surrounding bytes and reaches an exact fixed point', () => {
    const output = spliceStoreRootsBlock(frame, roots);
    expect(output.startsWith('// before\n')).toBe(true);
    expect(output.endsWith('\n// after\n')).toBe(true);
    expect(spliceStoreRootsBlock(output, roots)).toBe(output);
  });
  it.each([
    '',
    `${STORE_ROOTS_BEGIN}\n`,
    `${STORE_ROOTS_END}\n${STORE_ROOTS_BEGIN}\n`,
    `${frame}${STORE_ROOTS_BEGIN}\n`,
    `${frame}${STORE_ROOTS_END}\n`,
    `prefix${frame}`.replace('// before\n', ''),
  ])('refuses invalid markers %s', (source) => {
    expect(() => spliceStoreRootsBlock(source, roots)).toThrow();
  });
  it('--check reports fixture drift without writing or touching production source', async () => {
    const productionPath = pathResolver.rootResolve(STORE_ROOTS_OUTPUT);
    const productionBefore = readTextFile(productionPath);
    const fixtureRoot = pathResolver.rootResolve(
      `active/shared/tmp/store-roots-test-${randomUUID()}`
    );
    const output = `${fixtureRoot}/runtime-state-roots.ts`;
    const expected = projectStoreRootSource(frame, [store('first', 1)], policies);
    const drifted = expected.replace(
      "first: 'active/shared/runtime/first'",
      "first: 'active/shared/runtime/drift'"
    );
    const fixtureGenerator = createStoreRootsGenerator(output, () => ({
      stores: [store('first', 1)],
      retention: policies,
    }));
    try {
      withExecutionContext('ecosystem_architect', () => {
        safeMkdir(fixtureRoot, { recursive: true });
        safeWriteFile(output, drifted);
      });
      clearProcessExitCode();
      await fixtureGenerator(['--check', '--quiet']);
      expect(getProcessExitCode()).toBe(1);
      expect(readTextFile(output)).toBe(drifted);
      expect(readTextFile(productionPath)).toBe(productionBefore);
      withExecutionContext('ecosystem_architect', () => safeWriteFile(output, expected));
      clearProcessExitCode();
      await fixtureGenerator(['--check', '--quiet']);
      expect(getProcessExitCode()).toBeUndefined();
      expect(readTextFile(output)).toBe(expected);
      expect(readTextFile(productionPath)).toBe(productionBefore);
    } finally {
      withExecutionContext('ecosystem_architect', () =>
        safeRmSync(fixtureRoot, { recursive: true, force: true })
      );
      clearProcessExitCode();
    }
  });
  it.each(['tenant_ledger', 'tenant_approvals', 'tenant_audit_mirror', 'delegations'])(
    'refuses omitted mandatory alias %s before fixture writes',
    async (missing) => {
      const fixtureRoot = pathResolver.rootResolve(
        `active/shared/tmp/store-roots-required-${randomUUID()}`
      );
      const output = `${fixtureRoot}/runtime-state-roots.ts`;
      const productionPath = pathResolver.rootResolve(STORE_ROOTS_OUTPUT);
      const productionBefore = readTextFile(productionPath);
      const stores: StoreRootSource[] = [
        'tenant_ledger',
        'tenant_approvals',
        'tenant_audit_mirror',
        'delegations',
      ]
        .filter((key) => key !== missing)
        .map((key, index) => ({
          ...store(key, index + 1),
          registration: {
            family: 'ledger',
            key,
            order: index + 1,
            retention_path: `active/shared/runtime/${key}`,
          },
        }));
      const retention = stores.map((entry) => ({ path: entry.registration!.retention_path }));
      // Partial fixtures remain valid for the generic projection.
      expect(projectStoreRoots(stores, retention).violations).toEqual([]);
      expect(() =>
        assertCanonicalStoreRootAliases(projectStoreRoots(stores, retention).roots)
      ).toThrow(`ledger:${missing}`);
      const generator = createStoreRootsGenerator(
        output,
        () => ({ stores, retention }),
        assertCanonicalStoreRootAliases
      );
      try {
        withExecutionContext('ecosystem_architect', () => {
          safeMkdir(fixtureRoot, { recursive: true });
          safeWriteFile(output, frame);
        });
        clearProcessExitCode();
        await generator(['--quiet']);
        expect(getProcessExitCode()).toBe(1);
        expect(readTextFile(output)).toBe(frame);
        expect(readTextFile(productionPath)).toBe(productionBefore);
      } finally {
        withExecutionContext('ecosystem_architect', () =>
          safeRmSync(fixtureRoot, { recursive: true, force: true })
        );
        clearProcessExitCode();
      }
    }
  );
  it('registers only the mixed-source output and does not request a whole-file merge driver', () => {
    expect(GENERATED_ARTIFACT_STEPS.find((step) => step.id === 'store-roots')).toMatchObject({
      script: 'scripts/generate_store_roots.ts',
      tracked: [STORE_ROOTS_OUTPUT],
    });
    expect(
      GENERATED_ARTIFACT_STEPS.find((step) => step.id === 'store-roots')?.mergeDriver
    ).toBeUndefined();
  });
});
