import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withExecutionContext as initialContext,
  withStoreGrant as initialGrant,
} from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

/**
 * The delegation trace/record partitions against the real secure-io tier and
 * tenant boundaries (no store override): a fresh KYBERION_ROOT keeps the live
 * logical layout (`active/shared/runtime/delegation-records/...`) so the
 * protected prefixes and the dedicated-store rule apply to real writes.
 */
const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/delegation-boundary-' + process.pid);
const STORE = 'active/shared/runtime/delegation-records';
const TENANT = 'dlgown-' + process.pid;
const OTHER = 'dlgother-' + process.pid;
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
  'KYBERION_DELEGATION_STORE_DIR',
  'KYBERION_DELEGATION_TRACE_PATH',
  'KYBERION_DELEGATION_NOTIFICATIONS_PATH',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const savedRoot = process.env.KYBERION_ROOT;

let io: typeof import('./secure-io.js');
let delegations: typeof import('./workforce/delegated-task-observability.js');
let notifications: typeof import('./mission/delegation-notifications.js');
let withExecutionContext = initialContext;
let withStoreGrant = initialGrant;

function bind(role: string | undefined, tenant: string | undefined): void {
  for (const key of keys) delete process.env[key];
  if (role) process.env.MISSION_ROLE = role;
  if (tenant) process.env.KYBERION_TENANT = tenant;
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"delegation-fixture"}');
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
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('./secure-io.js');
  ({ withExecutionContext, withStoreGrant } = await import('./authority.js'));
  delegations = await import('./workforce/delegated-task-observability.js');
  notifications = await import('./mission/delegation-notifications.js');
  expect((await import('./path-resolver.js')).rootDir()).toBe(ROOT);
}, 120_000);

beforeEach(() => {
  bind(undefined, undefined);
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(path.join(ROOT, STORE), { recursive: true, force: true })
  );
});

afterAll(() => {
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

describe('delegation partitions use real secure-io tier and tenant boundaries', () => {
  it("writes a tenant-bound caller's delegation into its partition through the store role", () => {
    bind('chronos_gateway', TENANT);
    const trace = delegations.startDelegatedTaskTrace({
      owner: 'boundary-owner',
      instruction: 'tenant secret instruction',
    });
    delegations.completeDelegatedTaskTrace(trace, { resultSummary: 'tenant secret result' });
    const recordFile = path.join(
      ROOT,
      STORE,
      'confidential',
      TENANT,
      'records',
      `${trace.trace_id}.json`
    );
    expect(delegations.loadDelegatedTaskRecord(trace.trace_id)).toMatchObject({
      tenant_slug: TENANT,
      status: 'completed',
      result_summary: 'tenant secret result',
    });
    // The caller's own role cannot touch the partition directly.
    expect(() => io.safeReadFile(recordFile, { encoding: 'utf8' })).toThrow();
    expect(() => io.safeWriteFile(recordFile, 'forged')).toThrow();
    withStoreGrant(
      'delegation_record_store',
      () => {
        const traceFile = path.join(ROOT, STORE, 'confidential', TENANT, 'delegations.jsonl');
        expect(
          String(io.safeReadFile(traceFile, { encoding: 'utf8' }))
            .trim()
            .split('\n')
        ).toHaveLength(2);
      },
      { tenantSlug: TENANT }
    );
    // Untenanted delegations stay in system/ under the ordinary grants.
    bind('chronos_gateway', undefined);
    const system = delegations.startDelegatedTaskTrace({ owner: 'op', instruction: 'system' });
    expect(
      io.safeExistsSync(path.join(ROOT, STORE, 'system', 'records', `${system.trace_id}.json`))
    ).toBe(true);
  });

  it("refuses another tenant's delegation to a bound caller; an unbound host finds it", () => {
    bind('chronos_gateway', TENANT);
    const trace = delegations.startDelegatedTaskTrace({ owner: 'o', instruction: 'own only' });

    bind('chronos_gateway', OTHER);
    expect(delegations.loadDelegatedTaskRecord(trace.trace_id)).toBeNull();
    expect(delegations.listActiveDelegatedTaskRecords(8, { tenants: [TENANT] })).toEqual([]);
    expect(() =>
      io.safeReadFile(
        path.join(ROOT, STORE, 'confidential', TENANT, 'records', `${trace.trace_id}.json`),
        { encoding: 'utf8' }
      )
    ).toThrow();

    bind('chronos_gateway', undefined);
    expect(delegations.loadDelegatedTaskRecord(trace.trace_id)?.tenant_slug).toBe(TENANT);
    expect(
      delegations
        .listActiveDelegatedTaskRecords(8, { tenants: [TENANT] })
        .map((record) => record.delegation_id)
    ).toEqual([trace.trace_id]);
  });

  it("keeps a tenant's background notification in its partition; other tenants are refused", () => {
    bind('chronos_gateway', TENANT);
    const trace = delegations.startDelegatedTaskTrace({
      owner: 'boundary-owner',
      instruction: 'tenant secret background',
      background: true,
    });
    delegations.completeDelegatedTaskTrace(trace, { resultSummary: 'tenant secret result' });
    const queueFile = path.join(ROOT, STORE, 'confidential', TENANT, 'notifications.jsonl');
    expect(notifications.delegationNotificationsPath()).toBe(queueFile);
    expect(notifications.listDelegationNotifications()).toEqual([
      expect.objectContaining({ delegation_id: trace.trace_id, tenant_slug: TENANT }),
    ]);
    // The caller's own role cannot read or forge the queue directly.
    expect(() => io.safeReadFile(queueFile, { encoding: 'utf8' })).toThrow();
    expect(() => io.safeWriteFile(queueFile, 'forged')).toThrow();
    expect(io.safeExistsSync(path.join(ROOT, STORE, 'system', 'notifications.jsonl'))).toBe(false);

    bind('chronos_gateway', OTHER);
    expect(notifications.listDelegationNotifications()).toEqual([]);
    expect(notifications.claimPendingDelegationNotifications()).toEqual([]);
    expect(() => io.safeReadFile(queueFile, { encoding: 'utf8' })).toThrow();
    // A process bound to another tenant cannot bind the store role to this one,
    // and its own binding of the store role does not reach this partition.
    expect(() =>
      withStoreGrant(
        'delegation_record_store',
        () => io.safeReadFile(queueFile, { encoding: 'utf8' }),
        { tenantSlug: TENANT }
      )
    ).toThrow('ROLE_TENANT_SCOPE_MISMATCH');
    withStoreGrant(
      'delegation_record_store',
      () => expect(() => io.safeReadFile(queueFile, { encoding: 'utf8' })).toThrow(),
      { tenantSlug: OTHER }
    );

    bind('chronos_gateway', undefined);
    expect(
      notifications.claimPendingDelegationNotifications().map((row) => row.delegation_id)
    ).toEqual([trace.trace_id]);
    expect(notifications.claimPendingDelegationNotifications()).toEqual([]);
  });
});
