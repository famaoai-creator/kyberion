import { describe, expect, it } from 'vitest';
import {
  assertRequiredEnvironment,
  formatCliManifestHelp,
  main,
  resolveCommand,
  resolveCommandPath,
  resolveScriptCommand,
  selectEntrypoint,
  validateKyberionStartupEnvironment,
} from './kyberion.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('kyberion command router', () => {
  it('routes operator-home commands through the home entrypoint', () => {
    expect(selectEntrypoint('ask').id).toBe('operator-home');
    expect(selectEntrypoint('').id).toBe('operator-home');
  });

  it('routes catalog and workflow commands through the operator CLI', () => {
    expect(selectEntrypoint('list').id).toBe('operator-cli');
    expect(selectEntrypoint('schedule').id).toBe('operator-cli');
  });

  it('routes pipeline execution through the governed single entrypoint', () => {
    expect(selectEntrypoint('pipeline').id).toBe('pipeline-runner');
    expect(resolveCommandPath(['pipeline', '--input', 'pipelines/baseline-check.json'])).toBe(
      'pipeline'
    );
  });

  it('routes readiness reporting through the existing vital checker', () => {
    expect(selectEntrypoint('vital').id).toBe('operator-readiness');
    expect(resolveCommandPath(['vital', '--format', 'json'])).toBe('vital');
    expect(resolveScriptCommand('vital json')).toBeUndefined();
  });

  it('routes setup and voice readiness through existing governed scripts', () => {
    expect(selectEntrypoint('setup report').id).toBe('operator-setup');
    expect(selectEntrypoint('voice setup').id).toBe('operator-voice');
    expect(resolveCommandPath(['setup', 'report', '--json'])).toBe('setup report');
    expect(resolveCommandPath(['voice', 'setup', '--apply'])).toBe('voice setup');
    expect(resolveScriptCommand('voice setup')).toBeUndefined();
    expect(resolveScriptCommand('calendar workflow')).toBeUndefined();
  });

  it('resolves governed noun/verb paths before payload arguments', () => {
    expect(resolveCommandPath(['schedule', 'register', 'nightly', 'pipelines/x.json'])).toBe(
      'schedule register'
    );
    expect(resolveCommandPath(['task', 'plan', 'prepare the report'])).toBe('task plan');
    expect(resolveCommandPath(['task', 'scenario', 'list'])).toBe('task scenario');
    expect(selectEntrypoint('email status').id).toBe('operator-cli');
  });

  it('routes organization and project controllers through the governed registry', () => {
    expect(selectEntrypoint('organization').id).toBe('organization-model');
    expect(selectEntrypoint('project').id).toBe('project-controller');
    expect(resolveCommandPath(['organization', 'role', 'create'])).toBe('organization');
  });

  it('resolves script-backed commands from the same registry', () => {
    expect(resolveCommandPath(['backup', '--dry-run'])).toBe('backup');
    expect(resolveScriptCommand('backup')).toMatchObject({
      script: 'backup',
      command: 'backup default',
      audience: 'operator',
    });
    expect(resolveCommandPath(['onboard', 'apply', '--identity', 'identity.json'])).toBe('onboard');
    expect(resolveCommandPath(['onboard', 'reset', '--force'])).toBe('onboard');
  });

  it('dispatches module-backed commands without a package-script alias', async () => {
    expect(resolveScriptCommand('chronos uninstall')).toMatchObject({
      module: 'scripts/install_chronos_launchd.ts',
      args: ['--uninstall'],
    });

    const output: unknown[] = [];
    await main(['chronos', 'uninstall'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.stringContaining('Uninstall steps'));
  });

  it('keeps verification and authentication tools module-backed', () => {
    expect(resolveScriptCommand('auth check')).toMatchObject({
      module: 'scripts/reasoning_auth_check.ts',
      command: 'auth check',
    });
    expect(resolveScriptCommand('check backend-conformance')).toMatchObject({
      module: 'scripts/check_backend_conformance.ts',
    });
    expect(resolveScriptCommand('inventory resource-loaders')).toMatchObject({
      module: 'scripts/inventory_resource_loaders.ts',
    });
    expect(resolveScriptCommand('check script-integrity')).toMatchObject({
      module: 'scripts/check_script_integrity.ts',
    });
    expect(resolveScriptCommand('check improvement-plan-metadata')).toMatchObject({
      module: 'scripts/check_improvement_plan_metadata.ts',
    });
  });

  it('rejects unknown commands instead of falling back to an executable surface', () => {
    expect(() => selectEntrypoint('unknown-command')).toThrow('Unknown kyberion command');
  });

  it('fails closed when the command registry and entrypoint map disagree', () => {
    expect(() =>
      selectEntrypoint('ask', {
        version: 1,
        commands: [
          {
            id: 'operator-home.ask',
            command: 'ask',
            noun: 'ask',
            verb: 'default',
            entry: 'operator-home',
            audience: 'user',
          },
        ],
        entrypoints: [{ id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] }],
      })
    ).toThrow('CLI command registry mismatch');
  });

  it('keeps unknown registered entrypoints from falling through to operator-home', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain(
      'throw new Error(`Unsupported kyberion entrypoint: ${entrypoint.id}`)'
    );
  });

  it('fails closed when a dispatch key is defined more than once', () => {
    const manifest = {
      version: 1,
      commands: [
        {
          id: 'home-a',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user' as const,
        },
        {
          id: 'home-b',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user' as const,
        },
      ],
      entrypoints: [{ id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] }],
    };

    expect(() => selectEntrypoint('', manifest)).toThrow(
      'CLI command registry has duplicate command'
    );
    expect(() => resolveCommand('', manifest)).toThrow(
      'CLI command registry has duplicate command'
    );
  });

  it('exposes command metadata from the governed registry', () => {
    expect(resolveCommand('ask')).toMatchObject({
      noun: 'ask',
      verb: 'default',
      entry: 'operator-home',
      audience: 'user',
    });
  });

  it('renders help from every registered command instead of rejecting --help', () => {
    const help = formatCliManifestHelp({
      version: 1,
      commands: [
        {
          id: 'home',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user',
        },
        {
          id: 'ask',
          command: 'ask',
          noun: 'ask',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user',
        },
      ],
      entrypoints: [],
    });
    expect(help).toContain('<home>');
    expect(help).toContain('ask');
    expect(help).toContain('governed registry');
  });

  it('routes help output through the supplied harness printer', async () => {
    const output: unknown[] = [];
    const { main } = await import('./kyberion.js');
    await main(['--help'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.stringContaining('governed registry'));
  });

  it('ignores the pnpm `--` separator pnpm forwards literally (npm strips it)', async () => {
    const output: unknown[] = [];
    const { main } = await import('./kyberion.js');
    await main(['--', '--help'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.stringContaining('governed registry'));
  });

  it('does not write directly to stdout from the unified router', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log(');
  });

  it('fails closed when the startup environment misses a required registered setting', () => {
    expect(() =>
      assertRequiredEnvironment({
        errors: [{ name: 'KYBERION_REQUIRED_TOKEN', issue: 'required variable is not set' }],
      })
    ).toThrow('KYBERION_REQUIRED_TOKEN');
    expect(() => validateKyberionStartupEnvironment({})).not.toThrow();
  });

  it('names the escape hatch and the registry when startup validation fails', () => {
    let message = '';
    try {
      assertRequiredEnvironment({
        errors: [{ name: 'KYBERION_MYSTERY', issue: 'variable is not registered' }],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('knowledge/product/governance/env-registry.json');
    expect(message).toContain('pnpm generate:env-registry');
    expect(message).toContain('KYBERION_ENV_REGISTRY_STRICT=0');
  });

  it('fails closed on unknown environment variables when strict registry mode is enabled', () => {
    expect(() =>
      validateKyberionStartupEnvironment({
        KYBERION_ENV_REGISTRY_STRICT: '1',
        KYBERION_MYSTERY: '1',
      })
    ).toThrow('KYBERION_MYSTERY');
  });

  it('uses strict environment validation by default', () => {
    expect(() => validateKyberionStartupEnvironment({ KYBERION_MYSTERY: '1' })).toThrow(
      'KYBERION_MYSTERY'
    );
  });

  it('allows an explicit false opt-out for local compatibility', () => {
    expect(() =>
      validateKyberionStartupEnvironment({
        KYBERION_ENV_REGISTRY_STRICT: 'false',
        KYBERION_MYSTERY: '1',
      })
    ).not.toThrow();
  });
});
