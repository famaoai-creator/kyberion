import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

const state = vi.hoisted(() => ({
  managedRoot: '',
  viewer: {} as Record<string, unknown>,
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
    listManagedPlugins: (root?: string) => actual.listManagedPlugins(root ?? state.managedRoot),
  };
});

import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from '@agent/core/plugin-managed-install';
import { GET, POST } from './route';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const FILES = ['plugin-manifest.json', 'index.mjs', 'views/status.a2ui.json'];
const TMP_ROOT = pathResolver.sharedTmp('chronos-plugin-views-route-test');
const cleanup: string[] = [];

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
    views?: unknown[];
    a2ui?: { updateComponents?: { components?: unknown[] } };
    errors?: unknown[];
    outcome?: { status: string; approvalRequestId?: string };
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
  options: { tenantSlug?: string; approve?: boolean } = {}
): ManagedPluginRecord {
  const pluginId = `pv-route-${randomUUID()}`.slice(0, 40);
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
  withExecutionContext('mission_controller', () => {
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
    expect(body.data.views).toHaveLength(1);
    expect(body.data.views[0]).toMatchObject({
      plugin_id: record.pluginId,
      view_id: 'status',
      title: 'Permissions fixture status',
    });
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
    expect((await listViews('?tenant=tenant-a')).body.data.views).toHaveLength(1);
  });

  it('applies the role gate and lets a tier filter narrow only', async () => {
    install(
      fixtureSource((manifest) => {
        manifest.provides.views[0].roleGate = { minRole: 'localadmin', tiers: ['public'] };
      })
    );
    expect((await listViews()).body.data.views).toEqual([]);
    state.viewer = viewer({ role: 'localadmin' });
    expect((await listViews()).body.data.views).toHaveLength(1);
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
