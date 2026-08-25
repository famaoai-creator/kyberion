import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import {
  classifyEnvName,
  discoverEnvNames,
  mergeRegistry,
  validateEnvRegistryQuality,
  type EnvRegistryFile,
} from './generate_env_registry.js';

describe('classifyEnvName', () => {
  it('classifies secrets, paths, flags, tuning, and providers', () => {
    expect(classifyEnvName('KYBERION_API_TOKEN').category).toBe('secret');
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

  it('bootstraps a registry when none exists', () => {
    const merged = mergeRegistry(['KYBERION_A'], null);
    expect(merged.version).toBe('1.0.0');
    expect(merged.entries).toHaveLength(1);
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
        base({ category: 'secret', description: 'credential', default: 'placeholder' })
      )
    ).toEqual(['KYBERION_TEST: secrets may not define a registry default']);
    expect(
      validateEnvRegistryQuality(
        base({ category: 'secret', type: 'number', description: 'credential' })
      )
    ).toEqual(['KYBERION_TEST: secrets must use the opaque string type']);
  });

  it('accepts optional undocumented discovery entries', () => {
    expect(validateEnvRegistryQuality(base({}))).toEqual([]);
  });
});
