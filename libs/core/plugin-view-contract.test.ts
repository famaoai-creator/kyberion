import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import {
  decideApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
} from './approval-store.js';
import {
  installPluginManaged,
  listManagedPlugins,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  activatePlugin,
  applyPluginChange,
  deactivatePlugin,
  listOwned,
  reloadPlugin,
  resetPluginLifecycleForTests,
} from './plugin-lifecycle.js';
import {
  composePluginViewsA2UI,
  dispatchPluginViewAction,
  isPluginViewVisible,
  listPluginViewsForViewer,
  loadPluginViews,
  parsePluginViewDeclaration,
  pluginViewErrorStatus,
  PluginViewError,
  resolvePluginViewAction,
  validatePluginView,
  type LoadedPluginView,
  type PluginViewDeclaration,
  type PluginViewViewer,
} from './plugin-view-contract.js';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const FIXTURE_FILES = ['plugin-manifest.json', 'index.mjs', 'views/status.a2ui.json'];
const TMP_ROOT = pathResolver.sharedTmp('plugin-view-contract-test');
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

function readFixture(name: string): string {
  return String(safeReadFile(path.join(FIXTURE_DIR, name), { encoding: 'utf8' }));
}

function fixtureCopy(overrides: Record<string, string> = {}): string {
  const dir = tracked(path.join(TMP_ROOT, `src-${randomUUID()}`));
  for (const name of FIXTURE_FILES) {
    safeMkdir(path.dirname(path.join(dir, name)), { recursive: true });
    safeWriteFile(path.join(dir, name), overrides[name] ?? readFixture(name));
  }
  return dir;
}

function fixtureDeclaration(): PluginViewDeclaration {
  const manifest = JSON.parse(readFixture('plugin-manifest.json'));
  return parsePluginViewDeclaration(manifest.provides.views[0]);
}

function fixtureDocument(): unknown[] {
  return JSON.parse(readFixture('views/status.a2ui.json'));
}

const OPS = ['permfixture:env', 'permfixture:write'];

function expectViewError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginViewError);
    expect((error as PluginViewError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function withComponents(components: unknown[]): unknown[] {
  const doc = fixtureDocument() as Array<Record<string, any>>;
  doc[1].updateComponents.components = components;
  return doc;
}

function installApproved(
  pluginId: string,
  sourcePath: string,
  managedRoot: string,
  approve = true
): ManagedPluginRecord {
  const record = installPluginManaged({ pluginId, sourcePath, managedRoot });
  if (!approve) return record;
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

function newIds(prefix: string) {
  const id = `${process.pid}-${randomUUID()}`;
  return {
    pluginId: `${prefix}-${id}`.slice(0, 60),
    managedRoot: tracked(pathResolver.shared(`plugins/managed-test-views-${id}`)),
  };
}

const publicReader: PluginViewViewer = {
  role: 'readonly',
  tierAccess: ['public'],
  tenantSlugs: 'all',
};

describe('validatePluginView (EP-05)', () => {
  it('accepts the fixture view', () => {
    const messages = validatePluginView(fixtureDeclaration(), fixtureDocument(), {
      providedOps: OPS,
    });
    expect(messages[0].createSurface?.catalogId).toBe('kyberion-base');
    expect(messages[1].updateComponents?.components).toHaveLength(4);
  });

  it('fills defaults and rejects malformed declarations', () => {
    const decl = parsePluginViewDeclaration({
      id: 'minimal',
      titleKey: 'plugin:view_menu_label',
      document: 'views/minimal.a2ui.json',
      isolation: 'in-process-a2ui',
      roleGate: { minRole: 'readonly', tiers: ['public'] },
    });
    expect(decl).toMatchObject({ capabilities: [], actions: [], lifecycle: { refresh: 'static' } });
    expectViewError(
      () => parsePluginViewDeclaration({ ...decl, document: 'views/../index.mjs' }),
      'PLUGIN_VIEW_INVALID'
    );
    expectViewError(
      () => parsePluginViewDeclaration({ ...decl, extra: true }),
      'PLUGIN_VIEW_INVALID'
    );
  });

  it('rejects sandboxed-iframe isolation and any capability (deny by default)', () => {
    const decl = fixtureDeclaration();
    expectViewError(
      () =>
        validatePluginView({ ...decl, isolation: 'sandboxed-iframe' }, fixtureDocument(), {
          providedOps: OPS,
        }),
      'PLUGIN_VIEW_UNSUPPORTED'
    );
    expectViewError(
      () =>
        validatePluginView({ ...decl, capabilities: ['clipboard.read'] }, fixtureDocument(), {
          providedOps: OPS,
        }),
      'PLUGIN_VIEW_CAPABILITY_DENIED'
    );
  });

  it('requires action ops to be the plugin own ops and params schemas to be closed', () => {
    const decl = fixtureDeclaration();
    expectViewError(
      () => validatePluginView(decl, fixtureDocument(), { providedOps: ['permfixture:env'] }),
      'PLUGIN_VIEW_ACTION_DENIED'
    );
    const open = {
      ...decl,
      actions: [{ ...decl.actions[0], paramsSchema: { type: 'object', properties: {} } }],
    };
    expectViewError(
      () => validatePluginView(open, fixtureDocument(), { providedOps: OPS }),
      'PLUGIN_VIEW_INVALID'
    );
    const nestedOpen = {
      ...decl,
      actions: [
        {
          ...decl.actions[0],
          paramsSchema: {
            type: 'object',
            properties: { nested: { type: 'object', properties: {} } },
            additionalProperties: false,
          },
        },
      ],
    };
    expectViewError(
      () => validatePluginView(nestedOpen, fixtureDocument(), { providedOps: OPS }),
      'PLUGIN_VIEW_INVALID'
    );
  });

  it('requires every *Key to exist in the vocabulary', () => {
    const decl = fixtureDeclaration();
    expectViewError(
      () =>
        validatePluginView({ ...decl, titleKey: 'plugin:no_such_key' }, fixtureDocument(), {
          providedOps: OPS,
        }),
      'PLUGIN_VIEW_INVALID'
    );
    const doc = fixtureDocument() as Array<Record<string, any>>;
    doc[0].createSurface.titleKey = 'plugin:no_such_key';
    expectViewError(
      () => validatePluginView(decl, doc, { providedOps: OPS }),
      'PLUGIN_VIEW_INVALID'
    );
    expect(() =>
      validatePluginView(decl, fixtureDocument(), { providedOps: OPS, vocabularyHas: () => false })
    ).toThrow('does not exist in the vocabulary');
  });

  it.each([
    [
      'a non kyberion-base catalog',
      (() => {
        const doc = fixtureDocument() as Array<Record<string, any>>;
        doc[0].createSurface.catalogId = 'chronos-legacy';
        return doc;
      })(),
    ],
    ['a legacy display component', withComponents([{ id: 'x', type: 'display:hero', props: {} }])],
    [
      'an input component outside the view subset',
      withComponents([{ id: 'x', type: 'ui:secret-field', props: { name: 'k', label: 'K' } }]),
    ],
    [
      'a navigation href',
      withComponents([
        { id: 'x', type: 'ui:button', props: { label: 'Go', href: 'https://example.com' } },
      ]),
    ],
    [
      'markup in text',
      withComponents([{ id: 'x', type: 'ui:text', props: { text: '<script>alert(1)</script>' } }]),
    ],
    [
      'a javascript: URL in text',
      withComponents([{ id: 'x', type: 'ui:text', props: { text: 'javascript:alert(1)' } }]),
    ],
    [
      'an undeclared action',
      withComponents([
        { id: 'x', type: 'ui:button', props: { label: 'Do', action: { id: 'undeclared' } } },
      ]),
    ],
    [
      'an unknown child',
      withComponents([{ id: 'x', type: 'ui:stack', props: {}, children: ['missing'] }]),
    ],
    [
      'invalid catalog props',
      withComponents([{ id: 'x', type: 'ui:text', props: { text: 'hi', html: '<b>' } }]),
    ],
    [
      'a deleteSurface message',
      [...fixtureDocument(), { deleteSurface: { surfaceId: 'permfixture-status' } }],
    ],
    [
      'a mismatched surface id',
      [...fixtureDocument(), { updateDataModel: { surfaceId: 'other-surface', data: {} } }],
    ],
  ])('rejects a document with %s', (_label, document) => {
    expectViewError(
      () => validatePluginView(fixtureDeclaration(), document, { providedOps: OPS }),
      'PLUGIN_VIEW_INVALID'
    );
  });
});

describe('loadPluginViews (EP-05)', () => {
  it('loads the fixture views from a plugin directory', () => {
    const result = loadPluginViews(FIXTURE_DIR);
    expect(result.errors).toEqual([]);
    expect(result.views.map((view) => [view.pluginId, view.declaration.id])).toEqual([
      ['plugin-permissions-fixture', 'status'],
    ]);
    expect(result.views[0].providedOps).toContain('permfixture:env');
  });

  it('reports a symlinked document per view instead of following it', () => {
    const dir = fixtureCopy();
    const outside = path.join(TMP_ROOT, `outside-${randomUUID()}.json`);
    tracked(outside);
    safeWriteFile(outside, readFixture('views/status.a2ui.json'));
    withExecutionContext('mission_controller', () =>
      safeRmSync(path.join(dir, 'views/status.a2ui.json'))
    );
    safeSymlinkSync(outside, path.join(dir, 'views/status.a2ui.json'));
    const result = loadPluginViews(dir);
    expect(result.views).toEqual([]);
    expect(result.errors[0]).toMatchObject({ viewId: 'status', code: 'PLUGIN_VIEW_INVALID' });
    expect(result.errors[0].message).toContain('symlink');
  });

  it('refuses a managed record that is not activatable without reading documents', () => {
    const { pluginId, managedRoot } = newIds('views-pending');
    const pending = installApproved(pluginId, fixtureCopy(), managedRoot, false);
    expect(pending.activationStatus).toBe('pending_approval');
    expectViewError(() => loadPluginViews(pending), 'PLUGIN_VIEW_DENIED');
    let lookups = 0;
    const listed = listPluginViewsForViewer(
      [pending],
      publicReader,
      {},
      {
        vocabularyHas: () => {
          lookups += 1;
          return true;
        },
      }
    );
    expect(listed).toEqual({ views: [], errors: [] });
    expect(lookups).toBe(0);
  });
});

describe('viewer gating (EP-05)', () => {
  const view = (overrides: Partial<LoadedPluginView> = {}): LoadedPluginView => ({
    ...loadPluginViews(FIXTURE_DIR).views[0],
    ...overrides,
  });

  it('enforces minRole and the full tier set', () => {
    const adminOnly = view({
      declaration: {
        ...fixtureDeclaration(),
        roleGate: { minRole: 'localadmin', tiers: ['public'] },
      },
    });
    expect(isPluginViewVisible(adminOnly, publicReader)).toBe(false);
    expect(isPluginViewVisible(adminOnly, { ...publicReader, role: 'localadmin' })).toBe(true);
    const confidential = view({
      declaration: {
        ...fixtureDeclaration(),
        roleGate: { minRole: 'readonly', tiers: ['public', 'confidential'] },
      },
    });
    expect(isPluginViewVisible(confidential, publicReader)).toBe(false);
    const both = { ...publicReader, tierAccess: ['public', 'confidential'] };
    expect(isPluginViewVisible(confidential, both)).toBe(true);
  });

  it('lets a client filter narrow but never widen', () => {
    expect(isPluginViewVisible(view(), publicReader, { tier: 'public' })).toBe(true);
    expect(isPluginViewVisible(view(), publicReader, { tier: 'confidential' })).toBe(false);
    const tenantView = view({ tenantSlug: 'tenant-a' });
    const tenantB = { ...publicReader, tenantSlugs: ['tenant-b'] };
    expect(isPluginViewVisible(tenantView, tenantB)).toBe(false);
    expect(isPluginViewVisible(tenantView, tenantB, { tenant: 'tenant-a' })).toBe(false);
    expect(isPluginViewVisible(tenantView, publicReader, { tenant: 'tenant-b' })).toBe(false);
    expect(isPluginViewVisible(tenantView, publicReader, { tenant: 'tenant-a' })).toBe(true);
  });
});

describe('plugin view actions (EP-05)', () => {
  const fixtureView = () => loadPluginViews(FIXTURE_DIR).views[0];

  it('maps unknown actions, foreign ops and bad params to 404/403/400', () => {
    const view = fixtureView();
    const statusOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return pluginViewErrorStatus((error as PluginViewError).code);
      }
      return 200;
    };
    expect(statusOf(() => resolvePluginViewAction(view, 'nope', {}))).toBe(404);
    expect(
      statusOf(() => resolvePluginViewAction({ ...view, providedOps: [] }, 'probe_env', {}))
    ).toBe(403);
    expect(statusOf(() => resolvePluginViewAction(view, 'write_probe', { path: 1 }))).toBe(400);
    expect(statusOf(() => resolvePluginViewAction(view, 'probe_env', { extra: true }))).toBe(400);
    expect(resolvePluginViewAction(view, 'probe_env', undefined).params).toEqual({});
  });

  it('refuses an agent action when the plugin is not active in this process', async () => {
    const resolved = resolvePluginViewAction(fixtureView(), 'probe_env', {});
    await expect(
      dispatchPluginViewAction(resolved, {
        requestedBy: 'viewer',
        actorRole: 'localadmin',
        surface: 'chronos',
      })
    ).rejects.toThrow('[PLUGIN_VIEW_ACTION_UNAVAILABLE]');
  });

  it('queues a human action as a human-only approval request (idempotent)', async () => {
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const resolved = resolvePluginViewAction(fixtureView(), 'write_probe', params);
    const context = {
      requestedBy: 'viewer-1',
      actorRole: 'localadmin',
      surface: 'chronos' as const,
    };
    const first = await dispatchPluginViewAction(resolved, context);
    const second = await dispatchPluginViewAction(resolved, context);
    expect(first.status).toBe('approval_required');
    expect(second).toEqual(first);
    const id = (first as { approvalRequestId: string }).approvalRequestId;
    const record = listApprovalRequests({ storageChannels: ['chronos'] }).find(
      (entry) => entry.id === id
    );
    tracked(pathResolver.shared(`coordination/channels/chronos/approvals/requests/${id}.json`));
    expect(record).toMatchObject({
      status: 'pending',
      accountability: { finalDecision: 'human_only' },
    });
    expect(record?.accountability?.effectBinding).toBe(
      'plugin-view-action:plugin-permissions-fixture/status/write_probe'
    );
  });

  it('composes views into one surface with per-view id prefixes', () => {
    const view = fixtureView();
    const composed = composePluginViewsA2UI([view, view], (key) => `title:${key}`);
    const ids = composed.updateComponents.components.map((component) => component.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(composed.updateComponents.components[0]).toMatchObject({
      id: 'pv0-section',
      type: 'ui:section',
      props: { title: 'title:plugin:fixture_status_view_title' },
      children: ['pv0-root'],
    });
    expect(ids).toContain('pv1-probe');
  });
});

describe('plugin views e2e with the permissions fixture (EP-05/EP-06)', () => {
  it('approve -> activate -> list -> views-only change blocks until re-approval', async () => {
    const { pluginId, managedRoot } = newIds('views-e2e');
    const record = installApproved(pluginId, fixtureCopy(), managedRoot);
    const activated = await activatePlugin({ record }, { managedRoot });
    expect(activated.ok).toBe(true);
    expect(listOwned(pluginId)).toContainEqual({ category: 'views', name: `${pluginId}:status` });

    const listed = listPluginViewsForViewer(listManagedPlugins(managedRoot), publicReader);
    expect(listed.errors).toEqual([]);
    expect(listed.views.map((view) => `${view.pluginId}/${view.declaration.id}`)).toEqual([
      `${pluginId}/status`,
    ]);
    // While active in-process, an agent action dispatches the plugin's own op.
    const dispatched = await dispatchPluginViewAction(
      resolvePluginViewAction(listed.views[0], 'probe_env', {}),
      { requestedBy: 'viewer', actorRole: 'localadmin', surface: 'api' }
    );
    expect(dispatched).toEqual({ status: 'dispatched', handled: true });

    // Edit only views/ in the managed copy.
    const document = JSON.parse(readFixture('views/status.a2ui.json'));
    document[1].updateComponents.components[1].props.label = 'Edited';
    withExecutionContext('mission_controller', () =>
      safeWriteFile(
        path.join(record.managedPath, 'views/status.a2ui.json'),
        JSON.stringify(document)
      )
    );
    const [mismatched] = listManagedPlugins(managedRoot);
    expect(mismatched.activationStatus).toBe('blocked_digest_mismatch');
    // The ladder classifies it as the least disruptive rung...
    expect(
      applyPluginChange({
        before: {
          contentDigest: record.contentDigest,
          provides: { views: ['status'] },
          grant: null,
        },
        after: { contentDigest: 'changed', provides: { views: ['status'] }, grant: null },
        changedPaths: ['views/status.a2ui.json'],
      }).mode
    ).toBe('config_apply');
    // ...but the approval is bound to the content digest: the view disappears
    // and a reload keeps the previous activation until a re-approval.
    expect(listPluginViewsForViewer([mismatched], publicReader).views).toEqual([]);
    expectViewError(() => loadPluginViews(mismatched), 'PLUGIN_VIEW_DENIED');
    const blockedReload = await reloadPlugin(pluginId);
    expect(blockedReload).toMatchObject({ ok: false, rolledBack: false });
    expect(blockedReload.reason).toContain('not activatable');

    // Re-install the edited version and approve it again.
    const edited = fixtureCopy({ 'views/status.a2ui.json': JSON.stringify(document) });
    const v2 = installApproved(pluginId, edited, managedRoot);
    const relisted = listPluginViewsForViewer(listManagedPlugins(managedRoot), publicReader);
    expect(relisted.views).toHaveLength(1);
    expect(relisted.views[0].contentDigest).toBe(v2.contentDigest);
    // reloadPlugin does not know which paths changed, so it re-imports.
    const reloaded = await reloadPlugin(pluginId);
    expect(reloaded).toMatchObject({ ok: true, mode: 'plugin_reload' });

    expect(deactivatePlugin(pluginId).ok).toBe(true);
    expect(listOwned(pluginId)).toEqual([]);
  });
});
