import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '../authority.js';
import { rootDir } from '../path-resolver.js';
import * as initialIO from '../secure-io.js';

/**
 * The per-tenant approval partitions against the real secure-io tier and
 * tenant boundaries. A fresh KYBERION_ROOT keeps the live logical layout
 * (`active/shared/runtime/tenant-approvals/...`): the ordinary Vitest store
 * remap would place the bytes outside the protected prefixes.
 */
const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/tenant-approval-boundary-' + process.pid);
let withExecutionContext = initialContext;
let { safeExistsSync, safeReadFile, safeReaddir, safeRmSync, safeWriteFile } = initialIO;
let retention: typeof import('../storage-retention-catalog.js');
let store: typeof import('./approval-store.js');
const savedRoot = process.env.KYBERION_ROOT;

const STORE = 'active/shared/runtime/tenant-approvals';
const TENANT = 'apboundary-' + process.pid;
const OTHER = 'apother-' + process.pid;
const CHANNEL = 'boundary-probe';
const recordFile = (tenant: string, tier = 'confidential') =>
  path.join(
    ROOT,
    STORE,
    tier,
    tenant,
    CHANNEL,
    'requests/00000000-0000-4000-8000-000000000001.json'
  );

const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const privileged = <T>(fn: () => T) => withExecutionContext('ecosystem_architect', fn);
const asStore = <T>(fn: () => T, tenant: string) =>
  withExecutionContext('tenant_approval_store', fn, undefined, tenant);
const asCaller = <T>(role: string, fn: () => T, tenant?: string) =>
  withExecutionContext(role, fn, undefined, tenant);

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"approval-policy-fixture"}');
    // `deep` = also copy subdirectories (governance subcatalogs are not needed
    // here, except the authority role files the policy loaders read).
    const copy = (relative: string, deep = true): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) {
          if (deep) copy(file);
        } else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance', false);
    copy('knowledge/product/governance/authority-roles');
    copy('knowledge/product/schemas');
    // createApprovalRequest resolves the specialist catalog for its work-loop summary.
    initialIO.safeWriteFile(
      path.join(ROOT, 'knowledge/product/orchestration/specialist-catalog.json'),
      initialIO.safeReadFile(
        path.join(SOURCE_ROOT, 'knowledge/product/orchestration/specialist-catalog.json')
      )
    );
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  ({ safeExistsSync, safeReadFile, safeReaddir, safeRmSync, safeWriteFile } =
    await import('../secure-io.js'));
  ({ withExecutionContext } = await import('../authority.js'));
  retention = await import('../storage-retention-catalog.js');
  store = await import('./approval-store.js');
  expect((await import('../path-resolver.js')).rootDir()).toBe(ROOT);
}, 120_000);

function cleanup(): void {
  privileged(() => {
    for (const tier of ['personal', 'confidential'])
      for (const tenant of [TENANT, OTHER])
        safeRmSync(path.join(ROOT, STORE, tier, tenant), { recursive: true, force: true });
    // System-tree records of a fixture root keep the per-run Vitest store root.
    safeRmSync(path.join(ROOT, 'active/shared/runtime/vitest-approvals'), {
      recursive: true,
      force: true,
    });
  });
}

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  cleanup();
  privileged(() => {
    safeWriteFile(recordFile(TENANT), 'own tenant approval');
    safeWriteFile(recordFile(OTHER), 'other tenant approval');
  });
});

afterAll(() => {
  cleanup();
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('tenant approval partitions use real secure-io tier and tenant boundaries', () => {
  it('lets the store role bound to a tenant read and write only that tenant partition', () =>
    asStore(() => {
      expect(safeReadFile(recordFile(TENANT), { encoding: 'utf8' })).toBe('own tenant approval');
      safeWriteFile(recordFile(TENANT, 'personal'), 'personal approval');
      expect(() => safeReadFile(recordFile(OTHER), { encoding: 'utf8' })).toThrow(
        /tenant.scope_violation/
      );
      expect(() => safeWriteFile(recordFile(OTHER), 'replace')).toThrow(/tenant.scope_violation/);
    }, TENANT));

  it('refuses to bind the store role to a tenant other than the caller active tenant', () => {
    expect(() =>
      asCaller('mission_controller', () => asStore(() => undefined, OTHER), TENANT)
    ).toThrow(/ROLE_TENANT_SCOPE_MISMATCH/);
    expect(() => withExecutionContext('tenant_approval_store', () => undefined)).toThrow(
      /ROLE_TENANT_SCOPE_REQUIRED/
    );
  });

  it('denies a caller without the store role reads of a tenant record, and a foreign-bound caller writes', () => {
    asCaller('slack_bridge', () => {
      expect(() => safeReadFile(recordFile(TENANT), { encoding: 'utf8' })).toThrow(
        /SECURITY|POLICY|tenant\.|Higher tier required/
      );
    });
    asCaller(
      'slack_bridge',
      () => {
        expect(() => safeReadFile(recordFile(TENANT), { encoding: 'utf8' })).toThrow(
          /tenant\.scope_violation/
        );
        expect(() => safeWriteFile(recordFile(TENANT), 'replace')).toThrow(
          /tenant\.scope_violation/
        );
      },
      OTHER
    );
    privileged(() =>
      expect(safeReadFile(recordFile(TENANT), { encoding: 'utf8' })).toBe('own tenant approval')
    );
  });

  it('lets the index reader list tenant directory names but never read a record', () =>
    withExecutionContext(
      'tenant_approval_partition_index_reader',
      () => {
        expect(safeReaddir(path.join(ROOT, STORE, 'confidential'))).toEqual(
          expect.arrayContaining([TENANT, OTHER])
        );
        expect(() => safeReadFile(recordFile(TENANT), { encoding: 'utf8' })).toThrow(
          /SECURITY|POLICY|tenant\.|denied/i
        );
      },
      'worker'
    ));

  it('places a tenant-scoped approval in the protected partition and hides it from another tenant', () => {
    privileged(() => {
      safeRmSync(recordFile(TENANT), { force: true });
      safeRmSync(recordFile(OTHER), { force: true });
    });
    const record = store.createApprovalRequest('mission_controller', {
      channel: CHANNEL,
      threadTs: '1',
      correlationId: 'tenant-approval-boundary',
      requestedBy: 'tenant-approval-boundary-test',
      draft: { title: 'boundary', summary: 'tenant approval boundary probe' },
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT },
    });
    const file = path.join(
      ROOT,
      STORE,
      'confidential',
      TENANT,
      CHANNEL,
      'requests',
      `${record.id}.json`
    );
    privileged(() =>
      expect(JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }))).id).toBe(record.id)
    );
    privileged(() =>
      expect(
        safeExistsSync(path.join(ROOT, store.approvalRequestLogicalPath(CHANNEL, record.id)))
      ).toBe(false)
    );
    // Unbound: found through the index reader and the tenant-bound store role.
    expect(store.loadApprovalRequest(CHANNEL, record.id)?.id).toBe(record.id);
    expect(store.listApprovalRequests({ storageChannels: [CHANNEL] }).map((r) => r.id)).toEqual([
      record.id,
    ]);
    // Bound to another tenant: never found, never decided.
    asCaller(
      'mission_controller',
      () => {
        expect(store.loadApprovalRequest(CHANNEL, record.id)).toBeNull();
        expect(store.listApprovalRequests({ storageChannels: [CHANNEL] })).toEqual([]);
        expect(() =>
          store.decideApprovalRequest('mission_controller', {
            channel: CHANNEL,
            requestId: record.id,
            decision: 'approved',
            decidedBy: 'operator',
          })
        ).toThrow(/not found/);
      },
      OTHER
    );
    const decided = store.decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'rejected',
      decidedBy: 'operator',
    });
    expect(decided.status).toBe('rejected');
    const log = path.join(ROOT, STORE, 'confidential', TENANT, CHANNEL, 'approvals.jsonl');
    asStore(
      () =>
        expect(
          String(safeReadFile(log, { encoding: 'utf8' }))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line).event)
        ).toEqual(['approval_requested', 'rejected']),
      TENANT
    );
  });

  it('declares review-required audit state with no automatic expiry', () => {
    const catalog = retention.loadRetentionCatalog();
    for (const file of [
      STORE,
      STORE + '/confidential/acme/terminal/requests/x.json',
      STORE + '/personal/acme/terminal/approvals.jsonl',
    ]) {
      const entry = retention.retentionEntryForPath(catalog, file);
      expect(entry?.path).toBe(STORE);
      expect(entry?.artifact_class).toBe('state');
      expect(entry?.action).toBe('review_required');
      expect(entry?.ttl_days).toBeUndefined();
    }
  });
});
