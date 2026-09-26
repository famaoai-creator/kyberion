import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { pluginViewFrameResponseHeaders } from '@agent/core/plugin-view-frame';

const state = vi.hoisted(() => ({
  managedRoot: '',
  viewer: {} as Record<string, unknown>,
}));

vi.mock('../../../../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
}));

vi.mock('../../../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../../../lib/viewer-context')>(
    '../../../../../../lib/viewer-context'
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
    ) => actual.listManagedPlugins(root ?? state.managedRoot, options),
  };
});

import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from '@agent/core/plugin-managed-install';
import { GET } from './route';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const FILES = ['plugin-manifest.json', 'index.mjs', 'views/status.a2ui.json', 'views/frame.html'];
const TMP_ROOT = pathResolver.sharedTmp('chronos-plugin-view-frame-route-test');
const cleanup: string[] = [];

type FixtureManifest = { provides: { views: Array<Record<string, unknown>> } };

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

function install(sourcePath: string, options: { tenantSlug?: string } = {}): ManagedPluginRecord {
  const pluginId = `pv-frame-${randomUUID()}`.slice(0, 40);
  const record = installPluginManaged({
    pluginId,
    sourcePath,
    managedRoot: state.managedRoot,
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
  });
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

function frame(pluginId: string, viewId = 'status_frame') {
  const params = new URLSearchParams({ plugin_id: pluginId, view_id: viewId });
  return GET(
    new NextRequest(`http://localhost/api/headless/a2ui/plugin-views/frame?${params.toString()}`)
  );
}

beforeEach(() => {
  state.managedRoot = pathResolver.shared(`plugins/managed-test-chronos-frame-${randomUUID()}`);
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

describe('GET /api/headless/a2ui/plugin-views/frame (PH-02)', () => {
  it('serves the iframe view document with exactly the frame response headers', async () => {
    const record = install(fixtureSource());
    const response = await frame(record.pluginId);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      String(safeReadFile(path.join(FIXTURE_DIR, 'views/frame.html'), { encoding: 'utf8' }))
    );
    const expected = Object.fromEntries(
      Object.entries(pluginViewFrameResponseHeaders()).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ])
    );
    expect(Object.fromEntries(response.headers.entries())).toEqual(expected);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  });

  it('answers 404 for views the viewer cannot see, A2UI views and unknown views', async () => {
    const tenantBound = install(fixtureSource(), { tenantSlug: 'tenant-a' });
    state.viewer = viewer({ tenantSlugs: ['tenant-b'] });
    expect((await frame(tenantBound.pluginId)).status).toBe(404);

    const gated = install(
      fixtureSource((manifest) => {
        for (const view of manifest.provides.views) {
          view.roleGate = { minRole: 'localadmin', tiers: ['public'] };
        }
      })
    );
    state.viewer = viewer();
    expect((await frame(gated.pluginId)).status).toBe(404);
    state.viewer = viewer({ role: 'localadmin', tierAccess: ['confidential'] });
    expect((await frame(gated.pluginId)).status).toBe(404);
    state.viewer = viewer({ role: 'localadmin' });
    expect((await frame(gated.pluginId)).status).toBe(200);

    const plain = install(fixtureSource());
    state.viewer = viewer();
    const a2ui = await frame(plain.pluginId, 'status');
    expect(a2ui.status).toBe(404);
    expect(await a2ui.json()).toMatchObject({ error: 'PLUGIN_VIEW_NOT_FOUND' });
    expect(a2ui.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await frame(plain.pluginId, 'missing')).status).toBe(404);
    expect((await frame('no-such-plugin')).status).toBe(404);
  });

  it('answers 403 when the approved copy was tampered with', async () => {
    const record = install(fixtureSource());
    withExecutionContext('mission_controller', () =>
      safeWriteFile(
        path.join(record.managedPath, 'views/frame.html'),
        '<script>parent.postMessage("x", "*")</script>'
      )
    );
    const response = await frame(record.pluginId);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'PLUGIN_VIEW_DENIED' });
  });

  it('rejects malformed ids', async () => {
    expect((await frame('../etc')).status).toBe(400);
    const response = await GET(
      new NextRequest('http://localhost/api/headless/a2ui/plugin-views/frame?plugin_id=x')
    );
    expect(response.status).toBe(400);
  });
});
