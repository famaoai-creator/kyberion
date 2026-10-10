import { describe, expect, it } from 'vitest';
import {
  assertRequiredEnvironment,
  formatCliManifestHelp,
  main,
  resolveCommand,
  resolveCommandPath,
  resolveScriptCommand,
  rewriteRoutedArgs,
  selectEntrypoint,
  validateKyberionStartupEnvironment,
} from './kyberion.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { loadCliManifest } from './check_cli_manifest.js';

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
    expect(resolveCommandPath(['onboarding', 'apply', '--identity', 'identity.json'])).toBe(
      'onboarding'
    );
    expect(resolveCommandPath(['onboarding', 'reset', '--force'])).toBe('onboarding');
    expect(resolveCommandPath(['onboarding', 'context', '--json'])).toBe('onboarding context');
  });

  it('dispatches module-backed commands without a package-script alias', async () => {
    expect(resolveScriptCommand('scheduler uninstall')).toMatchObject({
      module: 'scripts/install_chronos_launchd.ts',
      args: ['--uninstall'],
    });

    const output: unknown[] = [];
    await main(['scheduler', 'uninstall'], (value) => output.push(value));
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
    expect(() => selectEntrypoint('unknown-command')).toThrow('CLI_UNKNOWN_COMMAND');
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
    expect(source).toContain('CLI_ENTRYPOINT_UNSUPPORTED');
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
    // Entries without a description key fall back to `noun verb`.
    expect(help).toContain('ask default');
  });

  it('routes help output through the supplied harness printer', async () => {
    const output: unknown[] = [];
    const { main } = await import('./kyberion.js');
    await main(['--help'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.stringContaining('pr create'));
  });

  it('ignores the pnpm `--` separator pnpm forwards literally (npm strips it)', async () => {
    const output: unknown[] = [];
    const { main } = await import('./kyberion.js');
    await main(['--', '--help'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(expect.stringContaining('pr create'));
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

  it('is strict by default in CI', () => {
    expect(() => validateKyberionStartupEnvironment({ CI: 'true', KYBERION_MYSTERY: '1' })).toThrow(
      'KYBERION_MYSTERY'
    );
  });

  it('warns once and continues on unknown variables outside CI', () => {
    expect(() => validateKyberionStartupEnvironment({ KYBERION_MYSTERY: '1' })).not.toThrow();
    expect(() =>
      validateKyberionStartupEnvironment({ CI: 'false', KYBERION_MYSTERY: '1' })
    ).not.toThrow();
  });

  it('still fails on invalid values of known variables outside CI', () => {
    expect(() =>
      validateKyberionStartupEnvironment({ KYBERION_ENV_REGISTRY_STRICT_DOCS: 'banana' })
    ).toThrow('KYBERION_ENV_REGISTRY_STRICT_DOCS');
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

describe('CU-08 removed command aliases stay removed', () => {
  const manifest = loadCliManifest();

  it('leaves removed command names unrouted and silent (no alias, no scope)', () => {
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    expect(rewriteRoutedArgs(['customer', 'create', '--slug', 'acme'], manifest, warn)).toEqual([
      'customer',
      'create',
      '--slug',
      'acme',
    ]);
    expect(rewriteRoutedArgs(['onboard', 'apply'], manifest, warn)).toEqual(['onboard', 'apply']);
    expect(rewriteRoutedArgs(['chronos'], manifest, warn)).toEqual(['chronos']);
    expect(rewriteRoutedArgs(['dev'], manifest, warn)).toEqual(['dev']);
    expect(warnings).toEqual([]);
  });

  it('rejects removed command names end to end', async () => {
    await expect(main(['customer', 'create', '--slug', 'acme'], () => undefined)).rejects.toThrow(
      /customer create/u
    );
    await expect(main(['onboard', 'apply'], () => undefined)).rejects.toThrow(/onboard apply/u);
    await expect(main(['chronos', 'uninstall'], () => undefined)).rejects.toThrow(
      /chronos uninstall/u
    );
  });

  it('leaves current command names untouched and silent', () => {
    const warnings: string[] = [];
    const args = ['stance', 'list', '--json'];
    expect(rewriteRoutedArgs(args, manifest, (message) => warnings.push(message))).toEqual(args);
    expect(warnings).toEqual([]);
  });
});

describe('CU-09 doctor scopes and setup areas', () => {
  const manifest = loadCliManifest();
  const silent = (): void => undefined;

  it('keeps bare doctor (and its own flags) on the doctor entrypoint', () => {
    expect(rewriteRoutedArgs(['doctor'], manifest, silent)).toEqual(['doctor']);
    expect(rewriteRoutedArgs(['doctor', '--runtime', 'app'], manifest, silent)).toEqual([
      'doctor',
      '--runtime',
      'app',
    ]);
  });

  it('delegates each doctor --scope to the existing diagnostic', () => {
    const route = (...args: string[]) => rewriteRoutedArgs(['doctor', ...args], manifest, silent);
    expect(route('--scope', 'env')).toEqual(['vital']);
    expect(route('--scope', 'service', '--service', 'slack')).toEqual([
      'service',
      'preflight',
      '--service',
      'slack',
    ]);
    expect(route('--scope=meeting', '--json')).toEqual(['meeting', 'preflight', '--json']);
    expect(route('--scope', 'voice')).toEqual(['doctor', '--runtime', 'voice']);
    expect(route('--scope', 'app')).toEqual(['doctor', '--runtime', 'app']);
    expect(route('--scope', 'setup')).toEqual(['setup', 'report']);
    for (const scope of ['env', 'service', 'voice', 'meeting', 'app', 'setup']) {
      const routed = route('--scope', scope);
      expect(
        resolveCommand(resolveCommandPath(routed)) ??
          resolveScriptCommand(resolveCommandPath(routed))
      ).toBeDefined();
    }
  });

  it('delegates each setup area to the existing setup command', () => {
    const route = (...args: string[]) => rewriteRoutedArgs(['setup', ...args], manifest, silent);
    expect(route('onboarding', '--express')).toEqual(['onboarding', '--express']);
    expect(route('context')).toEqual(['onboarding', 'context']);
    expect(route('reasoning')).toEqual(['reasoning', 'setup']);
    expect(route('env', '--manifest', 'x', '--apply')).toEqual([
      'env',
      'bootstrap',
      '--manifest',
      'x',
      '--apply',
    ]);
    expect(route('services')).toEqual(['service', 'setup']);
    expect(route('tools', '--list')).toEqual(['tool', 'setup', '--list']);
    expect(route('provider-cli')).toEqual(['provider-cli', 'setup']);
    expect(route('agy-sdk')).toEqual(['agy', 'sdk-setup']);
    expect(route('voice', '--apply')).toEqual(['voice', 'setup', '--apply']);
    expect(route('config')).toEqual(['config-mission']);
    // `setup report` stays its own governed command.
    expect(route('report', '--json')).toEqual(['setup', 'report', '--json']);
  });

  it('fails closed with the scope list on an unknown scope or area', () => {
    expect(() => rewriteRoutedArgs(['doctor', '--scope', 'nope'], manifest, silent)).toThrow(
      /env, service, voice, meeting, app, setup/u
    );
    expect(() => rewriteRoutedArgs(['doctor', '--scope'], manifest, silent)).toThrow(/<missing>/u);
    expect(() => rewriteRoutedArgs(['setup', 'nope'], manifest, silent)).toThrow(/onboarding/u);
  });

  it('lists the setup areas for a bare `setup`', async () => {
    const output: unknown[] = [];
    await main(['setup', '--locale', 'en'], (value) => output.push(value));
    const text = String(output[0]);
    expect(text).toContain('pnpm kyberion setup <onboarding|');
    expect(text).toContain('runs pnpm kyberion env bootstrap');
  });
});
