import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  checkCliManifest,
  loadCliManifest,
  MAX_PACKAGE_SCRIPTS,
  resolveCliModulePath,
} from './check_cli_manifest.js';

describe('CLI manifest', () => {
  it('uses the governed package manifest loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_cli_manifest.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('readJson<{ scripts?: Record<string, string> }>(');
  });

  it('accepts the repository command map', () => {
    expect(checkCliManifest(loadCliManifest())).toEqual([]);
  });

  it('keeps operator home command rendering on the governed manifest loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/operator-home-view.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("import { loadCliManifest } from './check_cli_manifest.js'");
    expect(source).toContain('const registry = loadCliManifest()');
    expect(source).not.toContain('readJson<{');
  });

  it('requires a command registry entry for every routed command', () => {
    const failures = checkCliManifest({
      version: 1,
      commands: [
        {
          id: 'operator-home.default',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user',
        },
      ],
      entrypoints: [
        { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: ['', 'ask'] },
        { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
      ],
    });
    expect(failures).toContain('entrypoint command missing registry entry: ask');
    expect(failures).toContain('entrypoint command missing registry entry: help');
  });

  it('rejects duplicate dispatch keys even when command ids differ', () => {
    const failures = checkCliManifest({
      version: 1,
      commands: [
        {
          id: 'home-a',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user',
        },
        {
          id: 'home-b',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user',
        },
      ],
      entrypoints: [
        { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] },
        { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
      ],
    });

    expect(failures).toContain('command must be unique: <default>');
  });

  it('rejects duplicate command ownership and missing modules', () => {
    const failures = checkCliManifest({
      version: 1,
      commands: [],
      entrypoints: [
        { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: ['', 'ask'] },
        { id: 'operator-cli', module: 'missing.ts', commands: ['ask'] },
      ],
    });
    expect(failures).toContain('command is claimed by multiple entrypoints: ask');
    expect(failures).toContain('operator-cli: module does not exist: missing.ts');
  });

  it('keeps package scripts synchronized with the noun/verb registry', () => {
    const failures = checkCliManifest(
      {
        version: 1,
        commands: [
          {
            id: 'operator-home.default',
            command: '',
            noun: 'home',
            verb: 'default',
            entry: 'operator-home',
            audience: 'user',
          },
          {
            id: 'operator-cli.help',
            command: 'help',
            noun: 'help',
            verb: 'default',
            entry: 'operator-cli',
            audience: 'user',
          },
        ],
        entrypoints: [
          { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] },
          { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
        ],
        script_commands: [
          {
            id: 'script.good',
            script: 'good',
            command: 'good run',
            noun: 'good',
            verb: 'run',
            audience: 'operator',
          },
          {
            id: 'script.stale',
            script: 'stale',
            command: 'stale default',
            noun: 'stale',
            verb: 'default',
            audience: 'operator',
          },
        ],
      },
      { packageScripts: new Set(['good', 'missing']) }
    );

    expect(failures).toContain('script command references missing package script: stale');
    expect(failures).toContain('package script missing command registry entry: missing');
  });

  it('rejects ambiguous script dispatch keys across both registries', () => {
    const failures = checkCliManifest(
      {
        version: 1,
        commands: [
          {
            id: 'operator-home.default',
            command: '',
            noun: 'home',
            verb: 'default',
            entry: 'operator-home',
            audience: 'user',
          },
          {
            id: 'operator-cli.help',
            command: 'help',
            noun: 'help',
            verb: 'default',
            entry: 'operator-cli',
            audience: 'user',
          },
        ],
        entrypoints: [
          { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] },
          { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
        ],
        script_commands: [
          {
            id: 'script.help-alias',
            script: 'help-alias',
            command: 'help',
            noun: 'help',
            verb: 'default',
            audience: 'dev',
          },
          {
            id: 'script.duplicate-a',
            script: 'duplicate-a',
            command: 'duplicate run',
            noun: 'duplicate',
            verb: 'run',
            audience: 'dev',
          },
          {
            id: 'script.duplicate-b',
            script: 'duplicate-b',
            command: 'duplicate run',
            noun: 'duplicate',
            verb: 'run',
            audience: 'dev',
          },
        ],
      },
      { packageScripts: new Set(['help-alias', 'duplicate-a', 'duplicate-b']) }
    );

    expect(failures).toContain('script command collides with command registry: help');
    expect(failures).toContain('script command must be unique: duplicate run');
  });

  it('accepts module-backed commands after their package alias is removed', () => {
    const failures = checkCliManifest(
      {
        version: 1,
        commands: [
          {
            id: 'operator-home.default',
            command: '',
            noun: 'home',
            verb: 'default',
            entry: 'operator-home',
            audience: 'user',
          },
        ],
        entrypoints: [
          { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] },
          { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
        ],
        script_commands: [
          {
            id: 'module.command',
            module: 'scripts/install_chronos_launchd.ts',
            args: ['--uninstall'],
            command: 'chronos uninstall',
            noun: 'chronos',
            verb: 'uninstall',
            audience: 'operator',
          },
        ],
      },
      { packageScripts: new Set() }
    );

    expect(failures).toEqual(['entrypoint command missing registry entry: help']);
  });

  it('enforces the package-script count ratchet', () => {
    const failures = checkCliManifest(
      {
        version: 1,
        commands: [
          {
            id: 'operator-home.default',
            command: '',
            noun: 'home',
            verb: 'default',
            entry: 'operator-home',
            audience: 'user',
          },
        ],
        entrypoints: [
          { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] },
          { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
        ],
      },
      {
        packageScripts: new Set(Array.from({ length: MAX_PACKAGE_SCRIPTS + 1 }, (_, i) => `s${i}`)),
      }
    );

    expect(failures).toContain(
      `package scripts exceed the SX-05 ratchet: ${MAX_PACKAGE_SCRIPTS + 1} > ${MAX_PACKAGE_SCRIPTS}`
    );
  });

  it('rejects CLI modules outside the repository root', () => {
    expect(() => resolveCliModulePath('../outside.ts')).toThrow(
      '[RESOURCE_PATH_SCOPE] resource path is outside the repository root'
    );
    expect(() => resolveCliModulePath('/tmp/outside.ts')).toThrow(
      '[RESOURCE_PATH_SCOPE] resource path is outside the repository root'
    );
  });
});
