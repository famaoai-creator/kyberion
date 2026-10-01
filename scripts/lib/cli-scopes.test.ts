import { describe, expect, it } from 'vitest';
import type { CliCommand, CliManifest } from '../check_cli_manifest.js';
import {
  findDeprecatedCommandAlias,
  formatScopeUsage,
  formatUnknownScope,
  rewriteDeprecatedCommand,
  routeScopedCommand,
} from './cli-scopes.js';

const flagCommand = {
  command: 'doctor',
  scope_selector: 'flag',
  scopes: [
    { id: 'env', description: 'cli_cmd_script_doctor', routes_to: ['vital'] },
    { id: 'service', description: 'cli_cmd_script_doctor', routes_to: ['service', 'preflight'] },
  ],
} as unknown as CliCommand;

const positionalCommand = {
  command: 'setup',
  scopes: [{ id: 'env', description: 'cli_cmd_script_doctor', routes_to: ['env', 'bootstrap'] }],
} as unknown as CliCommand;

describe('cli-scopes', () => {
  it('routes `--scope x` and `--scope=x`, keeping the remaining arguments', () => {
    expect(routeScopedCommand(flagCommand, ['doctor', '--scope', 'service', '--json'])).toEqual({
      kind: 'route',
      scope: 'service',
      args: ['service', 'preflight', '--json'],
    });
    expect(routeScopedCommand(flagCommand, ['doctor', '--scope=env'])).toEqual({
      kind: 'route',
      scope: 'env',
      args: ['vital'],
    });
  });

  it('leaves the bare command alone and reports unknown / missing scopes', () => {
    expect(routeScopedCommand(flagCommand, ['doctor'])).toEqual({ kind: 'none' });
    expect(routeScopedCommand(flagCommand, ['doctor', '--scope', 'nope'])).toEqual({
      kind: 'unknown',
      scope: 'nope',
    });
    expect(routeScopedCommand(flagCommand, ['doctor', '--scope'])).toEqual({
      kind: 'unknown',
      scope: '',
    });
  });

  it('routes a positional area for commands without a flag selector', () => {
    expect(routeScopedCommand(positionalCommand, ['setup', 'env', '--x'])).toMatchObject({
      kind: 'route',
      args: ['env', 'bootstrap', '--x'],
    });
    expect(routeScopedCommand(positionalCommand, ['setup', '--x'])).toEqual({ kind: 'none' });
  });

  it('formats scope usage per selector style and lists scopes for an unknown one', () => {
    expect(formatScopeUsage(flagCommand)).toBe('--scope env|service');
    expect(formatScopeUsage(positionalCommand)).toBe('<env>');
    expect(formatUnknownScope(flagCommand, 'nope', 'en')).toContain('env, service');
  });

  it('rewrites a deprecated command alias and keeps passthrough arguments', () => {
    const manifest = {
      deprecated_command_aliases: [{ command: 'onboard', replaced_by: 'onboarding default' }],
    } as unknown as CliManifest;
    const alias = findDeprecatedCommandAlias('onboard', manifest);
    expect(alias).toBeDefined();
    expect(rewriteDeprecatedCommand(alias!, ['onboard', 'apply', '--identity', 'x'])).toEqual([
      'onboarding',
      'default',
      'apply',
      '--identity',
      'x',
    ]);
    expect(findDeprecatedCommandAlias('nope', manifest)).toBeUndefined();
  });
});
