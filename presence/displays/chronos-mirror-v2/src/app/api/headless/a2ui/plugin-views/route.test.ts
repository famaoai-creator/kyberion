import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { auditChain, type AuditEntry } from '@agent/core/audit-chain';
import { activatePlugin, resetPluginLifecycleForTests } from '@agent/core/plugin-lifecycle';
import {
  createPluginHost,
  disposePluginHost,
  getOrCreatePluginHost,
} from '@agent/core/plugin-host';

const state = vi.hoisted(() => ({
  managedRoot: '',
  viewer: {} as Record<string, unknown>,
  listOptions: [] as Array<{ tenantAllow?: readonly string[] } | undefined>,
}));

vi.mock('../../../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
}));

vi.mock('../../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../../lib/viewer-context')>(
    '../../../../../lib/viewer-context'
  );
  return {
    ...actual,
    resolveViewerContextForRequest: vi.fn(() => ({ context: state.viewer })),
  };
});

vi.mock('@agent/core/plugin-managed-install', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/plugin-managed-install')>(
    '@agent/core/plugin-managed-install'
  );
  return {
    ...actual,
    listManagedPlugins: (
      root?: string,
      options?: Parameters<typeof actual.listManagedPlugins>[1]
    ) => {
      state.listOptions.push(options);
      return actual.listManagedPlugins(root ?? state.managedRoot, options);
    },
  };
});

import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from '@agent/core/plugin-managed-install';
import { GET, POST } from './route';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const FILES = ['plugin-manifest.json', 'index.mjs', 'views/status.a2ui.json', 'views/frame.html'];
const TMP_ROOT = pathResolver.sharedTmp('chronos-plugin-views-route-test');
const cleanup: string[] = [];
const ACTION_DIR = pathResolver.shared('coordination/channels/chronos/plugin-view-actions');
/** Sidecars are named `<request time>-<approval id>.json`. */
const trackedActionIds: string[] = [];

function viewer(overrides: Record<string, unknown> = {}) {
  return {
    role: 'readonly',
    tenantSlugs: 'all',
    tierAccess: ['public', 'confidential'],
    principalId: 'viewer-1',
    source: 'loopback',
    ...overrides,
  };
}

type FixtureManifest = {
  provides: { views: Array<Record<string, unknown>> };
};

type PluginViewsResponseBody = {
  resource?: string;
  error?: string;
  error_key?: string;
  data?: {
    host?: { enabled: boolean; plugins?: Array<{ plugin_id: string; state: string }> };
    views?: Array<{ view_id: string } & Record<string, unknown>>;
    a2ui?: { updateComponents?: { components?: unknown[] } };
    errors?: unknown[];
    outcome?: { status: string; approvalRequestId?: string; handled?: boolean };
    message_key?: string;
    action_requests?: Array<{
      approval_request_id: string;
      status: string;
      params: unknown;
      executable: boolean;
      unavailable_reason?: string;
    }>;
  };
};

function fixtureSource(mutateManifest?: (manifest: FixtureManifest) => void): string {
  const dir = path.join(TMP_ROOT, `src-${randomUUID()}`);
  cleanup.push(dir);
  for (const name of FILES) {
    let text = String(safeReadFile(path.join(FIXTURE_DIR, name), { encoding: 'utf8' }));
    if (name === 'plugin-manifest.json' && mutateManifest) {
      const manifest = JSON.parse(text);
      mutateManifest(manifest);
      text = JSON.stringify(manifest);
    }
    safeMkdir(path.dirname(path.join(dir, name)), { recursive: true });
    safeWriteFile(path.join(dir, name), text);
  }
  return dir;
}

function install(
  sourcePath: string,
  options: { tenantSlug?: string; approve?: boolean; pluginId?: string } = {}
): ManagedPluginRecord {
  const pluginId = options.pluginId ?? `pv-route-${randomUUID()}`.slice(0, 40);
  const record = installPluginManaged({
    pluginId,
    sourcePath,
    managedRoot: state.managedRoot,
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
  const refreshed = refreshManagedPluginActivation(pluginId, state.managedRoot);
  expect(refreshed?.activationStatus).toBe('activatable');
  return refreshed as ManagedPluginRecord;
}

async function listViews(query = '') {
  const response = await GET(
    new NextRequest(`http://localhost/api/headless/a2ui/plugin-views${query}`)
  );
  return { status: response.status, body: (await response.json()) as PluginViewsResponseBody };
}

async function act(body: Record<string, unknown>) {
  const response = await POST(
    new NextRequest('http://localhost/api/headless/a2ui/plugin-views', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  );
  return { status: response.status, body: (await response.json()) as PluginViewsResponseBody };
}

beforeEach(() => {
  state.managedRoot = pathResolver.shared(`plugins/managed-test-chronos-views-${randomUUID()}`);
  cleanup.push(state.managedRoot);
  state.viewer = viewer();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  disposePluginHost('chronos');
  resetPluginLifecycleForTests();
  withExecutionContext('mission_controller', () => {
    const ids = trackedActionIds.splice(0);
    if (ids.length > 0 && safeExistsSync(ACTION_DIR)) {
      for (const entry of safeReaddir(ACTION_DIR)) {
        if (ids.some((id) => entry.endsWith(`-${id}.json`))) {
          safeRmSync(path.join(ACTION_DIR, entry));
        }
      }
    }
    while (cleanup.length > 0) safeRmSync(cleanup.pop() as string);
  });
});

afterAll(() => {
  withExecutionContext('mission_controller', () => safeRmSync(TMP_ROOT));
});

describe('GET /api/headless/a2ui/plugin-views', () => {
  it('lists an approved plugin view with a composed A2UI projection', async () => {
    const record = install(fixtureSource());
    const { status, body } = await listViews();
    expect(status).toBe(200);
    expect(body.resource).toBe('plugin-views');
    expect(body.data.host).toEqual({ enabled: false });
    expect(body.data.views).toHaveLength(2);
    expect(body.data.views[0]).toMatchObject({
      plugin_id: record.pluginId,
      view_id: 'status',
      title: 'Permissions fixture status',
      isolation: 'in-process-a2ui',
    });
    expect(body.data.views[0].frame_url).toBeUndefined();
    // PH-02: the iframe view is listed with its frame route URL, never its document.
    expect(body.data.views[1]).toMatchObject({
      view_id: 'status_frame',
      isolation: 'sandboxed-iframe',
      capabilities: ['action.request'],
      messages: [],
      frame_url: `/api/headless/a2ui/plugin-views/frame?plugin_id=${record.pluginId}&view_id=status_frame`,
    });
    expect(JSON.stringify(body.data.views[1])).not.toContain('<script');
    expect(body.data.a2ui.updateComponents.components[0]).toMatchObject({
      id: 'pv0-section',
      type: 'ui:section',
    });
  });

  it('hides pending and digest-mismatched plugins', async () => {
    install(fixtureSource(), { approve: false });
    const approved = install(fixtureSource());
    withExecutionContext('mission_controller', () =>
      safeWriteFile(path.join(approved.managedPath, 'views/status.a2ui.json'), '[]')
    );
    const { status, body } = await listViews();
    expect(status).toBe(200);
    expect(body.data.views).toEqual([]);
    expect(body.data.errors).toEqual([]);
  });

  it('hides another tenant plugin and rejects a tenant filter outside the viewer scope', async () => {
    install(fixtureSource(), { tenantSlug: 'tenant-a' });
    state.viewer = viewer({ tenantSlugs: ['tenant-b'] });
    expect((await listViews()).body.data.views).toEqual([]);
    expect((await listViews('?tenant=tenant-a')).status).toBe(403);
    state.viewer = viewer({ tenantSlugs: ['tenant-a'] });
    expect((await listViews('?tenant=tenant-a')).body.data.views).toHaveLength(2);
  });

  it("lists only the viewer's tenants, so other tenants' copies are not digested", async () => {
    const foreign = install(fixtureSource(), { tenantSlug: 'tenant-a' });
    state.viewer = viewer({ role: 'localadmin', tenantSlugs: ['tenant-b'] });
    state.listOptions.length = 0;
    expect((await listViews()).body.data.views).toEqual([]);
    expect(state.listOptions.length).toBeGreaterThan(0);
    expect(state.listOptions.every((options) => options?.tenantAllow?.join() === 'tenant-b')).toBe(
      true
    );
    // A viewer scoped to 'all' keeps listing every tenant.
    state.viewer = viewer({ role: 'localadmin' });
    state.listOptions.length = 0;
    const all = (await listViews()).body.data.views ?? [];
    expect(all.map((view) => view.plugin_id)).toContain(foreign.pluginId);
    expect(state.listOptions.every((options) => options?.tenantAllow === undefined)).toBe(true);
  });

  it('applies the role gate and lets a tier filter narrow only', async () => {
    install(
      fixtureSource((manifest) => {
        for (const view of manifest.provides.views) {
          view.roleGate = { minRole: 'localadmin', tiers: ['public'] };
        }
      })
    );
    expect((await listViews()).body.data.views).toEqual([]);
    state.viewer = viewer({ role: 'localadmin' });
    expect((await listViews()).body.data.views).toHaveLength(2);
    expect((await listViews('?tier=confidential')).body.data.views).toEqual([]);
    state.viewer = viewer({ role: 'localadmin', tierAccess: ['public'] });
    expect((await listViews('?tier=confidential')).status).toBe(403);
  });
});

describe('POST /api/headless/a2ui/plugin-views', () => {
  it('rejects a readonly viewer', async () => {
    const record = install(fixtureSource());
    const { status } = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'probe_env',
    });
    expect(status).toBe(403);
  });

  it('queues a human action for approval and maps unknown actions to 404', async () => {
    state.viewer = viewer({ role: 'localadmin' });
    const record = install(fixtureSource());
    const queued = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params: { path: `active/shared/tmp/${randomUUID()}` },
    });
    expect(queued.status).toBe(202);
    expect(queued.body.data.outcome.status).toBe('approval_required');
    const requestId = queued.body.data.outcome.approvalRequestId as string;
    cleanup.push(
      pathResolver.shared(`coordination/channels/chronos/approvals/requests/${requestId}.json`)
    );
    trackedActionIds.push(requestId);

    const unknown = await act({ plugin_id: record.pluginId, view_id: 'status', action_id: 'nope' });
    expect(unknown).toMatchObject({
      status: 404,
      body: { error: 'PLUGIN_VIEW_NOT_FOUND', error_key: 'plugin:view_error_not_found' },
    });
    const badParams = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params: { path: 'x', extra: true },
    });
    expect(badParams.status).toBe(400);
    // Not active in the Chronos process: agent actions are refused, never imported here.
    const agent = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'probe_env',
    });
    expect(agent.status).toBe(409);
  });

  it("refuses actions on another tenant's plugin without queueing anything", async () => {
    const record = install(fixtureSource(), { tenantSlug: 'tenant-a' });
    const audit = vi.spyOn(auditChain, 'record');
    state.viewer = viewer({ role: 'localadmin', tenantSlugs: ['tenant-b'] });
    for (const action_id of ['write_probe', 'probe_env']) {
      const { status, body } = await act({
        plugin_id: record.pluginId,
        view_id: 'status',
        action_id,
        params: action_id === 'write_probe' ? { path: 'x' } : {},
      });
      expect(status).toBe(404);
      expect(body.error).toBe('PLUGIN_VIEW_NOT_FOUND');
    }
    const actionAudits = audit.mock.calls.filter(([entry]) =>
      String(entry.action).startsWith('plugin_view.action')
    );
    expect(actionAudits).toEqual([]);
  });

  it('refuses actions of a digest-mismatched plugin', async () => {
    state.viewer = viewer({ role: 'localadmin' });
    const record = install(fixtureSource());
    withExecutionContext('mission_controller', () =>
      safeWriteFile(path.join(record.managedPath, 'index.mjs'), 'export const tampered = 1;\n')
    );
    const { status, body } = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params: { path: 'x' },
    });
    expect(status).toBe(403);
    expect(body.error).toBe('PLUGIN_VIEW_DENIED');
  });
});

describe('POST /api/headless/a2ui/plugin-views execute (FU-02)', () => {
  function trackActionRequest(id: string) {
    cleanup.push(
      pathResolver.shared(`coordination/channels/chronos/approvals/requests/${id}.json`),
      pathResolver.shared(`coordination/channels/chronos/plugin-view-actions/${id}.claim.json`)
    );
    trackedActionIds.push(id);
  }

  function approve(id: string) {
    const pending = loadApprovalRequest('chronos', id);
    decideApprovalRequest('mission_controller', {
      channel: 'chronos',
      requestId: id,
      decision: 'approved',
      decidedBy: 'human:approver',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: pending?.accountability?.payloadHash,
      effectBinding: pending?.accountability?.effectBinding,
    });
  }

  async function queue(record: ManagedPluginRecord, params: Record<string, unknown>) {
    const queued = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params,
    });
    expect(queued.status).toBe(202);
    const id = queued.body.data.outcome.approvalRequestId as string;
    trackActionRequest(id);
    return id;
  }

  function execute(record: ManagedPluginRecord, id: string, params: Record<string, unknown>) {
    return act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params,
      approval_request_id: id,
    });
  }

  function spyAudit() {
    return vi.spyOn(auditChain, 'record').mockImplementation(
      (entry) =>
        ({
          ...entry,
          id: 'audit',
          timestamp: '',
          previousHash: '',
          currentHash: '',
        }) as AuditEntry
    );
  }

  it('executes an approved action once, after approval only, for a localadmin', async () => {
    const audit = spyAudit();
    state.viewer = viewer({ role: 'localadmin' });
    const record = install(fixtureSource());
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(record, params);

    expect(await execute(record, id, params)).toMatchObject({
      status: 409,
      body: { error: 'PLUGIN_VIEW_APPROVAL_REQUIRED' },
    });
    expect((await listViews()).body.data.action_requests).toMatchObject([
      { approval_request_id: id, status: 'pending', params, executable: false },
    ]);
    approve(id);

    // Approved but the plugin is not active in this process: not executable
    // (the UI shows why instead of an Execute button); executing is 409.
    expect((await listViews()).body.data.action_requests).toMatchObject([
      {
        approval_request_id: id,
        status: 'approved',
        executable: false,
        unavailable_reason: 'PLUGIN_VIEW_ACTION_UNAVAILABLE',
      },
    ]);
    expect((await execute(record, id, params)).body.error).toBe('PLUGIN_VIEW_ACTION_UNAVAILABLE');
    expect((await activatePlugin({ record }, { managedRoot: state.managedRoot })).ok).toBe(true);
    const [executable] = (await listViews()).body.data.action_requests;
    expect(executable).toMatchObject({ status: 'approved', executable: true });
    expect(executable.unavailable_reason).toBeUndefined();

    expect((await execute(record, id, { path: 'active/shared/tmp/changed' })).status).toBe(403);
    state.viewer = viewer({ role: 'readonly' });
    expect((await execute(record, id, params)).status).toBe(403);
    expect((await listViews()).body.data.action_requests).toEqual([]);

    state.viewer = viewer({ role: 'localadmin', principalId: 'viewer-2' });
    const executed = await execute(record, id, params);
    expect(executed).toMatchObject({
      status: 200,
      body: {
        data: {
          outcome: { status: 'executed', handled: true, approvalRequestId: id },
          message_key: 'plugin:view_action_executed',
        },
      },
    });
    expect(await execute(record, id, params)).toMatchObject({
      status: 409,
      body: {
        error: 'PLUGIN_VIEW_APPROVAL_CONSUMED',
        error_key: 'plugin:view_error_approval_consumed',
      },
    });
    expect((await listViews()).body.data.action_requests).toMatchObject([
      { approval_request_id: id, status: 'executed' },
    ]);
    const completed = audit.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry) => entry.action === 'plugin_view.action.execute' && entry.result === 'completed'
      );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ agentId: 'viewer-2', correlationId: id });
  });

  it('refuses another tenant viewer and a reinstalled plugin', async () => {
    spyAudit();
    state.viewer = viewer({ role: 'localadmin', tenantSlugs: ['tenant-a'] });
    const record = install(fixtureSource(), { tenantSlug: 'tenant-a' });
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(record, params);
    approve(id);

    state.viewer = viewer({ role: 'localadmin', tenantSlugs: ['tenant-b'] });
    expect((await execute(record, id, params)).status).toBe(404);
    expect((await listViews()).body.data.action_requests).toEqual([]);

    state.viewer = viewer({ role: 'localadmin', tenantSlugs: ['tenant-a'] });
    const reinstalled = install(
      fixtureSource((manifest) => {
        (manifest as FixtureManifest & { version?: string }).version = '1.0.1';
      }),
      { tenantSlug: 'tenant-a', pluginId: record.pluginId }
    );
    expect(reinstalled.contentDigest).not.toBe(record.contentDigest);
    expect(await execute(reinstalled, id, params)).toMatchObject({
      status: 403,
      body: { error: 'PLUGIN_VIEW_APPROVAL_MISMATCH' },
    });
    expect((await listViews()).body.data.action_requests).toMatchObject([
      { approval_request_id: id, status: 'stale' },
    ]);
  });
});

describe('plugin-views with the Chronos plugin host enabled (PH-01)', () => {
  function useHost() {
    vi.stubEnv('KYBERION_CHRONOS_PLUGIN_HOST', '1');
    const host = getOrCreatePluginHost('chronos', () =>
      createPluginHost({
        surface: 'chronos',
        tenantAllow: [],
        managedRoot: state.managedRoot,
        audit: () => undefined,
      })
    );
    return { host, syncNow: vi.spyOn(host, 'syncNow') };
  }

  it('executes an approved human action end-to-end without a manual activation', async () => {
    vi.spyOn(auditChain, 'record').mockImplementation(
      (entry) =>
        ({ ...entry, id: 'a', timestamp: '', previousHash: '', currentHash: '' }) as AuditEntry
    );
    const { syncNow } = useHost();
    state.viewer = viewer({ role: 'localadmin' });
    const record = install(fixtureSource());
    const params = { path: `active/shared/tmp/${randomUUID()}` };

    const queued = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params,
    });
    expect(queued.status).toBe(202);
    const id = queued.body.data.outcome.approvalRequestId as string;
    cleanup.push(
      pathResolver.shared(`coordination/channels/chronos/approvals/requests/${id}.json`),
      pathResolver.shared(`coordination/channels/chronos/plugin-view-actions/${id}.claim.json`)
    );
    trackedActionIds.push(id);
    // The POST synced the host before acting: the plugin now runs in-process.
    expect(syncNow).toHaveBeenCalledTimes(1);

    const pending = loadApprovalRequest('chronos', id);
    decideApprovalRequest('mission_controller', {
      channel: 'chronos',
      requestId: id,
      decision: 'approved',
      decidedBy: 'human:approver',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: pending?.accountability?.payloadHash,
      effectBinding: pending?.accountability?.effectBinding,
    });

    const listed = (await listViews()).body.data;
    expect(listed.host).toEqual({
      enabled: true,
      plugins: [expect.objectContaining({ plugin_id: record.pluginId, state: 'active' })],
    });
    expect(listed.action_requests).toMatchObject([
      { approval_request_id: id, status: 'approved', executable: true },
    ]);

    const executed = await act({
      plugin_id: record.pluginId,
      view_id: 'status',
      action_id: 'write_probe',
      params,
      approval_request_id: id,
    });
    expect(executed).toMatchObject({
      status: 200,
      body: { data: { outcome: { status: 'executed', approvalRequestId: id } } },
    });
    expect(syncNow).toHaveBeenCalledTimes(2);
  });

  it('shows a readonly viewer only whether the host is enabled', async () => {
    const { host } = useHost();
    const record = install(fixtureSource());
    await host.syncNow();
    expect((await listViews()).body.data.host).toEqual({ enabled: true });
    state.viewer = viewer({ role: 'localadmin' });
    expect((await listViews()).body.data.host).toEqual({
      enabled: true,
      plugins: [expect.objectContaining({ plugin_id: record.pluginId, state: 'active' })],
    });
  });
});
