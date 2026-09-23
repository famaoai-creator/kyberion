import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  validateUrl,
} from './secure-io.js';
import {
  listPluginActuatorOperations,
  resolveActuatorOperation,
  type ActuatorOperationHandler,
} from './actuator-op-registry.js';
import { runOpPreflight } from './op-preflight.js';
import { getSecret } from './secret-guard.js';
import { getPluginEnv } from './plugin-grant-runtime.js';
import { getPluginExecutionContext } from './sandbox-policy.js';
import type { PluginPermissionGrant } from './plugin-permissions.js';
import {
  activatePlugin,
  applyPluginChange,
  deactivatePlugin,
  disposeContribution,
  isPluginActive,
  listOwned,
  ownerOf,
  reloadPlugin,
  resetPluginLifecycleForTests,
  type PluginChangeSnapshot,
} from './plugin-lifecycle.js';

const FIXTURE_DIR = pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture');
const cleanupPaths: string[] = [];

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

afterAll(() => {
  withExecutionContext('mission_controller', () =>
    safeRmSync(pathResolver.sharedTmp('plugin-lifecycle-test'))
  );
});

afterEach(() => {
  resetPluginLifecycleForTests();
  vi.unstubAllEnvs();
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) safeRmSync(cleanupPaths.pop() as string);
  });
});

function fixtureSource(indexOverride?: string): string {
  const src = tracked(pathResolver.sharedTmp(`plugin-lifecycle-test/src-${randomUUID()}`));
  safeMkdir(src, { recursive: true });
  for (const name of ['plugin-manifest.json', 'index.mjs']) {
    safeWriteFile(
      path.join(src, name),
      safeReadFile(path.join(FIXTURE_DIR, name), { encoding: 'utf8' }) as string
    );
  }
  if (indexOverride !== undefined) safeWriteFile(path.join(src, 'index.mjs'), indexOverride);
  return src;
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
    managedRoot: tracked(pathResolver.shared(`plugins/managed-test-lifecycle-${id}`)),
  };
}

async function runOp(action: string, params: Record<string, unknown>, probe: object) {
  const handler = resolveActuatorOperation('permfixture', action)
    ?.handler as ActuatorOperationHandler;
  const { ctx } = await handler(action, params, { probe }, 'apply');
  return ctx.result;
}

const probe = {
  write: (target: string) => safeWriteFile(target, 'x'),
  fetch: (url: string) => validateUrl(url),
  invoke: async (op: string) =>
    (await runOpPreflight({ op, params: {}, source: 'pipeline' })).decision,
  secret: (key: string) => getSecret(key),
  env: () => getPluginEnv(),
};

describe('applyPluginChange ladder (EP-04)', () => {
  const grant = (overrides: Partial<PluginPermissionGrant> = {}): PluginPermissionGrant => ({
    network: { mode: 'none', hosts: [] },
    fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: '' }] },
    ops_invoke: ['a:*'],
    env: [],
    secrets: [],
    ...overrides,
  });
  const base: PluginChangeSnapshot = {
    contentDigest: 'a'.repeat(64),
    provides: { ops: ['a:run'], views: ['dash'] },
    grant: grant(),
  };

  it.each([
    ['no change', base, 'config_apply'],
    ['permissions narrowed', { ...base, grant: grant({ ops_invoke: ['a:run'] }) }, 'config_apply'],
    [
      'views-only declaration change',
      { ...base, provides: { ...base.provides, views: [] } },
      'config_apply',
    ],
    ['permissions widened', { ...base, grant: grant({ ops_invoke: ['*'] }) }, 'plugin_reload'],
    [
      'ops changed',
      { ...base, provides: { ...base.provides, ops: ['a:run', 'a:new'] } },
      'plugin_reload',
    ],
    ['hooks changed', { ...base, provides: { ...base.provides, hooks: ['h'] } }, 'plugin_reload'],
    [
      'prompt sections changed',
      { ...base, provides: { ...base.provides, prompt_sections: ['p'] } },
      'plugin_reload',
    ],
    ['facets changed', { ...base, provides: { ...base.provides, facets: ['f'] } }, 'plugin_reload'],
    ['code changed', { ...base, contentDigest: 'b'.repeat(64) }, 'plugin_reload'],
    ['grant applied to a legacy plugin', base, 'plugin_reload', { ...base, grant: null }],
    [
      'seams changed',
      { ...base, provides: { ...base.provides, seams: ['s'] } },
      'restart_required',
    ],
    [
      'providers changed',
      { ...base, provides: { ...base.provides, providers: ['stub'] } },
      'restart_required',
    ],
  ] as const)('%s => %s', (_label, after, mode, before = base) => {
    expect(applyPluginChange({ before, after }).mode).toBe(mode);
  });

  it('treats a content change confined to views/ as config_apply and seam code as restart', () => {
    const after = { ...base, contentDigest: 'c'.repeat(64) };
    expect(applyPluginChange({ before: base, after, changedPaths: ['views/dash.json'] }).mode).toBe(
      'config_apply'
    );
    expect(applyPluginChange({ before: base, after, changedPaths: ['index.mjs'] }).mode).toBe(
      'plugin_reload'
    );
    const seamBase = { ...base, provides: { seams: ['s'] } };
    expect(
      applyPluginChange({ before: seamBase, after: { ...seamBase, contentDigest: 'd'.repeat(64) } })
        .mode
    ).toBe('restart_required');
  });
});

describe('plugin lifecycle e2e with the permissions fixture (EP-03/EP-04)', () => {
  it('approve -> activate -> enforce -> reload -> deactivate', async () => {
    vi.stubEnv('PLUGIN_FIXTURE_TOKEN', 'fixture-env');
    const { pluginId, managedRoot } = newIds('permfixture-e2e');
    const record = installApproved(pluginId, fixtureSource(), managedRoot);
    // Third-party ceiling: readonly public fs survives; ops_invoke/env narrow to nothing.
    expect(record.grantedPermissions).toMatchObject({
      network: { mode: 'none' },
      fs: { mode: 'readonly' },
      ops_invoke: [],
      env: [],
    });

    const activated = await activatePlugin({ record }, { managedRoot });
    expect(activated).toMatchObject({ ok: true, pluginId, contentDigest: record.contentDigest });
    expect(isPluginActive(pluginId)).toBe(true);
    expect(ownerOf('ops', 'permfixture:write')).toBe(pluginId);

    const target = pathResolver.sharedTmp(`plugin-lifecycle-test/write-${randomUUID()}`);
    await expect(runOp('write', { path: target }, probe)).rejects.toThrow(/SANDBOX_WRITE_DENIED/);
    expect(safeExistsSync(target)).toBe(false);
    await expect(runOp('fetch', { url: 'https://example.com' }, probe)).rejects.toThrow(
      'SANDBOX_NETWORK_DENIED'
    );
    await expect(runOp('invoke', { op: 'permfixture:env' }, probe)).resolves.toBe('block');
    await expect(runOp('secret', { key: 'PLUGIN_FIXTURE_TOKEN' }, probe)).rejects.toThrow(
      '[PLUGIN_GRANT_DENIED]'
    );
    await expect(runOp('env', {}, probe)).resolves.toEqual({});

    const unchanged = await reloadPlugin(pluginId);
    expect(unchanged).toMatchObject({ ok: true, mode: 'config_apply', reason: 'no change' });

    const source = fixtureSource(
      `${safeReadFile(path.join(FIXTURE_DIR, 'index.mjs'), { encoding: 'utf8' })}\n// v2\n`
    );
    const v2 = installApproved(pluginId, source, managedRoot);
    expect(v2.contentDigest).not.toBe(record.contentDigest);
    const reloaded = await reloadPlugin(pluginId);
    expect(reloaded).toMatchObject({
      ok: true,
      mode: 'plugin_reload',
      contentDigest: v2.contentDigest,
    });
    expect(ownerOf('ops', 'permfixture:write')).toBe(pluginId);
    await expect(runOp('env', {}, probe)).resolves.toEqual({});

    const deactivated = deactivatePlugin(pluginId);
    expect(deactivated).toMatchObject({ ok: true, mode: 'plugin_reload' });
    expect(isPluginActive(pluginId)).toBe(false);
    expect(listOwned(pluginId)).toEqual([]);
    expect(listPluginActuatorOperations().some((entry) => entry.pluginId === pluginId)).toBe(false);
  });

  it('wraps a declared official plugin with its official grant', async () => {
    vi.stubEnv('PLUGIN_FIXTURE_TOKEN', 'fixture-env');
    const entry = path.join(FIXTURE_DIR, 'index.mjs');
    const result = await activatePlugin({
      authorization: {
        configuredPath: entry,
        resolvedPath: entry,
        trust: 'official',
        allowed: true,
        reason: 'test',
      },
    });
    expect(result).toMatchObject({ ok: true, pluginId: 'plugin-permissions-fixture' });
    await expect(runOp('invoke', { op: 'permfixture:env' }, probe)).resolves.toBe('allow');
    await expect(runOp('invoke', { op: 'permfixture:write' }, probe)).resolves.toBe('block');
    await expect(runOp('env', {}, probe)).resolves.toEqual({
      PLUGIN_FIXTURE_TOKEN: 'fixture-env',
    });
    await expect(
      runOp(
        'write',
        { path: pathResolver.sharedTmp(`plugin-lifecycle-test/${randomUUID()}`) },
        probe
      )
    ).rejects.toThrow(/SANDBOX_WRITE_DENIED/);
    expect(() => disposeContribution('someone-else', 'ops', 'permfixture:env')).toThrow(
      '[PLUGIN_OWNERSHIP_DENIED]'
    );
  });

  it('deactivates the previous activation while the new version awaits approval', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-unapproved');
    const record = installApproved(pluginId, fixtureSource(), managedRoot);
    await activatePlugin({ record }, { managedRoot });
    installApproved(pluginId, fixtureSource('export const x = 1;\n'), managedRoot, false);
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, rolledBack: false });
    expect(result.reason).toMatch(/no longer activatable \(new version awaits approval/);
    expect(isPluginActive(pluginId)).toBe(false);
    expect(ownerOf('ops', 'permfixture:write')).toBeUndefined();
  });

  it('deactivates the previous activation when the new version is rejected', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-rejected');
    const record = installApproved(pluginId, fixtureSource(), managedRoot);
    await activatePlugin({ record }, { managedRoot });
    const pending = installApproved(
      pluginId,
      fixtureSource('export const x = 1;\n'),
      managedRoot,
      false
    );
    const request = loadApprovalRequest(
      pending.approvalChannel as string,
      pending.approvalRequestId as string
    );
    decideApprovalRequest('mission_controller', {
      channel: pending.approvalChannel as string,
      requestId: pending.approvalRequestId as string,
      decision: 'rejected',
      decidedBy: 'human:operator',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: request?.accountability?.payloadHash,
      effectBinding: request?.accountability?.effectBinding,
    });
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, rolledBack: false });
    expect(result.reason).toMatch(/no longer activatable \(approval rejected\)/);
    expect(isPluginActive(pluginId)).toBe(false);
    expect(ownerOf('ops', 'permfixture:write')).toBeUndefined();
  });

  it('deactivates the previous activation when the managed copy was tampered with', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-tampered');
    const record = installApproved(pluginId, fixtureSource(), managedRoot);
    await activatePlugin({ record }, { managedRoot });
    withExecutionContext('mission_controller', () =>
      safeWriteFile(path.join(record.managedPath, 'index.mjs'), 'export const tampered = 1;\n')
    );
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, rolledBack: false });
    expect(result.reason).toMatch(/no longer activatable \(status=blocked_digest_mismatch\)/);
    expect(isPluginActive(pluginId)).toBe(false);
    expect(listOwned(pluginId)).toEqual([]);
  });

  it('rolls back to the previous module when the new module fails to activate', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-rollback');
    const record = installApproved(pluginId, fixtureSource(), managedRoot);
    await activatePlugin({ record }, { managedRoot });
    installApproved(
      pluginId,
      fixtureSource(
        "export const registerKyberionContributions = () => { throw new Error('v2 is broken'); };\n"
      ),
      managedRoot
    );
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, mode: 'plugin_reload', rolledBack: true });
    expect(result.reason).toContain('v2 is broken');
    expect(isPluginActive(pluginId)).toBe(true);
    expect(ownerOf('ops', 'permfixture:write')).toBe(pluginId);
    await expect(runOp('env', {}, probe)).resolves.toEqual({});
  });

  function withFsPermission(source: string, fs: Record<string, unknown>): string {
    const manifestPath = path.join(source, 'plugin-manifest.json');
    const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string);
    manifest.permissions.fs = fs;
    safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
    return source;
  }
  const broken =
    "export const registerKyberionContributions = () => { throw new Error('v2 is broken'); };\n";
  const fsModeProbe = { ...probe, env: () => getPluginExecutionContext()?.grant.fs };

  it('rolls back under the narrower new grant, never the previous wider one', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-rollback-narrow');
    const record = installApproved(pluginId, fixtureSource(), managedRoot);
    expect(record.grantedPermissions?.fs.mode).toBe('readonly');
    await activatePlugin({ record }, { managedRoot });
    const v2 = installApproved(
      pluginId,
      withFsPermission(fixtureSource(broken), { mode: 'none' }),
      managedRoot
    );
    expect(v2.grantedPermissions?.fs.mode).toBe('none');
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, mode: 'plugin_reload', rolledBack: true });
    await expect(runOp('env', {}, fsModeProbe)).resolves.toMatchObject({ mode: 'none' });
  });

  it('does not re-activate the previous module when the grants are incomparable', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-rollback-disjoint');
    const scoped = (prefix: string) => ({
      mode: 'readonly',
      paths: [{ tier: 'public', prefix }],
    });
    const record = installApproved(
      pluginId,
      withFsPermission(fixtureSource(), scoped('alpha')),
      managedRoot
    );
    await activatePlugin({ record }, { managedRoot });
    installApproved(pluginId, withFsPermission(fixtureSource(broken), scoped('beta')), managedRoot);
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, mode: 'restart_required', rolledBack: false });
    expect(isPluginActive(pluginId)).toBe(false);
    expect(listOwned(pluginId)).toEqual([]);
  });

  it('reports restart_required when the rollback also fails', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-restart');
    const once = [
      'let calls = 0;',
      'export const registerKyberionContributions = (api) => {',
      "  if (++calls > 1) throw new Error('v1 cannot re-activate');",
      "  for (const op of ['write', 'fetch', 'invoke', 'secret', 'env']) {",
      '    api.registerOperation(`permfixture:${op}`, {',
      "      stepType: 'apply',",
      '      handler: async (_op, _params, context) => ({ handled: true, ctx: context }),',
      '    });',
      '  }',
      '};',
      '',
    ].join('\n');
    const record = installApproved(pluginId, fixtureSource(once), managedRoot);
    await activatePlugin({ record }, { managedRoot });
    installApproved(
      pluginId,
      fixtureSource(
        "export const registerKyberionContributions = () => { throw new Error('v2'); };\n"
      ),
      managedRoot
    );
    const result = await reloadPlugin(pluginId);
    expect(result).toMatchObject({ ok: false, mode: 'restart_required', rolledBack: false });
    expect(isPluginActive(pluginId)).toBe(false);
    expect(listOwned(pluginId)).toEqual([]);
  });

  it('refuses to activate an unapproved or modified managed copy', async () => {
    const { pluginId, managedRoot } = newIds('permfixture-denied');
    const pending = installApproved(pluginId, fixtureSource(), managedRoot, false);
    await expect(activatePlugin({ record: pending }, { managedRoot })).rejects.toThrow(
      '[PLUGIN_LIFECYCLE_DENIED]'
    );
    const approved = installApproved(pluginId, fixtureSource(), managedRoot);
    withExecutionContext('mission_controller', () =>
      safeWriteFile(path.join(approved.managedPath, 'index.mjs'), 'export const tampered = 1;\n')
    );
    await expect(activatePlugin({ record: approved }, { managedRoot })).rejects.toThrow(
      '[PLUGIN_LIFECYCLE_DENIED]'
    );
    expect(isPluginActive(pluginId)).toBe(false);
  });
});
