import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkCliManifest, loadCliManifest } from './check_cli_manifest.js';

describe('CLI manifest', () => {
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
});
