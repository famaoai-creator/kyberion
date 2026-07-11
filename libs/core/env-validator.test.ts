import { describe, expect, it } from 'vitest';
import {
  loadEnvRegistryEntries,
  validateEnv,
  validateEnvAgainstRegistry,
  type EnvRegistryValidationEntry,
} from './env-validator.js';

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
    expect(report.checked).toBe(4);
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
});

describe('registry-backed validation', () => {
  it('loads the committed registry and validates the current env without errors', () => {
    const entries = loadEnvRegistryEntries();
    expect(entries.length).toBeGreaterThan(100);
    // No entry is required yet, so a validation run against any env must not
    // produce errors (warn-only posture, OP-05).
    const report = validateEnv();
    expect(report.errors).toHaveLength(0);
  });
});
