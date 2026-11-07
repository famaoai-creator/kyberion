/**
 * Tenant partitioning of the delegated-task trace and records
 * (owner decision 2026-11-05, "partition it"): placement per tenant/system,
 * cross-tenant reads refused, the dedicated tenant-bound store role, and the
 * legacy shared-copy read fallback with migration on first write.
 *
 * I/O runs under a per-process KYBERION_DELEGATION_STORE_DIR override (its
 * `legacy/` subdirectory stands in for the pre-partition shared files); the
 * registered-layout and tier-guard checks compute paths and decisions only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import { tenantRuntimePartitionOf, tenantStoreLedgerPartitionOf } from './storage-layout.js';
import {
  buildDelegatedTaskWorkerProcessSpec,
  claimDelegatedTaskActivation,
  completeDelegatedTaskTrace,
  DELEGATION_RECORD_STORE_ROLE,
  delegatedTaskRecordPath,
  delegatedTaskTracePath,
  listActiveDelegatedTaskRecords,
  loadDelegatedTaskRecord,
  startDelegatedTaskTrace,
  systemDelegationTracePaths,
} from './workforce/delegated-task-observability.js';
import {
  claimPendingDelegationNotifications,
  delegationNotificationsPath,
  enqueueDelegationNotification,
  listDelegationNotifications,
} from './mission/delegation-notifications.js';

const STORE = `active/shared/tmp/delegation-partition-tests/store-${process.pid}`;
const ENV_KEYS = [
  'KYBERION_DELEGATION_STORE_DIR',
  'KYBERION_DELEGATION_TRACE_PATH',
  'KYBERION_DELEGATION_NOTIFICATIONS_PATH',
  'KYBERION_TENANT',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function repoRelative(absolute: string): string {
  return path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/');
}

function bindTenant(tenant: string | undefined): void {
  if (tenant) process.env.KYBERION_TENANT = tenant;
  else delete process.env.KYBERION_TENANT;
}

function storePath(...parts: string[]): string {
  return pathResolver.rootResolve(path.posix.join(STORE, ...parts));
}

function writeLegacyRecord(id: string, fields: Record<string, unknown> = {}): string {
  const filePath = storePath('legacy', 'delegations', `${id}.json`);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(
    filePath,
    JSON.stringify({
      delegation_id: id,
      kind: 'delegated_task',
      created_at: '2026-10-01T00:00:00.000Z',
      status: 'started',
      owner: 'legacy-owner',
      instruction: `legacy instruction ${id}`,
      ...fields,
    })
  );
  return filePath;
}

function cleanup(): void {
  const dir = pathResolver.rootResolve(STORE);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.KYBERION_DELEGATION_STORE_DIR = STORE;
  process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH = `${STORE}/notifications.jsonl`;
  cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  cleanup();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('delegation store placement', () => {
  it('writes untenanted delegations to system/ and tenant ones to confidential/<tenant>/', () => {
    const system = startDelegatedTaskTrace({ owner: 'op', instruction: 'system work' });
    expect(system.tenant_slug).toBeUndefined();
    expect(safeExistsSync(storePath('system', 'records', `${system.trace_id}.json`))).toBe(true);
    expect(safeExistsSync(storePath('system', 'delegations.jsonl'))).toBe(true);

    bindTenant('acme');
    const tenant = startDelegatedTaskTrace({ owner: 'op', instruction: 'acme secret' });
    completeDelegatedTaskTrace(tenant, { resultSummary: 'acme result' });
    expect(tenant.tenant_slug).toBe('acme');
    const recordFile = storePath('confidential', 'acme', 'records', `${tenant.trace_id}.json`);
    expect(JSON.parse(String(safeReadFile(recordFile, { encoding: 'utf8' })))).toMatchObject({
      tenant_slug: 'acme',
      status: 'completed',
      result_summary: 'acme result',
    });
    const traceRows = String(
      safeReadFile(storePath('confidential', 'acme', 'delegations.jsonl'), { encoding: 'utf8' })
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(traceRows.map((row) => row.status)).toEqual(['started', 'completed']);
    // Nothing of the tenant reached the system partition.
    const systemTrace = String(
      safeReadFile(storePath('system', 'delegations.jsonl'), { encoding: 'utf8' })
    );
    expect(systemTrace).not.toContain('acme');
    expect(delegatedTaskTracePath()).toBe(storePath('confidential', 'acme', 'delegations.jsonl'));
    // Learning signals read the system partition and the legacy trace only.
    expect(systemDelegationTracePaths()).toEqual([
      storePath('system', 'delegations.jsonl'),
      storePath('legacy', 'delegations.jsonl'),
    ]);
  });

  it('resolves the registered layout: tenant partitions are delegation_record_store partitions', () => {
    delete process.env.KYBERION_DELEGATION_STORE_DIR;
    bindTenant('acme');
    const tenantPath = repoRelative(delegatedTaskRecordPath('d-1'));
    expect(tenantPath).toBe(
      'active/shared/runtime/delegation-records/confidential/acme/records/d-1.json'
    );
    expect(tenantRuntimePartitionOf(tenantPath)).toMatchObject({
      key: 'delegations',
      tier: 'confidential',
      tenant: 'acme',
    });
    expect(tenantStoreLedgerPartitionOf(tenantPath)).toMatchObject({
      storeRole: DELEGATION_RECORD_STORE_ROLE,
      tenant: 'acme',
    });
    bindTenant(undefined);
    const systemPath = repoRelative(delegatedTaskRecordPath('d-1'));
    expect(systemPath).toBe('active/shared/runtime/delegation-records/system/records/d-1.json');
    expect(tenantRuntimePartitionOf(systemPath)).toBeUndefined();
  });
});

describe('delegation store tier-guard boundary (decisions only)', () => {
  const root = pathResolver.rootDir();
  const record = (tenant: string) =>
    path.join(
      root,
      `active/shared/runtime/delegation-records/confidential/${tenant}/records/d.json`
    );

  it('admits only the store role bound to the same tenant', () => {
    process.env.MISSION_ROLE = 'chronos_gateway';
    bindTenant('acme');
    expect(validateWritePermission(record('acme')).allowed).toBe(false);
    expect(validateReadPermission(record('acme')).allowed).toBe(false);
    withExecutionContext(
      DELEGATION_RECORD_STORE_ROLE,
      () => {
        expect(validateWritePermission(record('acme')).allowed).toBe(true);
        expect(validateReadPermission(record('acme')).allowed).toBe(true);
        expect(validateWritePermission(record('beta')).allowed).toBe(false);
        expect(validateReadPermission(record('beta')).allowed).toBe(false);
      },
      undefined,
      'acme'
    );
    expect(() =>
      withExecutionContext(DELEGATION_RECORD_STORE_ROLE, () => undefined, undefined, 'beta')
    ).toThrow('ROLE_TENANT_SCOPE_MISMATCH');
    // The system partition keeps the ordinary runtime grants.
    expect(
      validateWritePermission(
        path.join(root, 'active/shared/runtime/delegation-records/system/delegations.jsonl')
      ).allowed
    ).toBe(true);
  });
});

describe('cross-tenant delegation reads', () => {
  it("never returns another tenant's record or listing; an unbound host finds it", () => {
    bindTenant('acme');
    const acme = startDelegatedTaskTrace({ owner: 'op', instruction: 'acme only' });

    bindTenant('beta');
    expect(loadDelegatedTaskRecord(acme.trace_id)).toBeNull();
    expect(listActiveDelegatedTaskRecords(8)).toEqual([]);
    expect(listActiveDelegatedTaskRecords(8, { tenants: ['acme'], includeSystem: true })).toEqual(
      []
    );
    expect(() =>
      startDelegatedTaskTrace({ owner: 'op', instruction: 'x', tenantSlug: 'acme' })
    ).toThrow('DELEGATION_TENANT_SCOPE_MISMATCH');

    bindTenant(undefined);
    expect(loadDelegatedTaskRecord(acme.trace_id)).toMatchObject({ tenant_slug: 'acme' });
    // Unbound default: the system partition only.
    expect(listActiveDelegatedTaskRecords(8).map((r) => r.delegation_id)).toEqual([]);
    expect(
      listActiveDelegatedTaskRecords(8, { tenants: ['acme'] }).map((r) => r.delegation_id)
    ).toEqual([acme.trace_id]);

    bindTenant('acme');
    expect(listActiveDelegatedTaskRecords(8).map((r) => r.delegation_id)).toEqual([acme.trace_id]);
  });

  it('binds a tenant delegation worker process to its tenant', () => {
    bindTenant('acme');
    const trace = startDelegatedTaskTrace({
      owner: 'worker-owner',
      instruction: 'continuable acme work',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'ready' });
    const spec = buildDelegatedTaskWorkerProcessSpec(trace.trace_id, 'worker-owner');
    expect(spec.tenantSlug).toBe('acme');
    expect(spec.metadata.tenantSlug).toBe('acme');
  });
});

describe('legacy shared delegation records', () => {
  it('serves an unattributed legacy record to an unbound process only', () => {
    writeLegacyRecord('legacy-system');
    expect(loadDelegatedTaskRecord('legacy-system')).toMatchObject({
      delegation_id: 'legacy-system',
    });
    expect(listActiveDelegatedTaskRecords(8).map((r) => r.delegation_id)).toEqual([
      'legacy-system',
    ]);
    bindTenant('acme');
    expect(loadDelegatedTaskRecord('legacy-system')).toBeNull();
    expect(listActiveDelegatedTaskRecords(8)).toEqual([]);
  });

  it("serves a legacy record to its mission's tenant only, then migrates it on first write", () => {
    const missionDir = pathResolver.rootResolve('active/missions/confidential/acme/MSN-LEGACY-A');
    vi.spyOn(pathResolver, 'findMissionPath').mockImplementation((id: string) =>
      id === 'MSN-LEGACY-A' ? missionDir : null
    );
    const legacyFile = writeLegacyRecord('legacy-acme', {
      mission_id: 'MSN-LEGACY-A',
      status: 'completed',
      continuable: true,
      child_session_id: 'child-legacy-acme',
      activation_count: 0,
      activation_status: 'pending',
    });

    bindTenant('beta');
    expect(loadDelegatedTaskRecord('legacy-acme')).toBeNull();

    bindTenant(undefined);
    expect(listActiveDelegatedTaskRecords(8, { includeSystem: true })).toEqual([]);

    bindTenant('acme');
    expect(loadDelegatedTaskRecord('legacy-acme')).toMatchObject({ tenant_slug: 'acme' });

    const claimed = claimDelegatedTaskActivation('legacy-acme', 'legacy-owner');
    expect(claimed.activation_status).toBe('claimed');
    expect(safeExistsSync(legacyFile)).toBe(false);
    const migrated = storePath('confidential', 'acme', 'records', 'legacy-acme.json');
    expect(JSON.parse(String(safeReadFile(migrated, { encoding: 'utf8' })))).toMatchObject({
      tenant_slug: 'acme',
      activation_status: 'claimed',
    });
    expect(loadDelegatedTaskRecord('legacy-acme')?.activation_count).toBe(1);
  });
});

describe('delegation notification partitions', () => {
  function readRows(...parts: string[]): Array<Record<string, unknown>> {
    const filePath = storePath(...parts);
    if (!safeExistsSync(filePath)) return [];
    return String(safeReadFile(filePath, { encoding: 'utf8' }))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function completeBackground(instruction: string) {
    const trace = startDelegatedTaskTrace({ owner: 'op', instruction, background: true });
    completeDelegatedTaskTrace(trace, { resultSummary: `${instruction} result` });
    return trace;
  }

  function writeLegacyNotifications(rows: Array<Record<string, unknown>>): string {
    const filePath = storePath('legacy', 'notifications.jsonl');
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      `${rows
        .map((row) =>
          JSON.stringify({
            owner: 'legacy-owner',
            status: 'completed',
            instruction_excerpt: `legacy ${String(row.notification_id)}`,
            completed_at: '2026-10-01T00:00:00.000Z',
            enqueued_at: '2026-10-01T00:00:00.000Z',
            claimed: false,
            ...row,
          })
        )
        .join('\n')}\n`
    );
    return filePath;
  }

  beforeEach(() => {
    delete process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH;
  });

  it("enqueues into the delegation's partition: tenant ones under confidential/<tenant>/", () => {
    const system = completeBackground('system background');
    bindTenant('acme');
    const acme = completeBackground('acme secret background');

    expect(readRows('confidential', 'acme', 'notifications.jsonl')).toEqual([
      expect.objectContaining({ delegation_id: acme.trace_id, tenant_slug: 'acme' }),
    ]);
    const systemRows = readRows('system', 'notifications.jsonl');
    expect(systemRows.map((row) => row.delegation_id)).toEqual([system.trace_id]);
    expect(JSON.stringify(systemRows)).not.toContain('acme');
    expect(delegationNotificationsPath()).toBe(
      storePath('confidential', 'acme', 'notifications.jsonl')
    );
    // The registered layout puts the queue in the delegation_record_store partition.
    delete process.env.KYBERION_DELEGATION_STORE_DIR;
    expect(tenantStoreLedgerPartitionOf(repoRelative(delegationNotificationsPath()))).toMatchObject(
      { storeRole: DELEGATION_RECORD_STORE_ROLE, tenant: 'acme' }
    );
    bindTenant(undefined);
    expect(repoRelative(delegationNotificationsPath())).toBe(
      'active/shared/runtime/delegation-records/system/notifications.jsonl'
    );
  });

  it("never delivers another tenant's notification; an unbound host drains every partition once", () => {
    bindTenant('acme');
    const acme = completeBackground('acme only');
    bindTenant('beta');
    const beta = completeBackground('beta only');

    expect(listDelegationNotifications().map((row) => row.delegation_id)).toEqual([beta.trace_id]);
    expect(claimPendingDelegationNotifications().map((row) => row.delegation_id)).toEqual([
      beta.trace_id,
    ]);
    // A tenant-bound process cannot place a notification in another tenant's queue.
    expect(() =>
      enqueueDelegationNotification({
        delegationId: 'forged',
        owner: 'op',
        tenantSlug: 'acme',
        status: 'completed',
        instruction: 'forged',
      })
    ).toThrow('DELEGATION_TENANT_SCOPE_MISMATCH');

    bindTenant(undefined);
    const system = completeBackground('system work');
    expect(claimPendingDelegationNotifications().map((row) => row.delegation_id)).toEqual([
      acme.trace_id,
      system.trace_id,
    ]);
    expect(claimPendingDelegationNotifications()).toEqual([]);
    expect(readRows('confidential', 'acme', 'notifications.jsonl')[0]).toMatchObject({
      claimed: true,
    });
  });

  it('serves legacy rows per attribution, migrates claims into the partition, never rewrites the legacy file', () => {
    const missionDir = pathResolver.rootResolve('active/missions/confidential/acme/MSN-NOTIFY-A');
    vi.spyOn(pathResolver, 'findMissionPath').mockImplementation((id: string) =>
      id === 'MSN-NOTIFY-A' ? missionDir : null
    );
    bindTenant('acme');
    const recorded = startDelegatedTaskTrace({ owner: 'op', instruction: 'acme record' });
    bindTenant(undefined);
    const legacyFile = writeLegacyNotifications([
      { notification_id: 'n-stamped', delegation_id: 'd-stamped', tenant_slug: 'acme' },
      { notification_id: 'n-mission', delegation_id: 'd-mission', mission_id: 'MSN-NOTIFY-A' },
      { notification_id: 'n-record', delegation_id: recorded.trace_id },
      { notification_id: 'n-loose', delegation_id: 'd-loose' },
      { notification_id: 'n-done', delegation_id: 'd-done', tenant_slug: 'acme', claimed: true },
    ]);
    const legacyBefore = String(safeReadFile(legacyFile, { encoding: 'utf8' }));

    bindTenant('beta');
    expect(listDelegationNotifications()).toEqual([]);
    expect(claimPendingDelegationNotifications()).toEqual([]);

    bindTenant('acme');
    expect(listDelegationNotifications().map((row) => row.notification_id)).toEqual([
      'n-stamped',
      'n-mission',
      'n-record',
      'n-done',
    ]);
    const claimed = claimPendingDelegationNotifications();
    expect(claimed.map((row) => row.notification_id)).toEqual([
      'n-stamped',
      'n-mission',
      'n-record',
    ]);
    expect(claimed.every((row) => row.tenant_slug === 'acme')).toBe(true);
    expect(claimPendingDelegationNotifications()).toEqual([]);
    expect(
      readRows('confidential', 'acme', 'notifications.jsonl').map((row) => [
        row.notification_id,
        row.claimed,
      ])
    ).toEqual([
      ['n-stamped', true],
      ['n-mission', true],
      ['n-record', true],
    ]);

    // Unattributed rows reach unbound processes only; the migrated copies shadow
    // the legacy rows, so nothing is delivered twice.
    bindTenant(undefined);
    expect(claimPendingDelegationNotifications().map((row) => row.notification_id)).toEqual([
      'n-loose',
    ]);
    expect(claimPendingDelegationNotifications()).toEqual([]);
    expect(readRows('system', 'notifications.jsonl').map((row) => row.notification_id)).toEqual([
      'n-loose',
    ]);
    expect(String(safeReadFile(legacyFile, { encoding: 'utf8' }))).toBe(legacyBefore);
  });
});
