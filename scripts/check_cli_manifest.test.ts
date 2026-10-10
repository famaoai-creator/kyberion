import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  checkCliManifest,
  loadCliManifest,
  MAX_PACKAGE_SCRIPTS,
  resolveCliModulePath,
  scriptNameViolation,
  type CliManifest,
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
            description: 'cli_cmd_script_chronos_uninstall',
            group: 'operate',
          },
        ],
      },
      { packageScripts: new Set() }
    );

    expect(failures).toEqual([
      'command operator-home.default must declare a cli_cmd_* description vocabulary key',
      'command operator-home.default must declare a help group (start, inspect, operate, dev)',
      'entrypoint command missing registry entry: help',
    ]);
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

  describe('CU-05 governed vs script name collisions', () => {
    const governed = {
      id: 'operator-home.doctor',
      command: 'doctor',
      noun: 'doctor',
      verb: 'default',
      entry: 'operator-home',
      audience: 'user' as const,
      description: 'cli_cmd_operator_home_doctor',
      group: 'start' as const,
    };
    const base = {
      version: 1,
      commands: [
        {
          id: 'operator-home.default',
          command: '',
          noun: 'home',
          verb: 'default',
          entry: 'operator-home',
          audience: 'user' as const,
          description: 'cli_cmd_operator_home_default',
          group: 'start' as const,
        },
        governed,
      ],
      entrypoints: [
        { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: ['', 'doctor'] },
        { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
      ],
    };
    const scriptDoctor = {
      id: 'script.doctor',
      script: 'doctor',
      command: 'doctor default',
      noun: 'doctor',
      verb: 'default',
      audience: 'operator' as const,
      description: 'cli_cmd_script_doctor',
      group: 'start' as const,
    };

    it('rejects a script-backed default shadowed by a governed command', () => {
      const failures = checkCliManifest(
        { ...base, script_commands: [scriptDoctor] },
        { packageScripts: new Set(['doctor']) }
      );
      expect(failures).toContain(
        'script command script.doctor is shadowed by governed command operator-home.doctor ("doctor"); rename it or declare same_target_as'
      );
    });

    it('accepts the collision only when declared as the same target', () => {
      const ok = checkCliManifest(
        { ...base, script_commands: [{ ...scriptDoctor, same_target_as: 'operator-home.doctor' }] },
        { packageScripts: new Set(['doctor']) }
      );
      expect(ok.filter((failure) => failure.includes('script.doctor'))).toEqual([]);
      const wrong = checkCliManifest(
        {
          ...base,
          script_commands: [{ ...scriptDoctor, same_target_as: 'operator-home.default' }],
        },
        { packageScripts: new Set(['doctor']) }
      );
      expect(wrong).toContain(
        'script command script.doctor same_target_as must name the governed command routed as "doctor"'
      );
    });

    it('keeps the repository free of undeclared shadowing (intent:trace is canonical)', () => {
      const manifest = loadCliManifest();
      expect(manifest.script_commands?.find((c) => c.script === 'intent:trace')).toMatchObject({
        command: 'intent trace',
      });
      expect(manifest.deprecated_script_aliases ?? []).toEqual([]);
    });

    it('keeps deprecated aliases out of the ratchet and out of script_commands', () => {
      const failures = checkCliManifest(
        {
          ...base,
          script_commands: [{ ...scriptDoctor, same_target_as: 'operator-home.doctor' }],
          deprecated_script_aliases: [
            { script: 'old-doctor', replaced_by: 'doctor' },
            { script: 'old-ghost', replaced_by: 'ghost' },
          ],
        },
        { packageScripts: new Set(['doctor', 'old-doctor']) }
      );
      expect(failures).not.toContain('package script missing command registry entry: old-doctor');
      expect(failures).toContain(
        'deprecated script alias references missing package script: old-ghost'
      );
      expect(failures).toContain(
        'deprecated script alias old-ghost must point at a registered script: ghost'
      );
    });
  });

  it('requires a dev help group exactly for dev-audience commands', () => {
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
            description: 'cli_cmd_operator_home_default',
            group: 'dev',
          },
        ],
        entrypoints: [
          { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] },
          { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
        ],
      },
      { packageScripts: new Set() }
    );
    expect(failures).toContain(
      'command operator-home.default must use the dev help group exactly when its audience is dev'
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

describe('CU-08 package script naming', () => {
  it('accepts noun / noun:verb names and the verb-first toolchain families', () => {
    for (const name of [
      'mission',
      'stance:create',
      'knowledge:ingest',
      'agent-runtime:supervisor',
      'build:actuators',
      'generate:env-registry',
      'check:pr-title',
      'test:watch',
      'verify',
      'typecheck',
    ]) {
      expect(scriptNameViolation(name)).toBeUndefined();
    }
  });

  it('rejects verb-first, three-segment and non-kebab names', () => {
    expect(scriptNameViolation('report:i18n-coverage')).toContain('starts with a verb');
    expect(scriptNameViolation('migrate:physical-namespaces')).toContain('starts with a verb');
    expect(scriptNameViolation('export:validation-bundle')).toContain('starts with a verb');
    expect(scriptNameViolation('onboard')).toContain('starts with a verb');
    expect(scriptNameViolation('ingest')).toContain('starts with a verb');
    expect(scriptNameViolation('agy:sdk:setup')).toContain('more than two segments');
    expect(scriptNameViolation('Customer:Create')).toContain('kebab-case');
  });

  it('exempts deprecated aliases but lints every other package script', () => {
    const manifest = loadCliManifest();
    const scripts = new Set(
      (manifest.script_commands ?? []).flatMap((command) =>
        command.script ? [command.script] : []
      )
    );
    for (const alias of manifest.deprecated_script_aliases ?? []) scripts.add(alias.script);
    expect(checkCliManifest(manifest, { packageScripts: scripts })).toEqual([]);
    scripts.add('export:everything');
    expect(checkCliManifest(manifest, { packageScripts: scripts })).toContain(
      'package script export:everything starts with a verb; name it noun:verb (e.g. everything:export)'
    );
  });

  it('keeps the manifest free of deprecated aliases (single canonical name per entry)', () => {
    const manifest = loadCliManifest();
    expect(manifest.deprecated_script_aliases ?? []).toEqual([]);
    expect(manifest.deprecated_command_aliases ?? []).toEqual([]);
  });
});

describe('CU-08 / CU-09 command aliases and scopes', () => {
  const base = (): CliManifest => ({
    version: 1,
    commands: [
      {
        id: 'operator-home.default',
        command: '',
        noun: 'home',
        verb: 'default',
        entry: 'operator-home',
        audience: 'user',
        description: 'cli_cmd_operator_home_default',
        group: 'start',
      },
      {
        id: 'operator-home.doctor',
        command: 'doctor',
        noun: 'doctor',
        verb: 'default',
        entry: 'operator-home',
        audience: 'user',
        description: 'cli_cmd_operator_home_doctor',
        group: 'start',
        scope_selector: 'flag',
        scopes: [{ id: 'env', routes_to: ['vital'], description: 'cli_scope_doctor_env' }],
      },
    ],
    entrypoints: [
      { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: ['', 'doctor'] },
      { id: 'operator-cli', module: 'scripts/cli.ts', commands: ['help'] },
    ],
  });

  it('requires scopes to route to a registered command', () => {
    const failures = checkCliManifest(base(), { packageScripts: new Set() });
    expect(failures).toContain(
      'command operator-home.doctor scope env must route to a registered command: vital'
    );
  });

  it('rejects positional scopes that route back into the same command', () => {
    const manifest = base();
    manifest.commands[1] = {
      ...manifest.commands[1]!,
      scope_selector: 'positional',
      scopes: [{ id: 'loop', routes_to: ['doctor', 'other'], description: 'cli_scope_loop' }],
    };
    expect(checkCliManifest(manifest, { packageScripts: new Set() })).toContain(
      'command operator-home.doctor scope loop must not route to another scope'
    );
  });

  it('rejects command aliases that shadow or point at nothing', () => {
    const manifest = {
      ...base(),
      deprecated_command_aliases: [
        { command: 'doctor', replaced_by: 'doctor' },
        { command: 'old', replaced_by: 'ghost' },
      ],
    };
    const failures = checkCliManifest(manifest, { packageScripts: new Set() });
    expect(failures).toContain('deprecated command alias shadows a registered command: doctor');
    expect(failures).toContain(
      'deprecated command alias old must point at a registered command: ghost'
    );
  });

  it('registers doctor scopes and setup areas in the repository manifest', () => {
    const manifest = loadCliManifest();
    const doctor = manifest.commands.find((command) => command.command === 'doctor');
    const setup = manifest.commands.find((command) => command.command === 'setup');
    expect(doctor?.scopes?.map((scope) => scope.id)).toEqual([
      'env',
      'service',
      'voice',
      'meeting',
      'app',
      'setup',
    ]);
    expect(setup?.scope_selector).toBe('positional');
    expect(setup?.scopes?.map((scope) => scope.id)).toEqual(
      expect.arrayContaining(['onboarding', 'reasoning', 'env', 'services', 'tools', 'voice'])
    );
  });
});
