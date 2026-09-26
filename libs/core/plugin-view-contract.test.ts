import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Third-party fs ceiling override (narrows the next install's grant). */
  thirdPartyFs: null as Record<string, unknown> | null,
  failApplyResult: false,
}));

vi.mock('./plugin-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugin-permissions.js')>();
  return {
    ...actual,
    loadPluginPermissionPolicy: (policyPath?: string) => {
      const base = actual.loadPluginPermissionPolicy(policyPath);
      if (!mocks.thirdPartyFs) return base;
      return {
        ...base,
        ceilings: {
          ...base.ceilings,
          'third-party': { ...base.ceilings['third-party'], fs: mocks.thirdPartyFs },
        },
      };
    },
  };
});

vi.mock('./approval-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./approval-store.js')>();
  return {
    ...actual,
    recordApprovalApplyResult: (...args: Parameters<typeof actual.recordApprovalApplyResult>) => {
      if (mocks.failApplyResult) throw new Error('approval store unavailable');
      return actual.recordApprovalApplyResult(...args);
    },
  };
});
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import type { A2UIMessage } from './a2ui.js';
import { findPluginManifestFor } from './plugin-grant-runtime.js';
import { auditChain, type AuditEntry } from './audit-chain.js';
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
import { registerOpPreflightListener } from './op-preflight.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
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
  executeApprovedPluginViewAction,
  isPluginViewVisible,
  listPluginViewActionRequests,
  MAX_SCANNED_PLUGIN_VIEW_ACTION_REQUESTS,
  PLUGIN_VIEW_ACTION_APPROVAL_TTL_MS,
  PLUGIN_VIEW_ACTION_REQUEST_RETENTION_MS,
  prunePluginViewActionRequests,
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

const ACTION_DIR = pathResolver.shared('coordination/channels/chronos/plugin-view-actions');
const trackedActionIds: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLifecycleForTests();
  mocks.thirdPartyFs = null;
  mocks.failApplyResult = false;
  withExecutionContext('mission_controller', () => {
    // Sidecars are named `<request time>-<approval id>.json`.
    const ids = trackedActionIds.splice(0);
    if (ids.length > 0 && safeExistsSync(ACTION_DIR)) {
      for (const entry of safeReaddir(ACTION_DIR)) {
        if (ids.some((id) => entry.endsWith(`-${id}.json`))) {
          safeRmSync(path.join(ACTION_DIR, entry));
        }
      }
    }
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
  const doc = fixtureDocument() as A2UIMessage[];
  doc[1].updateComponents!.components = components;
  return doc;
}

function installApproved(
  pluginId: string,
  sourcePath: string,
  managedRoot: string,
  approve = true,
  tenantSlug?: string
): ManagedPluginRecord {
  const record = installPluginManaged({
    pluginId,
    sourcePath,
    managedRoot,
    ...(tenantSlug ? { tenantSlug } : {}),
  });
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

function trackActionRequest(id: string): void {
  tracked(pathResolver.shared(`coordination/channels/chronos/approvals/requests/${id}.json`));
  trackedActionIds.push(id);
  tracked(
    pathResolver.shared(`coordination/channels/chronos/plugin-view-actions/${id}.claim.json`)
  );
}

function approveActionRequest(id: string, decidedBy = 'human:approver'): void {
  const pending = loadApprovalRequest('chronos', id);
  decideApprovalRequest('mission_controller', {
    channel: 'chronos',
    requestId: id,
    decision: 'approved',
    decidedBy,
    decidedByType: 'human',
    authenticated: true,
    payloadHash: pending?.accountability?.payloadHash,
    effectBinding: pending?.accountability?.effectBinding,
  });
}

async function expectViewErrorAsync(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(PluginViewError);
  expect((error as PluginViewError).code).toBe(code);
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
    const doc = fixtureDocument() as A2UIMessage[];
    doc[0].createSurface!.titleKey = 'plugin:no_such_key';
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
        const doc = fixtureDocument() as A2UIMessage[];
        doc[0].createSurface!.catalogId = 'chronos-legacy';
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
    [
      'a closing tag with whitespace',
      withComponents([{ id: 'x', type: 'ui:text', props: { text: 'x < / IFRAME >' } }]),
    ],
  ])('rejects a document with %s', (_label, document) => {
    expectViewError(
      () => validatePluginView(fixtureDeclaration(), document, { providedOps: OPS }),
      'PLUGIN_VIEW_INVALID'
    );
  });
});

describe('plugin view markup scan', () => {
  it('accepts comparison text and stays linear on hostile input', () => {
    const text = (value: string) =>
      withComponents([{ id: 'x', type: 'ui:text', props: { text: value } }]);
    expect(() =>
      validatePluginView(fixtureDeclaration(), text('a < b and <abbr> tags'), { providedOps: OPS })
    ).not.toThrow();
    const hostile = `<${'\t'.repeat(7_990)}x`;
    const started = performance.now();
    expect(() =>
      validatePluginView(fixtureDeclaration(), text(hostile), { providedOps: OPS })
    ).not.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
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

  it('reads the Claude Code manifest location with the shared precedence', () => {
    const dir = fixtureCopy();
    const manifest = readFixture('plugin-manifest.json');
    safeRmSync(path.join(dir, 'plugin-manifest.json'));
    safeMkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    safeWriteFile(path.join(dir, '.claude-plugin/plugin.json'), manifest);
    expect(loadPluginViews(dir).views.map((view) => view.declaration.id)).toEqual(['status']);

    // With two candidates every reader picks the same one (installs refuse this).
    safeWriteFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ ...JSON.parse(manifest), plugin_id: 'portable-shadow' })
    );
    const views = loadPluginViews(dir).views;
    expect(views[0]?.pluginId).toBe('plugin-permissions-fixture');
    expect(findPluginManifestFor(path.join(dir, 'index.mjs'))?.path).toBe(
      path.join(dir, '.claude-plugin/plugin.json')
    );
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
    trackActionRequest(id);
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
    // and a reload deactivates the plugin until a re-approval.
    expect(listPluginViewsForViewer([mismatched], publicReader).views).toEqual([]);
    expectViewError(() => loadPluginViews(mismatched), 'PLUGIN_VIEW_DENIED');
    const blockedReload = await reloadPlugin(pluginId);
    expect(blockedReload).toMatchObject({ ok: false, rolledBack: false });
    expect(blockedReload.reason).toContain('no longer activatable');
    expect(listOwned(pluginId)).toEqual([]);

    // Re-install the edited version and approve it again.
    const edited = fixtureCopy({ 'views/status.a2ui.json': JSON.stringify(document) });
    const v2 = installApproved(pluginId, edited, managedRoot);
    const relisted = listPluginViewsForViewer(listManagedPlugins(managedRoot), publicReader);
    expect(relisted.views).toHaveLength(1);
    expect(relisted.views[0].contentDigest).toBe(v2.contentDigest);
    // The deactivated plugin is activated again from the re-approved copy.
    const reloaded = await reloadPlugin(pluginId, { managedRoot });
    expect(reloaded).toMatchObject({ ok: true, mode: 'plugin_reload' });

    expect(deactivatePlugin(pluginId).ok).toBe(true);
    expect(listOwned(pluginId)).toEqual([]);
  });
});

describe('approved human view actions (FU-02)', () => {
  const executor = { executedBy: 'viewer-2', actorRole: 'localadmin', surface: 'api' as const };
  const requester = { requestedBy: 'viewer-1', actorRole: 'localadmin', surface: 'api' as const };

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

  function auditedExecutions(audit: ReturnType<typeof spyAudit>) {
    return audit.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action.startsWith('plugin_view.action.'));
  }

  async function activeFixture(prefix: string, tenantSlug?: string) {
    const { pluginId, managedRoot } = newIds(prefix);
    const record = installApproved(pluginId, fixtureCopy(), managedRoot, true, tenantSlug);
    expect((await activatePlugin({ record }, { managedRoot })).ok).toBe(true);
    const view = () =>
      listPluginViewsForViewer(listManagedPlugins(managedRoot), publicReader).views[0];
    return { pluginId, managedRoot, record, view };
  }

  async function queue(view: LoadedPluginView, params: Record<string, unknown>): Promise<string> {
    const outcome = await dispatchPluginViewAction(
      resolvePluginViewAction(view, 'write_probe', params),
      requester
    );
    expect(outcome.status).toBe('approval_required');
    const id = (outcome as { approvalRequestId: string }).approvalRequestId;
    trackActionRequest(id);
    return id;
  }

  it('runs an approved action exactly once and audits the outcome', async () => {
    const audit = vi.spyOn(auditChain, 'record').mockImplementation(
      (entry) =>
        ({
          ...entry,
          id: 'audit',
          timestamp: '',
          previousHash: '',
          currentHash: '',
        }) as AuditEntry
    );
    const { view } = await activeFixture('views-exec');
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    const resolved = () => resolvePluginViewAction(view(), 'write_probe', params);

    // Not yet approved: refused without spending the approval.
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(resolved(), id, executor),
      'PLUGIN_VIEW_APPROVAL_REQUIRED'
    );
    expect(listPluginViewActionRequests([view()])).toMatchObject([
      { approvalRequestId: id, status: 'pending', params, executable: false },
    ]);

    approveActionRequest(id);
    // Changed params can never reuse the approval.
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(
        resolvePluginViewAction(view(), 'write_probe', { path: 'active/shared/tmp/other' }),
        id,
        executor
      ),
      'PLUGIN_VIEW_APPROVAL_MISMATCH'
    );
    // Expired approvals are refused.
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(resolved(), id, {
        ...executor,
        now: Date.now() + PLUGIN_VIEW_ACTION_APPROVAL_TTL_MS + 1000,
      }),
      'PLUGIN_VIEW_APPROVAL_REQUIRED'
    );
    expect(listPluginViewActionRequests([view()])[0]).toMatchObject({
      status: 'approved',
      executable: true,
    });

    const executed = await executeApprovedPluginViewAction(resolved(), id, executor);
    expect(executed).toEqual({ status: 'executed', handled: true, approvalRequestId: id });
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(resolved(), id, executor),
      'PLUGIN_VIEW_APPROVAL_CONSUMED'
    );
    expect(loadApprovalRequest('chronos', id)?.applyResult).toMatchObject({
      appliedBy: 'viewer-2',
      result: 'success',
    });
    expect(listPluginViewActionRequests([view()])[0].status).toBe('executed');

    const executions = audit.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action === 'plugin_view.action.execute');
    expect(executions.map((entry) => entry.result)).toEqual([
      'denied',
      'denied',
      'denied',
      'completed',
      'denied',
    ]);
    expect(executions[3]).toMatchObject({
      agentId: 'viewer-2',
      operation: 'permfixture:write',
      correlationId: id,
      metadata: {
        approval_request_id: id,
        requested_by: 'viewer-1',
        approved_by: 'human:approver',
        self_approved: false,
      },
    });
    // The claim is audited before the handler runs.
    const all = auditedExecutions(audit);
    const started = all.findIndex((entry) => entry.action === 'plugin_view.action.started');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(all[started + 1]).toMatchObject({ result: 'completed' });
  });

  it('refuses an approval after the plugin is reinstalled with different content', async () => {
    vi.spyOn(auditChain, 'record').mockImplementation(
      (entry) =>
        ({ ...entry, id: 'audit', timestamp: '', previousHash: '', currentHash: '' }) as AuditEntry
    );
    const { pluginId, managedRoot, view } = await activeFixture('views-exec-digest');
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id);

    const document = JSON.parse(readFixture('views/status.a2ui.json'));
    document[1].updateComponents.components[1].props.label = 'Reinstalled';
    installApproved(
      pluginId,
      fixtureCopy({ 'views/status.a2ui.json': JSON.stringify(document) }),
      managedRoot
    );
    expect(listPluginViewActionRequests([view()])[0].status).toBe('stale');
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(
        resolvePluginViewAction(view(), 'write_probe', params),
        id,
        executor
      ),
      'PLUGIN_VIEW_APPROVAL_MISMATCH'
    );
    expect(loadApprovalRequest('chronos', id)?.applyResult).toBeUndefined();
  });

  it('refuses to execute while the running module is not the approved copy', async () => {
    vi.spyOn(auditChain, 'record').mockImplementation(
      (entry) =>
        ({ ...entry, id: 'audit', timestamp: '', previousHash: '', currentHash: '' }) as AuditEntry
    );
    const { pluginId, managedRoot, view } = await activeFixture('views-exec-stale-module');
    // Re-approved new content on disk, but the old module is still the active one.
    const document = JSON.parse(readFixture('views/status.a2ui.json'));
    document[1].updateComponents.components[1].props.label = 'Re-approved';
    installApproved(
      pluginId,
      fixtureCopy({ 'views/status.a2ui.json': JSON.stringify(document) }),
      managedRoot
    );
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id);
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(
        resolvePluginViewAction(view(), 'write_probe', params),
        id,
        executor
      ),
      'PLUGIN_VIEW_ACTION_UNAVAILABLE'
    );
    expect(listPluginViewActionRequests([view()])[0].status).toBe('approved');
  });

  it('keeps the approval when the plugin is not active and refuses agent actions', async () => {
    const audit = spyAudit();
    const view = loadPluginViews(FIXTURE_DIR).views[0];
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view, params);
    approveActionRequest(id);
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(
        resolvePluginViewAction(view, 'write_probe', params),
        id,
        executor
      ),
      'PLUGIN_VIEW_ACTION_UNAVAILABLE'
    );
    expect(listPluginViewActionRequests([view])[0]).toMatchObject({
      status: 'approved',
      executable: false,
      unavailableReason: 'PLUGIN_VIEW_ACTION_UNAVAILABLE',
    });
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(resolvePluginViewAction(view, 'probe_env', {}), id, executor),
      'PLUGIN_VIEW_ACTION_DENIED'
    );
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(
        resolvePluginViewAction(view, 'write_probe', params),
        '00000000-0000-4000-8000-000000000000',
        executor
      ),
      'PLUGIN_VIEW_NOT_FOUND'
    );
    // Unavailable op and unknown approval are audited refusals.
    expect(
      auditedExecutions(audit).map((entry) => [entry.result, entry.reason.slice(0, 32)])
    ).toEqual([
      ['denied', '[PLUGIN_VIEW_ACTION_UNAVAILABLE]'],
      ['denied', '[PLUGIN_VIEW_NOT_FOUND] approval'],
    ]);
  });

  it('refuses when op preflight rewrites or blocks the approved params (audited)', async () => {
    const audit = spyAudit();
    const { view } = await activeFixture('views-exec-preflight');
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id);
    const resolved = () => resolvePluginViewAction(view(), 'write_probe', params);

    const rewrite = registerOpPreflightListener({
      id: `fu02-rewrite-${randomUUID()}`,
      run: (call) =>
        call.op === 'permfixture:write' ? { repaired_input: { path: 'knowledge/x' } } : undefined,
    });
    try {
      await expectViewErrorAsync(
        executeApprovedPluginViewAction(resolved(), id, executor),
        'PLUGIN_VIEW_APPROVAL_MISMATCH'
      );
    } finally {
      rewrite();
    }
    const block = registerOpPreflightListener({
      id: `fu02-block-${randomUUID()}`,
      run: (call) =>
        call.op === 'permfixture:write' ? { decision: 'block', reason: 'nope' } : undefined,
    });
    try {
      await expectViewErrorAsync(
        executeApprovedPluginViewAction(resolved(), id, executor),
        'PLUGIN_VIEW_ACTION_DENIED'
      );
    } finally {
      block();
    }
    // Neither refusal spent the approval.
    expect(listPluginViewActionRequests([view()])[0].status).toBe('approved');
    expect(auditedExecutions(audit).map((entry) => entry.result)).toEqual(['denied', 'denied']);
    expect((await executeApprovedPluginViewAction(resolved(), id, executor)).status).toBe(
      'executed'
    );
  });

  it('refuses in-place param changes by preflight listeners without touching the submitted params (N1)', async () => {
    spyAudit();
    const { view } = await activeFixture('views-exec-inplace');
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id);
    const resolved = resolvePluginViewAction(view(), 'write_probe', params);
    const submitted = resolved.params;
    const mutate = registerOpPreflightListener({
      id: `fu02-inplace-${randomUUID()}`,
      run: (call) => {
        if (call.op === 'permfixture:write') {
          (call.params as Record<string, unknown>).path = 'knowledge/confidential/x';
        }
        return undefined;
      },
    });
    try {
      await expectViewErrorAsync(
        executeApprovedPluginViewAction(resolved, id, executor),
        'PLUGIN_VIEW_APPROVAL_MISMATCH'
      );
    } finally {
      mutate();
    }
    // The listener only ever saw a detached copy, and the approval is not spent.
    expect(submitted).toEqual(params);
    expect(listPluginViewActionRequests([view()])[0].status).toBe('approved');
  });

  it('refuses while the running module does not run under the approved grant', async () => {
    spyAudit();
    const { pluginId, managedRoot, record, view } = await activeFixture('views-exec-grant');
    // Same content re-approved with a narrower grant; the module is not reloaded.
    mocks.thirdPartyFs = { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] };
    const narrowed = installApproved(pluginId, fixtureCopy(), managedRoot);
    expect(narrowed.contentDigest).toBe(record.contentDigest);
    expect(narrowed.permissionsDigest).not.toBe(record.permissionsDigest);
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id);
    const resolved = () => resolvePluginViewAction(view(), 'write_probe', params);

    expect(listPluginViewActionRequests([view()])[0]).toMatchObject({
      status: 'approved',
      executable: false,
      unavailableReason: 'PLUGIN_VIEW_ACTION_UNAVAILABLE',
    });
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(resolved(), id, executor),
      'PLUGIN_VIEW_ACTION_UNAVAILABLE'
    );
    // Narrowing in place (config_apply) makes the approved grant the running one.
    expect(await reloadPlugin(pluginId, { managedRoot })).toMatchObject({
      ok: true,
      mode: 'config_apply',
    });
    expect(listPluginViewActionRequests([view()])[0].executable).toBe(true);
    const error = await executeApprovedPluginViewAction(resolved(), id, executor).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).not.toBeInstanceOf(PluginViewError);
  });

  it('binds the approval to the tenant of the install', async () => {
    spyAudit();
    const { pluginId, managedRoot, view } = await activeFixture('views-exec-tenant', 'tenant-a');
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id);
    expect(view().tenantSlug).toBe('tenant-a');
    expect(listPluginViewActionRequests([view()])).toHaveLength(1);

    // Same content and grant, reinstalled for another tenant.
    installApproved(pluginId, fixtureCopy(), managedRoot, true, 'tenant-b');
    expect(view().tenantSlug).toBe('tenant-b');
    expect(listPluginViewActionRequests([view()])).toEqual([]);
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(
        resolvePluginViewAction(view(), 'write_probe', params),
        id,
        executor
      ),
      'PLUGIN_VIEW_APPROVAL_MISMATCH'
    );
  });

  it('reports a claim without a recorded result as unknown, not as a failure', async () => {
    const audit = spyAudit();
    const { view } = await activeFixture('views-exec-record-fail');
    const params = { path: `active/shared/tmp/${randomUUID()}` };
    const id = await queue(view(), params);
    approveActionRequest(id, 'human:viewer-2');
    const resolved = () => resolvePluginViewAction(view(), 'write_probe', params);

    mocks.failApplyResult = true;
    const outcome = await executeApprovedPluginViewAction(resolved(), id, executor);
    expect(outcome).toMatchObject({ status: 'executed', approvalRequestId: id });
    expect(loadApprovalRequest('chronos', id)?.applyResult).toBeUndefined();
    expect(listPluginViewActionRequests([view()])[0]).toMatchObject({
      status: 'unknown',
      executable: false,
    });
    await expectViewErrorAsync(
      executeApprovedPluginViewAction(resolved(), id, executor),
      'PLUGIN_VIEW_APPROVAL_CONSUMED'
    );
    const entries = auditedExecutions(audit);
    expect(entries.map((entry) => [entry.action, entry.result])).toEqual([
      ['plugin_view.action.started', 'allowed'],
      ['plugin_view.action.execute', 'completed'],
      ['plugin_view.action.execute', 'denied'],
    ]);
    // The approver executed it: allowed, but recorded as self-approval.
    expect(entries[1].metadata).toMatchObject({ self_approved: true });
  });

  it('scans only the newest sidecars and prunes old terminal ones', async () => {
    expect(MAX_SCANNED_PLUGIN_VIEW_ACTION_REQUESTS).toBe(200);
    const view = loadPluginViews(FIXTURE_DIR).views[0];
    const id = await queue(view, { path: `active/shared/tmp/${randomUUID()}` });
    expect(listPluginViewActionRequests([view], { maxScanned: 3 })).toHaveLength(1);

    // Newer (future-dated) sidecars fill the scan window.
    const junk = [0, 1, 2].map((index) => `900000000000000-fu02-junk-${randomUUID()}-${index}`);
    withExecutionContext('mission_controller', () => {
      for (const name of junk) safeWriteFile(path.join(ACTION_DIR, `${name}.json`), '{}');
    });
    junk.forEach((name) => tracked(path.join(ACTION_DIR, `${name}.json`)));
    expect(listPluginViewActionRequests([view], { maxScanned: 3 })).toEqual([]);
    expect(listPluginViewActionRequests([view], { maxScanned: 4 })).toHaveLength(1);

    // An old sidecar whose approval is gone is pruned; the live request is kept.
    const staleId = randomUUID();
    const stale = path.join(ACTION_DIR, `000000000000001-${staleId}.json`);
    // A tampered sidecar whose content names another id is never pruned by it.
    const tampered = path.join(ACTION_DIR, `000000000000002-${randomUUID()}.json`);
    withExecutionContext('mission_controller', () => {
      safeWriteFile(stale, JSON.stringify({ approval_request_id: staleId }));
      safeWriteFile(tampered, JSON.stringify({ approval_request_id: '../../../x' }));
    });
    tracked(stale);
    tracked(tampered);
    // Claimed without a recorded result (outcome unknown): kept for the operator.
    const unknownId = randomUUID();
    const unknown = path.join(ACTION_DIR, `000000000000003-${unknownId}.json`);
    const unknownClaim = path.join(ACTION_DIR, `${unknownId}.claim.json`);
    withExecutionContext('mission_controller', () => {
      safeWriteFile(unknown, JSON.stringify({ approval_request_id: unknownId }));
      safeWriteFile(unknownClaim, '{}');
    });
    tracked(unknown);
    tracked(unknownClaim);
    expect(PLUGIN_VIEW_ACTION_REQUEST_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(prunePluginViewActionRequests()).toBeGreaterThanOrEqual(1);
    expect(safeExistsSync(stale)).toBe(false);
    expect(safeExistsSync(tampered)).toBe(true);
    expect(safeExistsSync(unknown)).toBe(true);
    expect(safeExistsSync(unknownClaim)).toBe(true);
    expect(listPluginViewActionRequests([view], { maxScanned: 4 })).toMatchObject([
      { approvalRequestId: id },
    ]);
  });
});
