import { describe, expect, it } from 'vitest';
import {
  getRegisteredEnv,
  loadEnvRegistryEntries,
  validateEnv,
  validateEnvAgainstRegistry,
  validateStartupEnv,
  type EnvRegistryValidationEntry,
} from './env-validator.js';
import { getRegisteredEnvBool } from './foundation/env.js';

const ENTRIES: EnvRegistryValidationEntry[] = [
  { name: 'KYBERION_FLAG', type: 'boolean', required: false },
  { name: 'KYBERION_TIMEOUT_MS', type: 'number', required: false },
  { name: 'KYBERION_MODE', type: 'enum', enum: ['fast', 'safe'], required: false },
  { name: 'KYBERION_REQUIRED_TOKEN', type: 'string', required: true },
];

describe('validateEnvAgainstRegistry', () => {
  it('passes a well-formed environment', () => {
    const report = validateEnvAgainstRegistry(ENTRIES, {
      KYBERION_FLAG: 'true',
      KYBERION_TIMEOUT_MS: '5000',
      KYBERION_MODE: 'fast',
      KYBERION_REQUIRED_TOKEN: 'x',
    });
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.unknown).toHaveLength(0);
    expect(report.undocumented).toHaveLength(4);
    expect(report.checked).toBe(4);
  });

  it('warns (never errors, even strict) when a deprecated variable is still set (S1)', () => {
    const entries: EnvRegistryValidationEntry[] = [
      { name: 'KYBERION_SUDO_KEY', type: 'string', required: false, deprecated: '2026-10' },
    ];
    const report = validateEnvAgainstRegistry(
      entries,
      { KYBERION_SUDO_KEY: 'secret' },
      {
        strict: true,
      }
    );
    expect(report.errors).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.warnings).toEqual([
      { name: 'KYBERION_SUDO_KEY', issue: 'deprecated and ignored since 2026-10; unset it' },
    ]);
    expect(JSON.stringify(report)).not.toContain('secret"');
  });

  it('keeps the variables removed in 2026-10 registered as deprecated', () => {
    const registered = new Map(
      loadEnvRegistryEntries().map((entry) => [entry.name, entry.deprecated])
    );
    for (const name of [
      'KYBERION_SUDO_KEY',
      'KYBERION_TELEMETRY',
      'KYBERION_SOVEREIGN_SECRET',
      'KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH',
      'KYBERION_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH',
      'KYBERION_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH',
    ]) {
      expect(registered.get(name), name).toBe('2026-10');
    }
  });

  it('reports missing required variables as errors', () => {
    const report = validateEnvAgainstRegistry(ENTRIES, {});
    expect(report.errors).toEqual([
      { name: 'KYBERION_REQUIRED_TOKEN', issue: 'required variable is not set' },
    ]);
  });

  it('warns on type mismatches without leaking values', () => {
    const report = validateEnvAgainstRegistry(ENTRIES, {
      KYBERION_FLAG: 'banana',
      KYBERION_TIMEOUT_MS: 'soon',
      KYBERION_MODE: 'reckless',
      KYBERION_REQUIRED_TOKEN: 'x',
    });
    expect(report.warnings.map((issue) => issue.name)).toEqual([
      'KYBERION_FLAG',
      'KYBERION_TIMEOUT_MS',
      'KYBERION_MODE',
    ]);
    for (const issue of report.warnings) {
      expect(issue.issue).not.toContain('banana');
      expect(issue.issue).not.toContain('soon');
      expect(issue.issue).not.toContain('reckless');
    }
  });

  it('flags unregistered KYBERION_* variables as unknown', () => {
    const report = validateEnvAgainstRegistry(ENTRIES, {
      KYBERION_MYSTERY: '1',
      OTHER_VAR: 'ignored',
      KYBERION_REQUIRED_TOKEN: 'x',
    });
    expect(report.unknown).toEqual(['KYBERION_MYSTERY']);
  });

  it('promotes unknown variables and type mismatches to errors in strict mode', () => {
    const report = validateEnvAgainstRegistry(
      ENTRIES,
      {
        KYBERION_MYSTERY: '1',
        KYBERION_FLAG: 'not-a-boolean',
        KYBERION_REQUIRED_TOKEN: 'x',
      },
      { strict: true }
    );
    expect(report.errors).toEqual([
      { name: 'KYBERION_MYSTERY', issue: 'variable is not registered' },
      {
        name: 'KYBERION_FLAG',
        issue: 'expected a boolean value (1/0/true/false/yes/no/on/off)',
      },
    ]);
    expect(report.warnings).toHaveLength(0);
  });

  it('reports registry entries without operator documentation separately from runtime errors', () => {
    const report = validateEnvAgainstRegistry(
      [
        { name: 'KYBERION_DOCUMENTED', type: 'string', required: false, documented: true },
        { name: 'KYBERION_UNDOCUMENTED', type: 'string', required: false, documented: false },
      ],
      { KYBERION_DOCUMENTED: 'ok', KYBERION_UNDOCUMENTED: 'ok' }
    );
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.undocumented).toEqual(['KYBERION_UNDOCUMENTED']);
  });
});

describe('registry-backed validation', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
  ])('normalizes boolean env %s to %s', (raw, expected) => {
    expect(
      getRegisteredEnvBool('KYBERION_ALLOW_LOCAL_NETWORK', {
        env: { KYBERION_ALLOW_LOCAL_NETWORK: raw },
      })
    ).toBe(expected);
  });

  it('loads the committed registry and validates the current env without errors', () => {
    const entries = loadEnvRegistryEntries();
    expect(entries.length).toBeGreaterThan(100);
    // No entry is required yet, so a validation run against any env must not
    // produce errors (warn-only posture, OP-05).
    const report = validateEnv();
    expect(report.errors).toHaveLength(0);
  });

  it('parses registered operational settings without exposing values', () => {
    const env = { KYBERION_PROVIDER_DEMOTION_TTL_MS: '2500' };
    expect(getRegisteredEnv<number>('KYBERION_PROVIDER_DEMOTION_TTL_MS', { env })).toBe(2500);
    expect(
      getRegisteredEnv<number>('KYBERION_PROVIDER_DEMOTION_TTL_MS', {
        env: { KYBERION_PROVIDER_DEMOTION_TTL_MS: 'invalid' },
        defaultValue: 60000,
      })
    ).toBe(60000);
    expect(() =>
      getRegisteredEnv<number>('KYBERION_PROVIDER_DEMOTION_TTL_MS', {
        env: { KYBERION_PROVIDER_DEMOTION_TTL_MS: 'invalid' },
        strict: true,
      })
    ).toThrow('KYBERION_PROVIDER_DEMOTION_TTL_MS');
  });
});

describe('validateStartupEnv', () => {
  const entries = [
    { name: 'KYBERION_TENANT', type: 'string' as const, required: false },
    { name: 'KYBERION_FLAG', type: 'boolean' as const, required: false },
    { name: 'KYBERION_ENV_REGISTRY_STRICT', type: 'boolean' as const, required: false },
  ];

  it('warns with did-you-mean for unknown names outside CI', () => {
    const report = validateStartupEnv({ KYBERION_TENNANT: 'x' }, entries);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('did you mean KYBERION_TENANT');
    expect(report.warnings[0]).toContain(' — ');
    expect(report.warnings[0]).toContain('| next:');
    expect(report.warnings[0]).toContain('| evidence:');
  });

  it('fails on unknown names in CI or when strict is explicit', () => {
    expect(validateStartupEnv({ CI: 'true', KYBERION_X: '1' }, entries).errors).toHaveLength(1);
    expect(
      validateStartupEnv({ KYBERION_ENV_REGISTRY_STRICT: '1', KYBERION_X: '1' }, entries).errors
    ).toHaveLength(1);
    expect(
      validateStartupEnv(
        { CI: 'true', KYBERION_ENV_REGISTRY_STRICT: '0', KYBERION_X: '1' },
        entries
      ).errors
    ).toEqual([]);
  });

  it('keeps invalid values of known variables fatal outside CI', () => {
    expect(validateStartupEnv({ KYBERION_FLAG: 'maybe' }, entries).errors).toHaveLength(1);
  });
});
