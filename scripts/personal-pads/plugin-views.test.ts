import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Pass-through spy: records every file read / directory walk so tests can prove
// which managed copies were read.
const secureIoReads = vi.hoisted(() => [] as string[]);
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  const safeReadFile = ((...args: Parameters<typeof actual.safeReadFile>) => {
    secureIoReads.push(String(args[0]));
    return actual.safeReadFile(...args);
  }) as typeof actual.safeReadFile;
  const safeReaddir = ((...args: Parameters<typeof actual.safeReaddir>) => {
    secureIoReads.push(String(args[0]));
    return actual.safeReaddir(...args);
  }) as typeof actual.safeReaddir;
  return { ...actual, safeReadFile, safeReaddir };
});

import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from '@agent/core/plugin-managed-install';
import { isPluginActive, resetPluginLifecycleForTests } from '@agent/core/plugin-lifecycle';
import { createPluginHost, type PluginHost } from '@agent/core/plugin-host';
import { PluginViewError } from '@agent/core/plugin-view-contract';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import type { AddressInfo } from 'node:net';
import { createLocalPadContext } from '../lib/local-artifact-pad.js';
import { createPersonalPadsServer } from './server.js';
import { PERSONAL_PADS_SURFACE } from './surface.js';
import {
  ensurePadsPluginHost,
  getPadPluginViews,
  padPluginViewViewer,
  PERSONAL_PADS_HUMAN_ACTION_KEY,
  pluginViewErrorMessageKey,
  runPadPluginViewAction,
} from './plugin-views.js';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const TMP_ROOT = pathResolver.sharedTmp('personal-pads-plugin-views-test');
const cleanupPaths: string[] = [];

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

afterEach(() => {
  resetPluginLifecycleForTests();
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) safeRmSync(cleanupPaths.pop() as string);
  });
});

afterAll(() => {
  withExecutionContext('mission_controller', () => safeRmSync(TMP_ROOT));
});

interface FixtureView {
  roleGate: { tiers: string[] };
}

function fixtureSource(viewTiers?: string[]): string {
  const src = tracked(path.join(TMP_ROOT, `src-${randomUUID()}`));
  safeMkdir(path.join(src, 'views'), { recursive: true });
  for (const name of [
    'plugin-manifest.json',
    'index.mjs',
    'views/status.a2ui.json',
    'views/frame.html',
  ]) {
    safeWriteFile(
      path.join(src, name),
      safeReadFile(path.join(FIXTURE_DIR, name), { encoding: 'utf8' }) as string
    );
  }
  if (viewTiers) {
    const manifestPath = path.join(src, 'plugin-manifest.json');
    const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string) as {
      provides: { views: FixtureView[] };
    };
    for (const view of manifest.provides.views) view.roleGate.tiers = viewTiers;
    safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return src;
}

function install(
  pluginId: string,
  managedRoot: string,
  options: { tenantSlug?: string; viewTiers?: string[] } = {}
): ManagedPluginRecord {
  const record = installPluginManaged({
    pluginId,
    sourcePath: fixtureSource(options.viewTiers),
    managedRoot,
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
  const refreshed = refreshManagedPluginActivation(pluginId, managedRoot);
  expect(refreshed?.activationStatus).toBe('activatable');
  return refreshed as ManagedPluginRecord;
}

function newRoot(): { managedRoot: string; id: (prefix: string) => string } {
  const suffix = `${process.pid}-${randomUUID()}`;
  return {
    managedRoot: tracked(pathResolver.sharedTmp(`plugins/managed-test-pads-${suffix}`)),
    id: (prefix) => `${prefix}-${suffix}`.slice(0, 60),
  };
}

function padContext(tier: 'public' | 'confidential' | 'personal', tenant?: string) {
  return createLocalPadContext({
    serviceId: 'personal-pads',
    sessionPrefix: 'plugin-views-test',
    artifact_ref: 'local-pads',
    viewer_principal: 'human:alice',
    tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
  });
}

function testHost(managedRoot: string, tenantAllow: string[] = []): PluginHost {
  return createPluginHost({
    surface: `pads-test-${randomUUID()}`,
    managedRoot,
    tenantAllow,
    timers: { setInterval: () => undefined, clearInterval: () => undefined },
    audit: () => undefined,
  });
}

describe('personal pads plugin views (PH-03)', () => {
  it('uses a read-only viewer of the request tier and the server tenant only', () => {
    expect(padPluginViewViewer(padContext('confidential', 'tenant-a'))).toEqual({
      role: 'readonly',
      tierAccess: ['confidential'],
      tenantSlugs: ['tenant-a'],
    });
    expect(padPluginViewViewer(padContext('public'))).toEqual({
      role: 'readonly',
      tierAccess: ['public'],
      tenantSlugs: [],
    });
  });

  it('strips action references and reports iframe views as unsupported', () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('pads-views'), managedRoot);
    const result = getPadPluginViews(padContext('public'), 'en', { managedRoot });
    expect(result.views).toEqual([
      { plugin_id: record.pluginId, view_id: 'status', title: expect.any(String) },
    ]);
    expect(result.errors).toEqual([
      { plugin_id: record.pluginId, view_id: 'status_frame', code: 'PLUGIN_VIEW_UNSUPPORTED' },
    ]);
    const { surfaceId, components } = result.a2ui.updateComponents;
    expect(surfaceId).toBe('personal-pads.plugin-views');
    expect(components.map((component) => component.type)).toContain('ui:button');
    expect(JSON.stringify(components)).not.toMatch(/"action"|probe_env/u);
  });

  it('hides views of a tier the request scope was narrowed away from', () => {
    const { managedRoot, id } = newRoot();
    install(id('pads-conf'), managedRoot, { viewTiers: ['confidential'] });
    const confidential = getPadPluginViews(padContext('confidential', 'tenant-a'), 'en', {
      managedRoot,
    });
    expect(confidential.views.map((view) => view.view_id)).toEqual(['status']);
    const narrowed = getPadPluginViews(padContext('public', 'tenant-a'), 'en', { managedRoot });
    expect(narrowed.views).toEqual([]);
    expect(narrowed.a2ui.updateComponents.components).toEqual([]);
  });

  it('never reads the managed copies of other tenants', () => {
    const { managedRoot, id } = newRoot();
    const own = install(id('pads-own'), managedRoot, { tenantSlug: 'tenant-a' });
    const foreign = install(id('pads-foreign'), managedRoot, { tenantSlug: 'tenant-b' });
    secureIoReads.length = 0;
    const result = getPadPluginViews(padContext('public', 'tenant-a'), 'en', { managedRoot });
    const inside = (dir: string) => (p: string) => p === dir || p.startsWith(`${dir}${path.sep}`);
    expect(secureIoReads.filter(inside(foreign.managedPath))).toEqual([]);
    expect(secureIoReads.some(inside(own.managedPath))).toBe(true);
    expect(result.views.map((view) => view.plugin_id)).toEqual([own.pluginId]);
  });
});

describe('personal pads plugin view actions (PH-03b)', () => {
  it('refuses human-authority actions with the Chronos message key', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('pads-human'), managedRoot);
    const error = await runPadPluginViewAction(
      padContext('public'),
      {
        plugin_id: record.pluginId,
        view_id: 'status',
        action_id: 'write_probe',
        params: { path: 'x' },
      },
      testHost(managedRoot),
      { managedRoot }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginViewError);
    expect((error as PluginViewError).code).toBe('PLUGIN_VIEW_ACTION_DENIED');
    expect(pluginViewErrorMessageKey(error as PluginViewError)).toBe(
      PERSONAL_PADS_HUMAN_ACTION_KEY
    );
  });

  it('reports agent actions unavailable without a host and dispatches them with one', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('pads-agent'), managedRoot);
    const input = { plugin_id: record.pluginId, view_id: 'status', action_id: 'probe_env' };
    const unavailable = await runPadPluginViewAction(padContext('public'), input, null, {
      managedRoot,
    }).catch((caught: unknown) => caught);
    expect((unavailable as PluginViewError).code).toBe('PLUGIN_VIEW_ACTION_UNAVAILABLE');
    expect(isPluginActive(record.pluginId)).toBe(false);

    const outcome = await runPadPluginViewAction(
      padContext('public'),
      input,
      testHost(managedRoot),
      { managedRoot }
    );
    expect(outcome).toEqual({ status: 'dispatched', handled: true });
    expect(isPluginActive(record.pluginId)).toBe(true);
  });

  it('creates no host unless KYBERION_PERSONAL_PADS_PLUGIN_HOST is on', () => {
    const create = vi.fn(createPluginHost);
    expect(ensurePadsPluginHost(padContext('public'), { env: {}, create })).toBeNull();
    expect(
      ensurePadsPluginHost(padContext('public'), {
        env: { KYBERION_PERSONAL_PADS_PLUGIN_HOST: '0' },
        create,
      })
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('personal pads plugin view transport (PH-03 / PH-03b)', () => {
  async function withServer(
    managedRoot: string,
    host: PluginHost | null,
    run: (
      request: (path: string, init?: RequestInit & { token?: string }) => Promise<Response>
    ) => Promise<void>
  ) {
    const surface = {
      ...PERSONAL_PADS_SURFACE,
      getPluginViews: (context: Parameters<typeof getPadPluginViews>[0], locale?: 'en' | 'ja') =>
        getPadPluginViews(context, locale, { managedRoot }),
    };
    const server = createPersonalPadsServer(
      padContext('public'),
      pathResolver.sharedTmp('personal-pads-plugin-views-test/storage'),
      'tok',
      surface,
      { pluginHost: () => host, managedRoot }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await run((urlPath, init = {}) => {
        const { token = 'tok', ...rest } = init;
        return fetch(`http://127.0.0.1:${port}${urlPath}`, {
          ...rest,
          headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-pads-token': token } : {}),
          },
        });
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('lists views only with the desk token', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('pads-http'), managedRoot);
    await withServer(managedRoot, null, async (request) => {
      expect((await request('/api/plugin-views', { token: '' })).status).toBe(403);
      const listed = await request('/api/plugin-views?lang=en');
      expect(listed.status).toBe(200);
      const payload = (await listed.json()) as { views: Array<{ plugin_id: string }> };
      expect(payload.views.map((view) => view.plugin_id)).toEqual([record.pluginId]);
    });
  });

  it('answers 403 for human actions, 409 without a host and dispatches agent actions', async () => {
    const { managedRoot, id } = newRoot();
    const record = install(id('pads-http-act'), managedRoot);
    const post = (body: Record<string, unknown>) => ({
      method: 'POST',
      body: JSON.stringify({ plugin_id: record.pluginId, view_id: 'status', ...body }),
    });
    await withServer(managedRoot, null, async (request) => {
      expect(
        (
          await request('/api/plugin-views/action', {
            ...post({ action_id: 'probe_env' }),
            token: '',
          })
        ).status
      ).toBe(403);
      const human = await request(
        '/api/plugin-views/action?lang=en',
        post({ action_id: 'write_probe', params: { path: 'x' } })
      );
      expect(human.status).toBe(403);
      expect(await human.json()).toMatchObject({
        code: 'PLUGIN_VIEW_ACTION_DENIED',
        message_key: PERSONAL_PADS_HUMAN_ACTION_KEY,
      });
      const noHost = await request('/api/plugin-views/action', post({ action_id: 'probe_env' }));
      expect(noHost.status).toBe(409);
      expect(await noHost.json()).toMatchObject({
        message_key: 'plugin:view_action_host_disabled',
      });
    });
    await withServer(managedRoot, testHost(managedRoot), async (request) => {
      const dispatched = await request(
        '/api/plugin-views/action',
        post({ action_id: 'probe_env' })
      );
      expect(dispatched.status).toBe(200);
      expect(await dispatched.json()).toMatchObject({
        outcome: { status: 'dispatched', handled: true },
      });
    });
  });
});
