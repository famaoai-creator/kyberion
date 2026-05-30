import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderHealth,
  healthyInstances,
  instancesForProvider,
  isInstanceDemoted,
  listDemotedProviders,
  reportProviderHealthy,
  reportProviderRateLimited,
  resolveCapabilityTargetWithHealth,
  selectHealthyInstance,
} from './provider-health-registry.js';
import type { ProviderInfo } from './provider-discovery.js';

function provider(providerId: string, models: string[], modelCapabilities: Record<string, string[]> = {}): ProviderInfo {
  return {
    provider: providerId,
    installed: true,
    version: 'test',
    protocol: 'acp',
    models,
    capabilities: Array.from(new Set(Object.values(modelCapabilities).flat())),
    modelCapabilities,
    healthy: true,
  };
}

const claude = provider('claude', ['opus'], { opus: ['reasoning', 'code', 'deep_reasoning'] });
const codex = provider('codex', ['codex'], { codex: ['code', 'patch', 'terminal'] });

const T0 = 1_000_000;

describe('provider-health-registry', () => {
  beforeEach(() => {
    clearProviderHealth();
    delete process.env.KYBERION_CODEX_INSTANCES;
  });
  afterEach(() => {
    clearProviderHealth();
    delete process.env.KYBERION_CODEX_INSTANCES;
  });

  it('demotes an instance for a TTL and recovers after it expires', () => {
    reportProviderRateLimited('codex', { retryAfterMs: 5000, now: T0 });
    expect(isInstanceDemoted('codex', 'default', T0 + 1000)).toBe(true);
    expect(isInstanceDemoted('codex', 'default', T0 + 6000)).toBe(false);
  });

  it('reads the instance pool from env', () => {
    process.env.KYBERION_CODEX_INSTANCES = 'work, personal';
    expect(instancesForProvider('codex')).toEqual(['work', 'personal']);
    expect(instancesForProvider('gemini')).toEqual(['default']);
  });

  it('keeps the provider usable while a sibling instance is healthy', () => {
    process.env.KYBERION_CODEX_INSTANCES = 'work,personal';
    reportProviderRateLimited('codex', { instance: 'work', retryAfterMs: 5000, now: T0 });

    expect(healthyInstances('codex', T0 + 1000)).toEqual(['personal']);
    expect(selectHealthyInstance('codex', T0 + 1000)).toBe('personal');
    // not fully demoted -> not excluded from resolution
    expect(listDemotedProviders([codex], T0 + 1000)).toEqual([]);
  });

  it('excludes a provider only when its whole pool is demoted', () => {
    process.env.KYBERION_CODEX_INSTANCES = 'work,personal';
    reportProviderRateLimited('codex', { instance: 'work', retryAfterMs: 5000, now: T0 });
    reportProviderRateLimited('codex', { instance: 'personal', retryAfterMs: 5000, now: T0 });

    expect(selectHealthyInstance('codex', T0 + 1000)).toBeNull();
    expect(listDemotedProviders([codex], T0 + 1000)).toEqual(['codex']);
  });

  it('fails over to a healthy sibling instance of the same provider', () => {
    process.env.KYBERION_CODEX_INSTANCES = 'work,personal';
    reportProviderRateLimited('codex', { instance: 'work', retryAfterMs: 5000, now: T0 });

    const resolved = resolveCapabilityTargetWithHealth(
      { requiredCapabilities: ['patch', 'terminal'], preferredProvider: 'codex' },
      [claude, codex],
      T0 + 1000,
    );
    expect(resolved.provider).toBe('codex');
    expect(resolved.instance).toBe('personal');
  });

  it('escalates to another provider when the whole pool is rate-limited', () => {
    reportProviderRateLimited('codex', { retryAfterMs: 5000, now: T0 });

    const resolved = resolveCapabilityTargetWithHealth(
      { requiredCapabilities: ['code'], preferredProvider: 'codex' },
      [claude, codex],
      T0 + 1000,
    );
    expect(resolved.provider).toBe('claude');
  });

  it('clears a demotion early when the provider reports healthy', () => {
    reportProviderRateLimited('codex', { retryAfterMs: 5000, now: T0 });
    expect(isInstanceDemoted('codex', 'default', T0 + 1000)).toBe(true);
    reportProviderHealthy('codex');
    expect(isInstanceDemoted('codex', 'default', T0 + 1000)).toBe(false);
  });
});
