import { describe, expect, it } from 'vitest';
import { checkCliManifest, loadCliManifest } from './check_cli_manifest.js';

describe('CLI manifest', () => {
  it('accepts the repository command map', () => {
    expect(checkCliManifest(loadCliManifest())).toEqual([]);
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
});
