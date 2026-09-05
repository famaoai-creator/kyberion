import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  approvalRequestLogicalPath,
  createProjectTrustApprovalRequest,
  decideApprovalRequest,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  withExecutionContext,
} from './index.js';
import { LifecycleHookEngine } from './lifecycle-hook-engine.js';
import {
  discoverExternalHookConfigs,
  registerDiscoveredExternalLifecycleHooks,
  registerDiscoveredExternalLifecycleHooksOnDefaultEngine,
} from './external-hook-discovery.js';
import {
  getDefaultLifecycleHookEngine,
  resetDefaultLifecycleHookEngine,
} from './lifecycle-hook-engine.js';
import { safeReadFile } from './secure-io.js';

const fixtureRoot = pathResolver.shared('tmp/external-hook-discovery-test');

describe('external hook discovery', () => {
  afterEach(() => {
    resetDefaultLifecycleHookEngine();
  });

  it('requires trust before registering project-local configs', async () => {
    safeMkdir(`${fixtureRoot}/.claude`, { recursive: true });
    safeWriteFile(
      `${fixtureRoot}/.claude/settings.json`,
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: 'command', command: ['trusted-hook'] }] }],
      })
    );
    expect(discoverExternalHookConfigs({ rootDir: fixtureRoot })).toHaveLength(1);
    const engine = new LifecycleHookEngine();
    expect(() =>
      registerDiscoveredExternalLifecycleHooks(engine, {
        rootDir: fixtureRoot,
        trustResolved: false,
      })
    ).toThrow('[EXTERNAL_HOOK_TRUST_REQUIRED]');
    let approvalId = '';
    try {
      approvalId = approveProjectConfig(`${fixtureRoot}/.claude/settings.json`);
      const result = registerDiscoveredExternalLifecycleHooks(engine, {
        rootDir: fixtureRoot,
        trustResolved: true,
        projectTrustApprovalIds: {
          [`${fixtureRoot}/.claude/settings.json`]: approvalId,
        },
      });
      expect(result.registered).toBe(1);
      await result.dispose();
      expect(engine.hookCountFor('pre_tool_use')).toBe(0);
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(fixtureRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('requires a hash-bound approval for each project config', () => {
    safeMkdir(`${fixtureRoot}/.claude`, { recursive: true });
    safeWriteFile(
      `${fixtureRoot}/.claude/settings.json`,
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: ['approved-hook'] }] }] })
    );
    const engine = new LifecycleHookEngine();
    const result = registerDiscoveredExternalLifecycleHooks(engine, {
      rootDir: fixtureRoot,
      trustResolved: true,
    });
    expect(result.registered).toBe(0);
    expect(result.skipped[0]?.reason).toContain('[EXTERNAL_HOOK_APPROVAL_REQUIRED]');
    safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('does not register a project config after its approved content changes', () => {
    safeMkdir(`${fixtureRoot}/.claude`, { recursive: true });
    const configPath = `${fixtureRoot}/.claude/settings.json`;
    safeWriteFile(
      configPath,
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: ['before-change'] }] }] })
    );
    let approvalId = '';
    try {
      approvalId = approveProjectConfig(configPath);
      safeWriteFile(
        configPath,
        JSON.stringify({
          PreToolUse: [{ hooks: [{ type: 'command', command: ['after-change'] }] }],
        })
      );
      const result = registerDiscoveredExternalLifecycleHooks(new LifecycleHookEngine(), {
        rootDir: fixtureRoot,
        trustResolved: true,
        projectTrustApprovalIds: { [configPath]: approvalId },
      });

      expect(result.registered).toBe(0);
      expect(result.skipped[0]?.reason).toContain('changed after approval');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(fixtureRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('skips an approved project config containing dangerous JSON keys', () => {
    safeMkdir(`${fixtureRoot}/.claude`, { recursive: true });
    const configPath = `${fixtureRoot}/.claude/settings.json`;
    safeWriteFile(
      configPath,
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: 'command', command: ['safe-hook'] }] }],
        nested: { ['__proto__']: { polluted: true } },
      })
    );
    let approvalId = '';
    try {
      approvalId = approveProjectConfig(configPath);
      const result = registerDiscoveredExternalLifecycleHooks(new LifecycleHookEngine(), {
        rootDir: fixtureRoot,
        trustResolved: true,
        projectTrustApprovalIds: { [configPath]: approvalId },
      });
      expect(result.registered).toBe(0);
      expect(result.skipped[0]?.reason).toContain('dangerous JSON key');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(fixtureRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('requires an explicit global opt-in and separate trust decision', async () => {
    const globalHome = pathResolver.shared('tmp/external-hook-global-test');
    safeMkdir(`${globalHome}/.claude`, { recursive: true });
    safeWriteFile(
      `${globalHome}/.claude/settings.json`,
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: ['global-hook'] }] }] })
    );
    const projectRoot = pathResolver.shared('tmp/external-hook-global-project');
    expect(
      discoverExternalHookConfigs({ rootDir: projectRoot, globalHomeDir: globalHome })
    ).toHaveLength(0);
    expect(
      discoverExternalHookConfigs({
        rootDir: projectRoot,
        includeGlobal: true,
        globalHomeDir: globalHome,
      })
    ).toEqual([
      {
        source: 'claude-code',
        path: `${globalHome}/.claude/settings.json`,
        scope: 'global',
      },
    ]);

    const engine = new LifecycleHookEngine();
    expect(() =>
      registerDiscoveredExternalLifecycleHooks(engine, {
        rootDir: projectRoot,
        includeGlobal: true,
        globalHomeDir: globalHome,
        trustResolved: true,
      })
    ).toThrow('[EXTERNAL_HOOK_GLOBAL_TRUST_REQUIRED]');
    const result = registerDiscoveredExternalLifecycleHooks(engine, {
      rootDir: projectRoot,
      includeGlobal: true,
      globalHomeDir: globalHome,
      trustResolved: true,
      globalTrustResolved: true,
    });
    expect(result.registered).toBe(1);
    await result.dispose();
  });

  it('can register an approved project config on the default engine', async () => {
    safeMkdir(`${fixtureRoot}/.claude`, { recursive: true });
    const configPath = `${fixtureRoot}/.claude/settings.json`;
    safeWriteFile(
      configPath,
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: ['default-hook'] }] }] })
    );
    let approvalId = '';
    try {
      approvalId = approveProjectConfig(configPath);
      const result = registerDiscoveredExternalLifecycleHooksOnDefaultEngine({
        rootDir: fixtureRoot,
        trustResolved: true,
        projectTrustApprovalIds: { [configPath]: approvalId },
      });
      expect(result.registered).toBe(1);
      expect(getDefaultLifecycleHookEngine().hookCountFor('pre_tool_use')).toBe(1);
      await result.dispose();
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(fixtureRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('skips project hook configs reached through a symbolic link', () => {
    const projectRoot = pathResolver.shared(`tmp/external-hook-symlink-project-${process.pid}`);
    const outsideRoot = pathResolver.shared(`tmp/external-hook-symlink-outside-${process.pid}`);
    const config = `${outsideRoot}/settings.json`;
    try {
      safeMkdir(`${projectRoot}/.claude`, { recursive: true });
      safeMkdir(outsideRoot, { recursive: true });
      safeWriteFile(config, JSON.stringify({ PreToolUse: [] }));
      safeSymlinkSync(config, `${projectRoot}/.claude/settings.json`);

      expect(discoverExternalHookConfigs({ rootDir: projectRoot })).toEqual([]);
    } finally {
      safeRmSync(projectRoot, { recursive: true, force: true });
      safeRmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('resolves the implicit global home through the registered environment boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/external-hook-discovery.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("getRegisteredEnvText('HOME')");
    expect(source).not.toContain('process.env.HOME');
  });
});

function approveProjectConfig(inputPath: string): string {
  const request = createProjectTrustApprovalRequest({ inputPath, requestedBy: 'test-operator' });
  decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: 'human-operator',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
  });
  return request.id;
}
