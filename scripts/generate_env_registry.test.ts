import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import {
  classifyEnvName,
  describeDiscoveredEnv,
  discoverEnvNames,
  mergeRegistry,
  validateEnvRegistryQuality,
  type EnvRegistryFile,
} from './generate_env_registry.js';

describe('classifyEnvName', () => {
  it('classifies secrets, paths, flags, tuning, and providers', () => {
    expect(classifyEnvName('KYBERION_API_TOKEN').category).toBe('secret');
    expect(classifyEnvName('KYBERION_BACKUP_PASSPHRASE')).toEqual({
      category: 'secret',
      type: 'string',
    });
    expect(classifyEnvName('KYBERION_SMTP_PASS')).toEqual({
      category: 'secret',
      type: 'string',
    });
    expect(classifyEnvName('KYBERION_A2A_SIGNATURE').category).toBe('runtime');
    expect(classifyEnvName('KYBERION_GATE_OVERRIDE_SIGNATURE').category).toBe('runtime');
    expect(classifyEnvName('KYBERION_AGENT_RING')).toEqual({
      category: 'tuning',
      type: 'number',
    });
    expect(classifyEnvName('KYBERION_CLAUDE_CLI_BIN').category).toBe('path');
    expect(classifyEnvName('KYBERION_ALLOW_FILE_SECRETS')).toEqual({
      category: 'flag',
      type: 'boolean',
    });
    expect(classifyEnvName('KYBERION_AUDIT_FORWARDER_TIMEOUT_MS')).toEqual({
      category: 'tuning',
      type: 'number',
    });
    expect(classifyEnvName('KYBERION_LOCAL_LLM_URL').category).toBe('provider');
    expect(classifyEnvName('KYBERION_SOMETHING_ELSE').category).toBe('runtime');
    expect(classifyEnvName('KYBERION_STT_WINDOW_SEC')).toEqual({
      category: 'tuning',
      type: 'number',
    });
  });
});

describe('discoverEnvNames', () => {
  const fixtureRoot = pathResolver.sharedTmp('generate-env-registry-tests');

  afterEach(() => {
    safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('covers Python runtime bridges while ignoring tests and dynamic prefixes', () => {
    const scriptsRoot = path.join(fixtureRoot, 'scripts');
    safeMkdir(scriptsRoot, { recursive: true });
    safeWriteFile(
      path.join(scriptsRoot, 'voice_bridge.py'),
      ['os.environ.get("KYBERION_PYTHON_ONLY")', 'os.environ.get("KYBERION_DYNAMIC_${role}")'].join(
        '\n'
      )
    );
    safeWriteFile(path.join(scriptsRoot, 'voice_bridge.test.py'), 'KYBERION_TEST_ONLY\n');

    const discovered = discoverEnvNames(fixtureRoot);
    expect(discovered).toContain('KYBERION_PYTHON_ONLY');
    expect(discovered).not.toContain('KYBERION_TEST_ONLY');
    expect(discovered).not.toContain('KYBERION_DYNAMIC_');
  });
});

describe('mergeRegistry', () => {
  const existing: EnvRegistryFile = {
    version: '1.0.0',
    description: 'test registry',
    entries: [
      {
        name: 'KYBERION_KEPT',
        category: 'flag',
        type: 'boolean',
        required: true,
        description: 'curated description',
        documented: true,
      },
      {
        name: 'KYBERION_REMOVED',
        category: 'runtime',
        type: 'string',
        required: false,
        description: '',
        documented: false,
      },
    ],
  };

  it('preserves curated fields, adds new names, and drops unreferenced ones', () => {
    const merged = mergeRegistry(['KYBERION_KEPT', 'KYBERION_NEW_TIMEOUT_MS'], existing);
    expect(merged.entries.map((entry) => entry.name)).toEqual([
      'KYBERION_KEPT',
      'KYBERION_NEW_TIMEOUT_MS',
    ]);
    const kept = merged.entries[0];
    expect(kept.description).toBe('curated description');
    expect(kept.required).toBe(true);
    expect(kept.documented).toBe(true);
    const added = merged.entries[1];
    expect(added.category).toBe('tuning');
    expect(added.documented).toBe(false);
  });

  it('promotes an existing undocumented discovery entry with a safe explanation', () => {
    const merged = mergeRegistry(['KYBERION_EXISTING_TIMEOUT_MS'], {
      version: '1.0.0',
      description: 'test registry',
      entries: [
        {
          name: 'KYBERION_EXISTING_TIMEOUT_MS',
          category: 'runtime',
          type: 'string',
          required: false,
          description: '',
          documented: false,
        },
      ],
    });
    expect(merged.entries[0].documented).toBe(true);
    expect(merged.entries[0].description).toContain('numeric tuning value');
  });

  it('bootstraps a registry when none exists', () => {
    const merged = mergeRegistry(['KYBERION_A'], null);
    expect(merged.version).toBe('1.0.0');
    expect(merged.entries).toHaveLength(1);
  });
});

describe('describeDiscoveredEnv', () => {
  it('provides operator guidance for every registry category', () => {
    expect(describeDiscoveredEnv('KYBERION_EXAMPLE_PATH', 'path')).toContain('path override');
    expect(describeDiscoveredEnv('KYBERION_EXAMPLE_LIMIT', 'tuning')).toContain(
      'numeric tuning value'
    );
    expect(describeDiscoveredEnv('KYBERION_EXAMPLE', 'runtime')).toContain('runtime setting');
    expect(describeDiscoveredEnv('KYBERION_EXAMPLE_URL', 'provider')).toContain('provider setting');
    expect(describeDiscoveredEnv('KYBERION_ENABLE_EXAMPLE', 'flag')).toContain('feature flag');
    expect(describeDiscoveredEnv('KYBERION_EXAMPLE_TOKEN', 'secret')).toContain('Secret value');
  });
});

describe('validateEnvRegistryQuality', () => {
  const base = (entry: Partial<EnvRegistryFile['entries'][number]>): EnvRegistryFile => ({
    version: '1.0.0',
    description: 'test',
    entries: [
      {
        name: 'KYBERION_TEST',
        category: 'runtime',
        type: 'string',
        required: false,
        description: '',
        documented: false,
        ...entry,
      },
    ],
  });

  it('requires descriptions for required or documented variables', () => {
    expect(validateEnvRegistryQuality(base({ required: true, documented: true }))).toEqual([
      'KYBERION_TEST: required/documented entries must have a description',
    ]);
    expect(validateEnvRegistryQuality(base({ documented: true }))).toEqual([
      'KYBERION_TEST: required/documented entries must have a description',
    ]);
  });

  it('requires unconditional settings to be operator-documented', () => {
    expect(
      validateEnvRegistryQuality(
        base({ required: true, documented: false, description: 'startup prerequisite' })
      )
    ).toEqual(['KYBERION_TEST: required entries must be documented']);
  });

  it('rejects required secrets', () => {
    expect(
      validateEnvRegistryQuality(
        base({ category: 'secret', required: true, documented: true, description: 'test secret' })
      )
    ).toEqual(['KYBERION_TEST: secrets may not be required through the shared registry']);
  });

  it('rejects secret defaults and non-opaque secret types without requiring secrets', () => {
    expect(
      validateEnvRegistryQuality(
        base({
          category: 'secret',
          description: 'credential',
          documented: true,
          default: 'placeholder',
        })
      )
    ).toEqual(['KYBERION_TEST: secrets may not define a registry default']);
    expect(
      validateEnvRegistryQuality(
        base({ category: 'secret', type: 'number', description: 'credential', documented: true })
      )
    ).toEqual(['KYBERION_TEST: secrets must use the opaque string type']);
  });

  it('requires secret variables to be operator-documented', () => {
    expect(validateEnvRegistryQuality(base({ category: 'secret' }))).toEqual([
      'KYBERION_TEST: secret entries must be documented',
    ]);
  });

  it('requires feature flags to be operator-documented', () => {
    expect(validateEnvRegistryQuality(base({ category: 'flag' }))).toEqual([
      'KYBERION_TEST: flag entries must be documented',
    ]);
  });

  it('accepts optional undocumented discovery entries', () => {
    expect(validateEnvRegistryQuality(base({}))).toEqual([]);
  });

  it('rejects malformed, duplicate, and non-canonical entries without throwing', () => {
    const registry = {
      version: '1.0.0',
      description: 'test',
      entries: [
        { documented: false },
        {
          name: 'KYBERION_DUPLICATE',
          category: 'runtime',
          type: 'string',
          required: false,
          description: '',
          documented: false,
        },
        {
          name: 'KYBERION_DUPLICATE',
          category: 'runtime',
          type: 'string',
          required: false,
          description: '',
          documented: false,
        },
        {
          name: 'KYBERION_DYNAMIC_',
          category: 'unknown',
          type: 'enum',
          required: false,
          description: '',
          documented: false,
          enum: ['same', 'same'],
        },
      ],
    } as unknown as EnvRegistryFile;

    expect(validateEnvRegistryQuality(registry)).toEqual([
      'entries[0]: name must match KYBERION_[A-Z0-9_]+ and not end with an underscore',
      'entries[0]: category must be one of secret, path, flag, tuning, provider, runtime',
      'entries[0]: type must be one of string, boolean, number, enum, path',
      'entries[0]: required must be boolean',
      'entries[0]: description must be a string',
      'KYBERION_DUPLICATE: duplicate registry entry',
      'KYBERION_DYNAMIC_: name must match KYBERION_[A-Z0-9_]+ and not end with an underscore',
      'KYBERION_DYNAMIC_: category must be one of secret, path, flag, tuning, provider, runtime',
      'KYBERION_DYNAMIC_: enum values must be unique',
    ]);
  });
});
