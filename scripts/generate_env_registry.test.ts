import { describe, expect, it } from 'vitest';
import { classifyEnvName, mergeRegistry, type EnvRegistryFile } from './generate_env_registry.js';

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
