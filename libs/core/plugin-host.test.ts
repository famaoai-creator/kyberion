import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import {
  installPluginManaged,
  listManagedPlugins,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  activatePlugin,
  getActivePluginPermissionsDigest,
  isPluginActive,
  resetPluginLifecycleForTests,
} from './plugin-lifecycle.js';
import {
  createPluginHost,
  DEFAULT_PLUGIN_HOST_POLL_MS,
  disposePluginHost,
  getOrCreatePluginHost,
  getPluginHost,
  parsePluginHostTenantAllow,
  resolvePluginHostPollMs,
  type CreatePluginHostOptions,
  type PluginHostAuditEntry,
  type PluginHostTimers,
} from './plugin-host.js';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const TMP_ROOT = pathResolver.sharedTmp('plugin-host-test');
const cleanupPaths: string[] = [];
const hostSurfaces: string[] = [];

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

afterEach(() => {
  resetPluginLifecycleForTests();
  for (const surface of hostSurfaces.splice(0)) disposePluginHost(surface);
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) safeRmSync(cleanupPaths.pop() as string);
  });
});

afterAll(() => {
  withExecutionContext('mission_controller', () => safeRmSync(TMP_ROOT));
});

interface FixtureManifest {
  version?: string;
  permissions: Record<string, unknown>;
}

function fixtureSource(mutateManifest?: (manifest: FixtureManifest) => void): string {
  const src = tracked(path.join(TMP_ROOT, `src-${randomUUID()}`));
  safeMkdir(src, { recursive: true });
  for (const name of ['plugin-manifest.json', 'index.mjs']) {
    safeWriteFile(
      path.join(src, name),
      safeReadFile(path.join(FIXTURE_DIR, name), { encoding: 'utf8' }) as string
    );
  }
  if (mutateManifest) {
    const manifestPath = path.join(src, 'plugin-manifest.json');
    const manifest = JSON.parse(
      safeReadFile(manifestPath, { encoding: 'utf8' }) as string
    ) as FixtureManifest;
    mutateManifest(manifest);
    safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return src;
}

function install(
  pluginId: string,
  managedRoot: string,
  options: { approve?: boolean; tenantSlug?: string; source?: string } = {}
): ManagedPluginRecord {
  const record = installPluginManaged({
    pluginId,
    sourcePath: options.source ?? fixtureSource(),
    managedRoot,
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
  });
  if (options.approve === false) return record;
  const pending = loadApprovalRequest(
    record.approvalChannel as string,
    record.approvalRequestId as string
  );
  decideApprovalRequest('mission_controller', {
    channel: record.approvalChannel as string,
    requestId: record.approvalRequestId as string,
    decision: 'approved',
    decidedBy: 'human:operator',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: pending?.accountability?.payloadHash,
    effectBinding: pending?.accountability?.effectBinding,
  });
  const refreshed = refreshManagedPluginActivation(pluginId, managedRoot);
  expect(refreshed?.activationStatus).toBe('activatable');
  return refreshed as ManagedPluginRecord;
}

function newRoot(): { managedRoot: string; id: (prefix: string) => string } {
  const suffix = `${process.pid}-${randomUUID()}`;
  return {
    managedRoot: tracked(pathResolver.sharedTmp(`plugins/managed-test-host-${suffix}`)),
    id: (prefix) => `${prefix}-${suffix}`.slice(0, 60),
  };
}

function fakeTimers() {
  const intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const timers: PluginHostTimers = {
    setInterval(callback, ms) {
      const entry = { callback, ms, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return { timers, intervals };
}

function hostFor(managedRoot: string, overrides: Partial<CreatePluginHostOptions> = {}) {
  const audits: PluginHostAuditEntry[] = [];
  const host = createPluginHost({
    surface: 'test',
    managedRoot,
    tenantAllow: [],
    timers: fakeTimers().timers,
    now: () => new Date('2026-09-26T00:00:00.000Z'),
    audit: (entry) => audits.push(entry),
    ...overrides,
  });
  const actions = () => audits.map((entry) => `${entry.action}:${entry.operation}:${entry.reason}`);
  return { host, audits, actions };
}

describe('plugin host sync (PH-01)', () => {
  it('activates only activatable records and reports codes without paths', async () => {
    const { managedRoot, id } = newRoot();
    const ready = install(id('ready'), managedRoot);
    const pending = install(id('pending'), managedRoot, { approve: false });
    const { host, actions } = hostFor(managedRoot);

    const status = await host.syncNow();
    expect(isPluginActive(ready.pluginId)).toBe(true);
    expect(isPluginActive(pending.pluginId)).toBe(false);
    expect(status).toMatchObject({
      enabled: true,
      surface: 'test',
      lastSyncAt: '2026-09-26T00:00:00.000Z',
    });
    expect(status.plugins).toEqual(
      [
        {
          pluginId: ready.pluginId,
          state: 'active',
          reasonCode: 'activated',
          contentDigestPrefix: ready.contentDigest?.slice(0, 12),
        },
        {
          pluginId: pending.pluginId,
          state: 'inactive',
          reasonCode: 'pending_approval',
          contentDigestPrefix: pending.contentDigest?.slice(0, 12),
        },
      ].sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1))
    );
    expect(JSON.stringify(status)).not.toContain(managedRoot);
    expect(actions()).toEqual(
      expect.arrayContaining([
        `plugin_host.activate:${ready.pluginId}:activated`,
        `plugin_host.refuse:${pending.pluginId}:pending_approval`,
      ])
    );

    // Unchanged records: no lifecycle calls, no new audit events.
    const before = actions().length;
    expect((await host.syncNow()).plugins.find((p) => p.pluginId === ready.pluginId)).toMatchObject(
      { state: 'active', reasonCode: 'activated' }
    );
    expect(actions()).toHaveLength(before);
  });

  it('deactivates a running plugin whose managed copy was tampered with or removed', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('tamper'), managedRoot);
    const { host, actions } = hostFor(managedRoot);
    await host.syncNow();
    expect(isPluginActive(record.pluginId)).toBe(true);

    withExecutionContext('mission_controller', () =>
      safeWriteFile(path.join(record.managedPath, 'index.mjs'), 'export const tampered = 1;\n')
    );
    const status = await host.syncNow();
    expect(isPluginActive(record.pluginId)).toBe(false);
    expect(status.plugins).toEqual([
      expect.objectContaining({ state: 'inactive', reasonCode: 'blocked_digest_mismatch' }),
    ]);
    expect(actions()).toEqual(
      expect.arrayContaining([
        `plugin_host.deactivate:${record.pluginId}:blocked_digest_mismatch`,
        `plugin_host.refuse:${record.pluginId}:blocked_digest_mismatch`,
      ])
    );

    const second = install(id('removed'), managedRoot);
    await host.syncNow();
    expect(isPluginActive(second.pluginId)).toBe(true);
    withExecutionContext('mission_controller', () => safeRmSync(second.managedPath));
    const afterRemoval = await host.syncNow();
    expect(isPluginActive(second.pluginId)).toBe(false);
    expect(afterRemoval.plugins.map((plugin) => plugin.pluginId)).toEqual([record.pluginId]);
    expect(actions()).toContain(`plugin_host.deactivate:${second.pluginId}:removed`);
  });

  it('stops a pending plugin that something else started', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('external'), managedRoot);
    await activatePlugin({ record }, { managedRoot });
    install(record.pluginId, managedRoot, {
      approve: false,
      source: fixtureSource((manifest) => {
        manifest.version = '2.0.0';
      }),
    });
    const { host } = hostFor(managedRoot);
    await host.syncNow();
    expect(isPluginActive(record.pluginId)).toBe(false);
  });

  it('reloads an active plugin when the approved grant changes', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('grant'), managedRoot);
    const { host, actions } = hostFor(managedRoot);
    await host.syncNow();
    expect(getActivePluginPermissionsDigest(record.pluginId)).toBe(record.permissionsDigest);

    const narrowed = install(record.pluginId, managedRoot, {
      source: fixtureSource((manifest) => {
        manifest.permissions.fs = { mode: 'none' };
      }),
    });
    expect(narrowed.permissionsDigest).not.toBe(record.permissionsDigest);
    const status = await host.syncNow();
    expect(status.plugins).toEqual([
      expect.objectContaining({ state: 'active', reasonCode: 'reloaded' }),
    ]);
    expect(getActivePluginPermissionsDigest(record.pluginId)).toBe(narrowed.permissionsDigest);
    expect(actions()).toContain(`plugin_host.activate:${record.pluginId}:reloaded`);
  });

  it('records a failing module as refused and retries only when the record changes', async () => {
    const { managedRoot, id } = newRoot();
    const broken = fixtureSource();
    safeWriteFile(
      path.join(broken, 'index.mjs'),
      "export const registerKyberionContributions = () => { throw new Error('boom'); };\n"
    );
    const record = install(id('broken'), managedRoot, { source: broken });
    const { host, actions } = hostFor(managedRoot);
    const status = await host.syncNow();
    expect(status.plugins).toEqual([
      expect.objectContaining({ state: 'refused', reasonCode: 'activation_failed' }),
    ]);
    expect(JSON.stringify(status)).not.toContain('boom');
    expect(isPluginActive(record.pluginId)).toBe(false);
    await host.syncNow();
    expect(actions().filter((entry) => entry.includes('activation_failed'))).toHaveLength(1);

    install(record.pluginId, managedRoot);
    expect((await host.syncNow()).plugins[0]).toMatchObject({
      state: 'active',
      reasonCode: 'activated',
    });
  });

  it('never reads plugins of tenants outside the allowlist', async () => {
    const { managedRoot, id } = newRoot();
    // The fixture's ops are process-wide: only one copy can be active at a time.
    const own = install(id('tenant-a'), managedRoot, { tenantSlug: 'tenant-a' });
    const foreign = install(id('tenant-b'), managedRoot, { tenantSlug: 'tenant-b' });
    const touched = new Set<string>();
    const guarded = (record: ManagedPluginRecord) =>
      record.pluginId === foreign.pluginId
        ? new Proxy(record, {
            get(target, key, receiver) {
              touched.add(String(key));
              return Reflect.get(target, key, receiver);
            },
          })
        : record;
    const { host } = hostFor(managedRoot, {
      tenantAllow: ['tenant-a'],
      listRecords: () => listManagedPlugins(managedRoot).map(guarded),
    });
    const status = await host.syncNow();
    expect(isPluginActive(own.pluginId)).toBe(true);
    expect(isPluginActive(foreign.pluginId)).toBe(false);
    expect(status.plugins.map((plugin) => plugin.pluginId)).not.toContain(foreign.pluginId);
    expect([...touched].every((key) => key === 'tenantSlug' || key === 'pluginId')).toBe(true);

    // Without a tenant allowlist only tenant-less plugins run.
    resetPluginLifecycleForTests();
    const shared = install(id('shared'), managedRoot);
    const sharedOnly = hostFor(managedRoot).host;
    await sharedOnly.syncNow();
    expect(isPluginActive(shared.pluginId)).toBe(true);
    expect(isPluginActive(own.pluginId)).toBe(false);
  });

  it('coalesces concurrent sync requests into one follow-up run', async () => {
    let listings = 0;
    const { host } = hostFor('unused', {
      listRecords: () => {
        listings += 1;
        return [];
      },
    });
    const results = await Promise.all([host.syncNow(), host.syncNow(), host.syncNow()]);
    expect(listings).toBe(2);
    expect(results.every((result) => result.enabled)).toBe(true);
    await host.syncNow();
    expect(listings).toBe(3);
  });

  it('fails closed when the managed listing cannot be read', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('listing'), managedRoot);
    let fail = false;
    const { host, actions } = hostFor(managedRoot, {
      listRecords: () => {
        if (fail) throw new Error(`cannot read ${managedRoot}`);
        return listManagedPlugins(managedRoot);
      },
    });
    await host.syncNow();
    expect(isPluginActive(record.pluginId)).toBe(true);
    fail = true;
    const status = await host.syncNow();
    expect(isPluginActive(record.pluginId)).toBe(false);
    expect(status).toMatchObject({ lastSyncErrorCode: 'listing_failed', plugins: [] });
    expect(JSON.stringify(status)).not.toContain(managedRoot);
    expect(actions()).toContain(`plugin_host.deactivate:${record.pluginId}:listing_failed`);
  });

  it('is a no-op when disabled', async () => {
    let listings = 0;
    const { timers, intervals } = fakeTimers();
    const { host } = hostFor('unused', {
      enabled: false,
      timers,
      listRecords: () => {
        listings += 1;
        return [];
      },
    });
    host.start();
    expect(await host.syncNow()).toEqual({ enabled: false, surface: 'test', plugins: [] });
    expect(listings).toBe(0);
    expect(intervals).toEqual([]);
  });

  it('polls with injectable timers until stopped', async () => {
    let listings = 0;
    const { timers, intervals } = fakeTimers();
    const { host } = hostFor('unused', {
      timers,
      pollMs: 5_000,
      listRecords: () => {
        listings += 1;
        return [];
      },
    });
    host.start();
    host.start();
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(5_000);
    await host.syncNow();
    const afterStart = listings;
    intervals[0].callback();
    await host.syncNow();
    expect(listings).toBeGreaterThan(afterStart);
    host.stop();
    expect(intervals[0].cleared).toBe(true);
  });
});

describe('plugin host helpers (PH-01)', () => {
  it('keeps one host per surface on globalThis', () => {
    const surface = `test-registry-${randomUUID()}`;
    hostSurfaces.push(surface);
    let created = 0;
    const factory = () => {
      created += 1;
      return createPluginHost({ surface, tenantAllow: [], enabled: false });
    };
    const first = getOrCreatePluginHost(surface, factory);
    expect(getOrCreatePluginHost(surface, factory)).toBe(first);
    expect(created).toBe(1);
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for(`kyberion.pluginHost.${surface}`)]
    ).toBe(first);
    disposePluginHost(surface);
    expect(getPluginHost(surface)).toBeUndefined();
  });

  it('parses the tenant allowlist and poll interval strictly', () => {
    const known = new Set(['tenant-a', 'tenant-b']);
    expect(
      parsePluginHostTenantAllow(
        ' tenant-a, public,confidential ,Bad_Slug,unknown-x,tenant-a,',
        (slug) => known.has(slug)
      )
    ).toEqual({
      tenants: ['tenant-a'],
      rejected: ['public', 'confidential', 'Bad_Slug', 'unknown-x'],
    });
    expect(parsePluginHostTenantAllow(undefined)).toEqual({ tenants: [], rejected: [] });
    expect(resolvePluginHostPollMs(undefined)).toBe(DEFAULT_PLUGIN_HOST_POLL_MS);
    expect(resolvePluginHostPollMs('abc')).toBe(DEFAULT_PLUGIN_HOST_POLL_MS);
    expect(resolvePluginHostPollMs('10')).toBe(1_000);
    expect(resolvePluginHostPollMs('45000')).toBe(45_000);
  });
});
