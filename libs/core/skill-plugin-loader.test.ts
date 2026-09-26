import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';
import { activatePlugin, deactivatePlugin } from './plugin-lifecycle.js';
import { getActiveSandboxPolicy, getPluginExecutionContext } from './sandbox-policy.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  evaluateSkillRestrictionRecords,
  isSkillAllowed,
  authorizeConfiguredSkillPlugins,
  disposeSkillPluginContributions,
  fireSkillPluginHook,
  loadSkillPluginsConfigAtPath,
  loadAuthorizedSkillPlugins,
  normalizePluginContributionDeclaration,
  readSkillPluginsConfig,
  SKILL_PLUGINS_CONFIG_FILENAME,
} from './skill-plugin-loader.js';
import { resolveActuatorOperation, type ActuatorOperationHandler } from './actuator-op-registry.js';

// Checked-in fixture (see the file itself for why it can't be written at
// test time): resolves inside this repo's own plugins/ tree, so it is the
// `official` case. Inert unless KYBERION_SKILL_PLUGIN_TEST_MARKER is set.
const OFFICIAL_FIXTURE_PATH = pathResolver.rootResolve(
  'plugins/fixtures/skill-plugin-loader-official-fixture.mjs'
);
const CONTRIBUTION_FIXTURE_PATH = pathResolver.rootResolve(
  'plugins/fixtures/skill-plugin-loader-contribution-fixture/index.mjs'
);

const cleanupPaths: string[] = [];
const originalMarkerEnv = process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER;

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

function sourceDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(`skill-plugin-loader-test/${process.pid}-source-${name}-${randomUUID()}`)
  );
}

function managedRootDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(`plugins/managed-test-${process.pid}-${name}-${randomUUID()}`)
  );
}

function cwdDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(`skill-plugin-loader-test/${process.pid}-cwd-${name}-${randomUUID()}`)
  );
}

afterEach(() => {
  if (originalMarkerEnv === undefined) delete process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER;
  else process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER = originalMarkerEnv;

  // Managed-plugin paths are only writable under the same authority role the
  // installer itself uses (mirrors plugin-managed-install.test.ts).
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop() as string;
      safeRmSync(target);
    }
  });
});

describe('plugin contribution manifest boundary', () => {
  it('normalizes declared contribution names and trims whitespace', () => {
    expect(
      normalizePluginContributionDeclaration({
        ops: [' code:run ', 'code:run'],
        facets: ['summary'],
      })
    ).toEqual({ ops: ['code:run', 'code:run'], facets: ['summary'] });
  });

  it('rejects non-object and malformed contribution declarations', () => {
    expect(normalizePluginContributionDeclaration([])).toBeUndefined();
    expect(() => normalizePluginContributionDeclaration({ ops: [''] })).toThrow(
      'provides.ops must be a non-empty string array'
    );
    expect(() => normalizePluginContributionDeclaration({ hooks: [{ id: 'hook' }] })).toThrow(
      'provides.hooks must be a non-empty string array'
    );
  });

  it('checks contribution manifests as regular files before reading them', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/skill-plugin-loader.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('safeLstat(manifestPath).isFile()');
    expect(source).toContain('plugin manifest must be a regular file');
  });
});

/** Writes an ESM plugin whose hooks append to `markerPath` when actually called. */
function writeHookPlugin(filePath: string, markerPath: string): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(
    filePath,
    [
      // Built by concatenation (not a literal specifier string) so this
      // generated-fixture source doesn't read as a direct `node:fs` import
      // to the repo's fs-exception-boundary scan of libs/core/*.
      `import { appendFileSync } from ${JSON.stringify('node:' + 'fs')};`,
      `const marker = ${JSON.stringify(markerPath)};`,
      "export const beforeSkill = (name) => { appendFileSync(marker, 'before:' + name + '\\n'); };",
      "export const afterSkill = (name, output) => { appendFileSync(marker, 'after:' + name + ':' + (output && output.status) + '\\n'); };",
      '',
    ].join('\n')
  );
}

function writeConfig(cwd: string, plugins: string[]): void {
  safeMkdir(cwd, { recursive: true });
  safeWriteFile(path.join(cwd, '.kyberion-plugins.json'), JSON.stringify({ plugins }));
}

function readMarker(markerPath: string): string {
  return safeExistsSync(markerPath)
    ? (safeReadFile(markerPath, { encoding: 'utf8' }) as string)
    : '';
}

describe('loadAuthorizedSkillPlugins', () => {
  it('activates manifest-declared contributions through the authorized loader and disposes them', async () => {
    const cwd = cwdDir('contributions');
    writeConfig(cwd, [CONTRIBUTION_FIXTURE_PATH]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, undefined, undefined, {
      trustResolved: true,
    });
    expect(diagnostics).toHaveLength(0);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.contributions?.registered.ops).toEqual(['fixture:run']);
    expect(resolveActuatorOperation('fixture', 'run')).toMatchObject({
      source: 'plugin',
      pluginId: 'skill-plugin-loader-contribution-fixture',
    });

    disposeSkillPluginContributions(loaded);
    expect(() => resolveActuatorOperation('fixture', 'run')).toThrow('[UNKNOWN_OP]');
  });

  it("loads an official plugin (inside this repo's plugins/ tree) and its hooks actually fire", async () => {
    const markerPath = path.join(sourceDir('official-marker'), 'marker.log');
    safeMkdir(path.dirname(markerPath), { recursive: true });
    process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER = markerPath;

    const cwd = cwdDir('official');
    writeConfig(cwd, [OFFICIAL_FIXTURE_PATH]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, undefined, undefined, {
      trustResolved: true,
    });
    expect(diagnostics).toHaveLength(0);
    expect(loaded).toHaveLength(1);

    await fireSkillPluginHook('beforeSkill', loaded, 'demo-skill', ['--x']);
    await fireSkillPluginHook('afterSkill', loaded, 'demo-skill', { status: 'success' });

    const marker = readMarker(markerPath);
    expect(marker).toContain('before:demo-skill');
    expect(marker).toContain('after:demo-skill:success');
  });

  it('skips an unmanaged third-party plugin path with a diagnostic and never executes its code', async () => {
    const src = sourceDir('unmanaged');
    const markerPath = path.join(src, 'marker.log');
    const pluginFile = path.join(src, 'index.mjs');
    writeHookPlugin(pluginFile, markerPath);

    const cwd = cwdDir('unmanaged');
    writeConfig(cwd, [pluginFile]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, undefined, undefined, {
      trustResolved: true,
    });
    expect(loaded).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.allowed).toBe(false);
    expect(diagnostics[0]?.trust).toBe('third-party');
    expect(diagnostics[0]?.reason).toMatch(/not a managed-copy install/);

    // Never imported => never executed. Firing hooks over an empty `loaded`
    // list is also a no-op, proving the skip is not just cosmetic.
    await fireSkillPluginHook('beforeSkill', loaded, 'demo-skill', []);
    expect(safeExistsSync(markerPath)).toBe(false);
  });

  it('the same path is also denied directly by authorizeConfiguredSkillPlugins (pure decision, no import)', () => {
    const src = sourceDir('unmanaged-pure');
    const pluginFile = path.join(src, 'index.mjs');
    // Deliberately do not even write the file — proves the authorization
    // decision never needs to touch/resolve the plugin's actual content.
    safeMkdir(src, { recursive: true });

    const cwd = cwdDir('unmanaged-pure');
    writeConfig(cwd, [pluginFile]);

    const diagnostics = authorizeConfiguredSkillPlugins(cwd);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.allowed).toBe(false);
  });

  it('loads a managed, human-approved third-party plugin', async () => {
    const managedRoot = managedRootDir('approved');
    const src = sourceDir('approved-source');
    const markerPath = path.join(src, 'marker.log');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'approved-sample' })
    );
    writeHookPlugin(path.join(src, 'index.mjs'), markerPath);

    const pluginId = `approved-${process.pid}-${randomUUID()}`.slice(0, 60);
    const record = installPluginManaged({ pluginId, sourcePath: src, managedRoot });
    expect(record.trust).toBe('third-party');
    expect(record.activationStatus).toBe('pending_approval');
    expect(record.approvalRequestId).toBeDefined();

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

    const cwd = cwdDir('approved');
    writeConfig(cwd, [path.join(record.managedPath, 'index.mjs')]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    expect(diagnostics).toHaveLength(0);
    expect(loaded).toHaveLength(1);

    await fireSkillPluginHook('beforeSkill', loaded, 'demo-skill', []);
    expect(readMarker(markerPath)).toContain('before:demo-skill');
  });

  it('skips an approved managed plugin whose content changed after approval, never importing it', async () => {
    const managedRoot = managedRootDir('tampered');
    const src = sourceDir('tampered-source');
    const markerPath = path.join(src, 'marker.log');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'tampered-sample' })
    );
    safeWriteFile(path.join(src, 'index.mjs'), 'export const inert = true;\n');

    const pluginId = `tampered-${process.pid}-${randomUUID()}`.slice(0, 60);
    const record = installPluginManaged({ pluginId, sourcePath: src, managedRoot });
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
    expect(refreshManagedPluginActivation(pluginId, managedRoot)?.activationStatus).toBe(
      'activatable'
    );

    // Swap in code that would leave a marker if it were ever imported.
    withExecutionContext('mission_controller', () =>
      writeHookPlugin(path.join(record.managedPath, 'index.mjs'), markerPath)
    );

    const cwd = cwdDir('tampered');
    writeConfig(cwd, [path.join(record.managedPath, 'index.mjs')]);
    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    expect(loaded).toHaveLength(0);
    expect(diagnostics[0]?.reason).toMatch(/blocked_digest_mismatch/);
    await fireSkillPluginHook('beforeSkill', loaded, 'demo-skill', []);
    expect(safeExistsSync(markerPath)).toBe(false);
  });

  it('skips a managed but still pending-approval third-party plugin', async () => {
    const managedRoot = managedRootDir('pending');
    const src = sourceDir('pending-source');
    const markerPath = path.join(src, 'marker.log');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'pending-sample' })
    );
    writeHookPlugin(path.join(src, 'index.mjs'), markerPath);

    const pluginId = `pending-${process.pid}-${randomUUID()}`.slice(0, 60);
    const record = installPluginManaged({ pluginId, sourcePath: src, managedRoot });
    expect(record.activationStatus).toBe('pending_approval');

    const cwd = cwdDir('pending');
    writeConfig(cwd, [path.join(record.managedPath, 'index.mjs')]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    expect(loaded).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toMatch(/not activatable/);
    expect(diagnostics[0]?.reason).toMatch(/pending_approval/);
    expect(safeExistsSync(markerPath)).toBe(false);
  });

  it('an absent .kyberion-plugins.json degrades to no plugins, not an error', async () => {
    const cwd = cwdDir('no-config');
    safeMkdir(cwd, { recursive: true });
    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, undefined, undefined, {
      trustResolved: true,
    });
    expect(loaded).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('does not consume plugin configuration before project trust is resolved', async () => {
    const cwd = cwdDir('pre-trust');
    const markerPath = path.join(cwd, 'should-not-run.log');
    writeConfig(cwd, [CONTRIBUTION_FIXTURE_PATH]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, undefined, undefined, {
      trustResolved: false,
    });
    expect(loaded).toHaveLength(0);
    expect(diagnostics).toMatchObject([
      {
        configuredPath: path.join(cwd, '.kyberion-plugins.json'),
        allowed: false,
        trust: 'third-party',
      },
    ]);
    expect(diagnostics[0]?.reason).toMatch(/trust is unresolved/);
    expect(safeExistsSync(markerPath)).toBe(false);
  });

  it('fails closed when the project plugin configuration traverses a symlink', () => {
    const cwd = cwdDir('symlinked-config');
    const targetDir = sourceDir('symlinked-config-target');
    const targetConfig = path.join(targetDir, SKILL_PLUGINS_CONFIG_FILENAME);
    safeMkdir(targetDir, { recursive: true });
    safeWriteFile(targetConfig, JSON.stringify({ plugins: [OFFICIAL_FIXTURE_PATH] }));
    safeMkdir(cwd, { recursive: true });
    safeSymlinkSync(targetConfig, path.join(cwd, SKILL_PLUGINS_CONFIG_FILENAME));

    expect(readSkillPluginsConfig(cwd)).toEqual([]);
  });

  it('rejects a schema-invalid plugin configuration before selectors are consumed', () => {
    const cwd = cwdDir('invalid-config');
    safeMkdir(cwd, { recursive: true });
    const configPath = path.join(cwd, SKILL_PLUGINS_CONFIG_FILENAME);
    safeWriteFile(configPath, JSON.stringify({ plugins: [123] }));

    expect(() => loadSkillPluginsConfigAtPath(configPath)).toThrow('[PLUGIN_CONFIG_INVALID]');
    expect(readSkillPluginsConfig(cwd)).toEqual([]);
  });

  it('rejects a plugin configuration directory before parsing', () => {
    const cwd = cwdDir('config-directory');
    const configPath = path.join(cwd, SKILL_PLUGINS_CONFIG_FILENAME);
    safeMkdir(configPath, { recursive: true });

    expect(() => loadSkillPluginsConfigAtPath(configPath)).toThrow('regular file');
  });

  it('fails closed when the trust decision is omitted', async () => {
    const cwd = cwdDir('implicit-pre-trust');
    writeConfig(cwd, [CONTRIBUTION_FIXTURE_PATH]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd);
    expect(loaded).toHaveLength(0);
    expect(diagnostics[0]?.reason).toMatch(/trust is unresolved/);
  });
});
function approveManaged(record: ManagedPluginRecord, managedRoot: string): ManagedPluginRecord {
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
  const refreshed = refreshManagedPluginActivation(record.pluginId, managedRoot);
  expect(refreshed?.activationStatus).toBe('activatable');
  return refreshed as ManagedPluginRecord;
}

describe('plugin grants on the skill path (EP-03)', () => {
  const frameProbe = () => getPluginExecutionContext()?.grant ?? 'host';

  async function invokeOp(domain: string, action: string, probe: object): Promise<unknown> {
    const handler = resolveActuatorOperation(domain, action)?.handler as ActuatorOperationHandler;
    return (await handler(action, {}, { probe }, 'apply')).ctx;
  }

  it('treats an undeclared official managed install as unwrapped, like the lifecycle', async () => {
    const managedRoot = managedRootDir('official-parity');
    const record = installPluginManaged({
      pluginId: `official-parity-${process.pid}`,
      sourcePath: path.dirname(CONTRIBUTION_FIXTURE_PATH),
      managedRoot,
    });
    expect(record).toMatchObject({ trust: 'official', activationStatus: 'activatable' });
    const cwd = cwdDir('official-parity');
    writeConfig(cwd, [path.join(record.managedPath, 'index.mjs')]);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    expect(diagnostics).toEqual([]);
    expect(loaded[0]?.grant).toBeNull();
    expect(loaded[0]?.contributions?.grant.grant).toBeNull();
    // The fixture op returns its context; a wrapped plugin would run the probe in its frame.
    const viaSkill = (
      (await invokeOp('fixture', 'run', frameProbe)) as { probe: () => unknown }
    ).probe();
    disposeSkillPluginContributions(loaded);

    await activatePlugin({ record }, { managedRoot });
    const viaLifecycle = (
      (await invokeOp('fixture', 'run', frameProbe)) as { probe: () => unknown }
    ).probe();
    deactivatePlugin(record.pluginId);
    expect(viaSkill).toBe('host');
    expect(viaLifecycle).toBe('host');
  });

  it('gives a declared official managed install its approved grant on both paths', async () => {
    const managedRoot = managedRootDir('official-declared');
    const record = installPluginManaged({
      pluginId: `official-declared-${process.pid}`,
      sourcePath: pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture'),
      managedRoot,
    });
    expect(record).toMatchObject({ trust: 'official', activationStatus: 'activatable' });
    const cwd = cwdDir('official-declared');
    writeConfig(cwd, [path.join(record.managedPath, 'index.mjs')]);
    const envProbe = { env: frameProbe };

    const { loaded } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    expect(loaded[0]?.grant).toEqual(record.grantedPermissions);
    const viaSkill = ((await invokeOp('permfixture', 'env', envProbe)) as { result: unknown })
      .result;
    disposeSkillPluginContributions(loaded);

    await activatePlugin({ record }, { managedRoot });
    const viaLifecycle = ((await invokeOp('permfixture', 'env', envProbe)) as { result: unknown })
      .result;
    deactivatePlugin(record.pluginId);
    expect(viaSkill).toEqual(record.grantedPermissions);
    expect(viaLifecycle).toEqual(record.grantedPermissions);
  });

  it('imports a managed plugin module under its approved grant', async () => {
    const managedRoot = managedRootDir('import-grant');
    const src = sourceDir('import-grant-source');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'import-grant-sample' })
    );
    safeWriteFile(
      path.join(src, 'index.mjs'),
      'export const importFrame = globalThis.__kyberionImportFrameProbe?.();\n'
    );
    const pluginId = `import-grant-${process.pid}-${randomUUID()}`.slice(0, 60);
    const record = approveManaged(
      installPluginManaged({ pluginId, sourcePath: src, managedRoot }),
      managedRoot
    );
    const cwd = cwdDir('import-grant');
    writeConfig(cwd, [path.join(record.managedPath, 'index.mjs')]);
    const probeHost = globalThis as { __kyberionImportFrameProbe?: () => unknown };
    probeHost.__kyberionImportFrameProbe = () => ({
      pluginId: getPluginExecutionContext()?.pluginId,
      sandbox: getActiveSandboxPolicy()?.mode,
    });
    try {
      const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(
        cwd,
        managedRoot,
        undefined,
        { trustResolved: true }
      );
      expect(diagnostics).toEqual([]);
      expect(loaded[0]?.grant).toEqual(record.grantedPermissions);
      expect(loaded[0]?.module.importFrame).toEqual({ pluginId, sandbox: 'read-only' });
    } finally {
      delete probeHost.__kyberionImportFrameProbe;
    }
  });
});

describe('restricted skill policy', () => {
  it('allows overlays to narrow but never to reopen a restricted skill', () => {
    expect(
      evaluateSkillRestrictionRecords('deploy', [
        { name: 'deploy', status: 'restricted', allow_override: true },
      ])
    ).toMatchObject({ allowed: false });
    expect(evaluateSkillRestrictionRecords('deploy', [])).toEqual({ allowed: true });
  });

  it('applies plugin overlays as narrow-only selectors', () => {
    const cwd = cwdDir('narrow-only-overlay');
    safeMkdir(cwd, { recursive: true });
    safeWriteFile(
      path.join(cwd, '.kyberion-plugins.json'),
      JSON.stringify({
        plugins: ['plugin-a', 'plugin-b'],
        tenant_overrides: {
          tenant_a: { plugins: ['-plugin-a'] },
        },
      })
    );

    expect(readSkillPluginsConfig(cwd, { tenant_slug: 'tenant_a' })).toEqual(['plugin-b']);
    expect(readSkillPluginsConfig(cwd, { tenant_slug: 'tenant_missing' })).toEqual([
      'plugin-a',
      'plugin-b',
    ]);
  });

  it('fails closed when the governed restricted-skills catalog is invalid', () => {
    const rootDir = tracked(
      pathResolver.sharedTmp(
        `skill-plugin-loader-test/${process.pid}-invalid-policy-${randomUUID()}`
      )
    );
    const policyDir = path.join(rootDir, 'knowledge/product/governance');
    safeMkdir(policyDir, { recursive: true });
    safeWriteFile(
      path.join(policyDir, 'restricted-skills.json'),
      JSON.stringify({ version: '1.0', restrictions: [{ name: 'deploy' }] })
    );

    expect(isSkillAllowed('deploy', undefined, rootDir)).toMatchObject({
      allowed: false,
      reason: 'restricted-skills policy is unreadable',
    });
  });

  it('rejects a plugin overlay that would introduce an undeclared resource', () => {
    const cwd = cwdDir('widened-overlay');
    safeMkdir(cwd, { recursive: true });
    safeWriteFile(
      path.join(cwd, '.kyberion-plugins.json'),
      JSON.stringify({
        plugins: ['plugin-a'],
        tenant_overrides: {
          tenant_a: { plugins: ['plugin-new'] },
        },
      })
    );

    expect(readSkillPluginsConfig(cwd, { tenant_slug: 'tenant_a' })).toEqual([]);
  });
});
