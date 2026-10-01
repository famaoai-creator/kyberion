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
  ensureTrustedExternalHooksRegistered,
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

  it('bootstraps only approved project configs, and only when opted in', () => {
    const projectRoot = pathResolver.shared(`tmp/external-hook-bootstrap-${process.pid}`);
    const approved = `${projectRoot}/.claude/settings.json`;
    const unapproved = `${projectRoot}/.codex/hooks.json`;
    const hooks = JSON.stringify({
      PreToolUse: [{ hooks: [{ type: 'command', command: ['bootstrap-hook'] }] }],
    });
    let approvalId = '';
    try {
      safeMkdir(`${projectRoot}/.claude`, { recursive: true });
      safeMkdir(`${projectRoot}/.codex`, { recursive: true });
      safeWriteFile(approved, hooks);
      safeWriteFile(unapproved, hooks);
      approvalId = approveProjectConfig(approved);

      // Unset: inert, nothing joins the process-wide engine.
      expect(ensureTrustedExternalHooksRegistered({ rootDir: projectRoot, env: {} })).toBeNull();
      expect(getDefaultLifecycleHookEngine().hookCountFor('pre_tool_use')).toBe(0);

      const env = { KYBERION_EXTERNAL_HOOKS: 'project' };
      const result = ensureTrustedExternalHooksRegistered({ rootDir: projectRoot, env });
      expect(result?.registered).toBe(1);
      expect(result?.skipped.map((entry) => entry.path)).toEqual([unapproved]);
      expect(result?.skipped[0]?.reason).toContain('[EXTERNAL_HOOK_APPROVAL_REQUIRED]');
      expect(getDefaultLifecycleHookEngine().hookCountFor('pre_tool_use')).toBe(1);
      // Once per engine: a second call does not register the same hooks twice.
      expect(ensureTrustedExternalHooksRegistered({ rootDir: projectRoot, env })).toBe(result);
      expect(getDefaultLifecycleHookEngine().hookCountFor('pre_tool_use')).toBe(1);
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(projectRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('does not pin an all-skipped result, so a later approval registers without restart', () => {
    const projectRoot = pathResolver.shared(`tmp/external-hook-late-approval-${process.pid}`);
    const config = `${projectRoot}/.claude/settings.json`;
    let approvalId = '';
    try {
      safeMkdir(`${projectRoot}/.claude`, { recursive: true });
      safeWriteFile(
        config,
        JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: ['late-hook'] }] }] })
      );
      const env = { KYBERION_EXTERNAL_HOOKS: 'project' };
      const first = ensureTrustedExternalHooksRegistered({ rootDir: projectRoot, env });
      expect(first?.registered).toBe(0);
      expect(first?.skipped.map((entry) => entry.path)).toEqual([config]);

      approvalId = approveProjectConfig(config);
      const second = ensureTrustedExternalHooksRegistered({ rootDir: projectRoot, env });
      expect(second).not.toBe(first);
      expect(second?.registered).toBe(1);
      expect(getDefaultLifecycleHookEngine().hookCountFor('pre_tool_use')).toBe(1);
      // Now that something registered, the result is pinned for the engine.
      expect(ensureTrustedExternalHooksRegistered({ rootDir: projectRoot, env })).toBe(second);
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(projectRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('opens a hook-specific trust card listing the event → command pairs', () => {
    const projectRoot = pathResolver.shared(`tmp/external-hook-card-${process.pid}`);
    const config = `${projectRoot}/.claude/settings.json`;
    let requestId = '';
    try {
      safeMkdir(`${projectRoot}/.claude`, { recursive: true });
      safeWriteFile(
        config,
        JSON.stringify({
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-bash' }] }],
          Stop: [{ hooks: [{ type: 'command', command: ['notify', '--done'] }] }],
        })
      );
      const request = withExecutionContext('mission_controller', () =>
        createProjectTrustApprovalRequest({
          inputPath: config,
          requestedBy: 'test-operator',
          resource: { kind: 'external-hook-config', source: 'claude-code' },
        })
      );
      requestId = request.id;
      const draft = {
        title: request.title,
        summary: request.summary,
        details: request.details ?? '',
      };
      expect(draft.title).not.toContain('pipeline');
      expect(draft.title).toContain('.claude/settings.json');
      expect(draft.summary).toMatch(/2/);
      expect(draft.details).toContain('pre_tool_use [Bash] → echo pre-bash');
      expect(draft.details).toContain('stop → notify --done');
      expect(draft.details).toContain('Content SHA-256:');
      // Lookups are unaffected by the card kind: the same binding is reused.
      const again = withExecutionContext('mission_controller', () =>
        createProjectTrustApprovalRequest({ inputPath: config, requestedBy: 'test-operator' })
      );
      expect(again.id).toBe(request.id);
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(projectRoot, { recursive: true, force: true });
        if (requestId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', requestId), { force: true });
        }
      });
    }
  });

  it('registers an approved real-shape Claude Code settings.json and lists its commands on the trust card', async () => {
    const projectRoot = pathResolver.shared(`tmp/external-hook-real-shape-${process.pid}`);
    const config = `${projectRoot}/.claude/settings.json`;
    let approvalId = '';
    try {
      safeMkdir(`${projectRoot}/.claude`, { recursive: true });
      safeWriteFile(
        config,
        JSON.stringify(
          {
            $schema: 'https://json.schemastore.org/claude-code-settings.json',
            permissions: { allow: ['Bash(pnpm test:*)'], deny: [] },
            hooks: {
              PreCompact: [
                { matcher: 'manual', hooks: [{ type: 'command', command: 'echo pre-compact' }] },
              ],
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: 'node scripts/guard.js', timeout: 10 }],
                },
              ],
            },
          },
          null,
          2
        )
      );
      const request = withExecutionContext('mission_controller', () =>
        createProjectTrustApprovalRequest({
          inputPath: config,
          requestedBy: 'test-operator',
          resource: { kind: 'external-hook-config', source: 'claude-code' },
        })
      );
      approvalId = request.id;
      expect(request.details ?? '').toContain('pre_compact [manual] → echo pre-compact');
      expect(request.details ?? '').toContain('pre_tool_use [Bash] → node scripts/guard.js');
      approveProjectConfig(config);
      const engine = new LifecycleHookEngine();
      const result = registerDiscoveredExternalLifecycleHooks(engine, {
        rootDir: projectRoot,
        trustResolved: true,
        projectTrustApprovalIds: { [config]: approvalId },
      });
      expect(result.skipped).toEqual([]);
      expect(result.registered).toBe(2);
      expect(engine.hookCountFor('pre_compact')).toBe(1);
      expect(engine.hookCountFor('pre_tool_use')).toBe(1);
      await result.dispose();
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(projectRoot, { recursive: true, force: true });
        if (approvalId) {
          safeRmSync(approvalRequestLogicalPath('project-trust', approvalId), { force: true });
        }
      });
    }
  });

  it('skips a project hook config path replaced by a directory', () => {
    const projectRoot = pathResolver.shared(`tmp/external-hook-directory-project-${process.pid}`);
    const configPath = `${projectRoot}/.claude/settings.json`;
    try {
      safeMkdir(configPath, { recursive: true });
      expect(discoverExternalHookConfigs({ rootDir: projectRoot })).toEqual([]);
    } finally {
      safeRmSync(projectRoot, { recursive: true, force: true });
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
