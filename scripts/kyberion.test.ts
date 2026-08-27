import { describe, expect, it } from 'vitest';
import {
  assertRequiredEnvironment,
  formatCliManifestHelp,
  resolveCommand,
  selectEntrypoint,
  validateKyberionStartupEnvironment,
} from './kyberion.js';

describe('kyberion command router', () => {
  it('routes operator-home commands through the home entrypoint', () => {
    expect(selectEntrypoint('ask').id).toBe('operator-home');
    expect(selectEntrypoint('').id).toBe('operator-home');
  });

  it('routes catalog and workflow commands through the operator CLI', () => {
    expect(selectEntrypoint('list').id).toBe('operator-cli');
    expect(selectEntrypoint('schedule').id).toBe('operator-cli');
  });

  it('routes organization and project controllers through the governed registry', () => {
    expect(selectEntrypoint('organization').id).toBe('organization-model');
    expect(selectEntrypoint('org').id).toBe('organization-roles');
    expect(selectEntrypoint('project').id).toBe('project-controller');
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

  it('fails closed when the startup environment misses a required registered setting', () => {
    expect(() =>
      assertRequiredEnvironment({
        errors: [{ name: 'KYBERION_REQUIRED_TOKEN', issue: 'required variable is not set' }],
      })
    ).toThrow('KYBERION_REQUIRED_TOKEN');
    expect(() => validateKyberionStartupEnvironment({})).not.toThrow();
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
