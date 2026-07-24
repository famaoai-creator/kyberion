/**
 * XP-03: tier x egress gate on the delegation face.
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-03.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const mocks = vi.hoisted(() => ({ sendOpsAlert: vi.fn() }));
vi.mock('./ops-alert.js', () => ({ sendOpsAlert: mocks.sendOpsAlert }));

import {
  assertProviderEgress,
  checkProviderEgress,
  highestTierForPaths,
  loadProviderEgressPolicy,
  providerIdForReasoningIdentifier,
  resetProviderEgressPolicyCache,
  ProviderEgressDeniedError,
  type ProviderEgressPolicyFile,
} from './provider-egress-gate.js';

const POLICY_DIR = pathResolver.sharedTmp(`provider-egress-gate-test-${process.pid}`);
const POLICY_PATH = path.join(POLICY_DIR, 'provider-egress-policy.json');

const VALID_POLICY: ProviderEgressPolicyFile = {
  version: '1.0.0',
  providers: {
    claude: { egress: 'external-api' },
    codex: { egress: 'external-api' },
    agy: { egress: 'external-api' },
    gemini: { egress: 'external-api' },
    copilot: { egress: 'external-api' },
    'local-model': { egress: 'local-only' },
  },
  tier_policy: {
    confidential: { mode: 'approved-only', approved_providers: ['claude'] },
    personal: { mode: 'local-only-or-approved', approved_providers: ['agy'] },
  },
};

function writePolicy(policy: unknown): void {
  safeMkdir(POLICY_DIR, { recursive: true });
  safeWriteFile(POLICY_PATH, JSON.stringify(policy), { encoding: 'utf8' });
}

beforeEach(() => {
  mocks.sendOpsAlert.mockReset();
  process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = POLICY_PATH;
  resetProviderEgressPolicyCache();
});

afterEach(() => {
  safeRmSync(POLICY_DIR, { recursive: true, force: true });
  delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
  resetProviderEgressPolicyCache();
});

describe('checkProviderEgress', () => {
  it('always allows public tier, even without a policy file on disk', () => {
    // No writePolicy() call — POLICY_PATH does not exist yet.
    const result = checkProviderEgress({ provider: 'codex', dataTier: 'public' });
    expect(result).toEqual({ allowed: true });
    expect(mocks.sendOpsAlert).not.toHaveBeenCalled();
  });

  it('allows a confidential payload to an approved provider', () => {
    writePolicy(VALID_POLICY);
    const result = checkProviderEgress({ provider: 'claude', dataTier: 'confidential' });
    expect(result.allowed).toBe(true);
  });

  it('denies a confidential payload to an unapproved provider, with a reason', () => {
    writePolicy(VALID_POLICY);
    const result = checkProviderEgress({ provider: 'codex', dataTier: 'confidential' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain('PROVIDER_EGRESS_DENIED');
    expect(result.reason).toContain('codex');
  });

  it('allows a personal payload to a provider declared local-only', () => {
    writePolicy(VALID_POLICY);
    const result = checkProviderEgress({ provider: 'local-model', dataTier: 'personal' });
    expect(result.allowed).toBe(true);
  });

  it('allows a personal payload to a provider explicitly on the personal approved list', () => {
    writePolicy(VALID_POLICY);
    const result = checkProviderEgress({ provider: 'agy', dataTier: 'personal' });
    expect(result.allowed).toBe(true);
  });

  it('denies a personal payload to an external-api provider not on the approved list', () => {
    writePolicy(VALID_POLICY);
    const result = checkProviderEgress({ provider: 'claude', dataTier: 'personal' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('PROVIDER_EGRESS_DENIED');
  });

  it('denies confidential/personal (fail-closed) when the policy file is missing, but still allows public', () => {
    // No writePolicy() call.
    expect(checkProviderEgress({ provider: 'claude', dataTier: 'public' })).toEqual({
      allowed: true,
    });
    const confidential = checkProviderEgress({ provider: 'claude', dataTier: 'confidential' });
    expect(confidential.allowed).toBe(false);
    expect(confidential.reason).toContain('not found');
    const personal = checkProviderEgress({ provider: 'claude', dataTier: 'personal' });
    expect(personal.allowed).toBe(false);
  });

  it('denies confidential/personal (fail-closed) when the policy file is invalid JSON', () => {
    safeMkdir(POLICY_DIR, { recursive: true });
    safeWriteFile(POLICY_PATH, '{ not valid json', { encoding: 'utf8' });
    const result = checkProviderEgress({ provider: 'claude', dataTier: 'confidential' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('PROVIDER_EGRESS_DENIED');
  });

  it('denies confidential/personal (fail-closed) when the policy file fails schema validation', () => {
    writePolicy({ version: '1.0.0', providers: {} }); // missing required tier_policy
    const result = checkProviderEgress({ provider: 'claude', dataTier: 'confidential' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('PROVIDER_EGRESS_DENIED');
  });

  it('denies when no provider is supplied for a non-public tier', () => {
    writePolicy(VALID_POLICY);
    const result = checkProviderEgress({ provider: '', dataTier: 'confidential' });
    expect(result.allowed).toBe(false);
  });

  it('emits exactly one ops-alert per denial and records it in the ops-alert sink shape', () => {
    writePolicy(VALID_POLICY);
    checkProviderEgress({ provider: 'codex', dataTier: 'confidential' });
    expect(mocks.sendOpsAlert).toHaveBeenCalledTimes(1);
    const [alertInput] = mocks.sendOpsAlert.mock.calls[0];
    expect(alertInput).toMatchObject({
      severity: 'warning',
      context: { provider: 'codex', data_tier: 'confidential' },
    });
    expect(alertInput.title).toContain('codex');
    expect(alertInput.dedupe_key).toContain('codex');
  });

  it('does not emit an ops-alert when the check allows', () => {
    writePolicy(VALID_POLICY);
    checkProviderEgress({ provider: 'claude', dataTier: 'confidential' });
    expect(mocks.sendOpsAlert).not.toHaveBeenCalled();
  });
});

describe('assertProviderEgress', () => {
  it('throws ProviderEgressDeniedError with the deny reason on denial', () => {
    writePolicy(VALID_POLICY);
    expect(() => assertProviderEgress({ provider: 'codex', dataTier: 'confidential' })).toThrow(
      ProviderEgressDeniedError
    );
  });

  it('does not throw when allowed', () => {
    writePolicy(VALID_POLICY);
    expect(() =>
      assertProviderEgress({ provider: 'claude', dataTier: 'confidential' })
    ).not.toThrow();
  });
});

describe('loadProviderEgressPolicy', () => {
  it('reports status "missing" when the file does not exist', () => {
    expect(loadProviderEgressPolicy()).toEqual({ status: 'missing' });
  });

  it('reports status "ok" with the parsed policy when valid', () => {
    writePolicy(VALID_POLICY);
    const loaded = loadProviderEgressPolicy();
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.policy.version).toBe('1.0.0');
    }
  });

  it('caches the result until resetProviderEgressPolicyCache is called', () => {
    writePolicy(VALID_POLICY);
    expect(loadProviderEgressPolicy().status).toBe('ok');
    // Mutate the file on disk without resetting the cache.
    writePolicy({ version: '1.0.0', providers: {} });
    expect(loadProviderEgressPolicy().status).toBe('ok');
    resetProviderEgressPolicyCache();
    expect(loadProviderEgressPolicy().status).toBe('invalid');
  });
});

describe('highestTierForPaths', () => {
  it('defaults to public for an empty or all-public path list', () => {
    expect(highestTierForPaths([])).toBe('public');
    expect(highestTierForPaths(['knowledge/product/architecture/foo.md'])).toBe('public');
  });

  it('ranks personal above confidential above public', () => {
    expect(
      highestTierForPaths([
        'knowledge/product/architecture/foo.md',
        'knowledge/confidential/acme/notes.md',
      ])
    ).toBe('confidential');
    expect(
      highestTierForPaths(['knowledge/confidential/acme/notes.md', 'knowledge/personal/journal.md'])
    ).toBe('personal');
  });
});

describe('providerIdForReasoningIdentifier', () => {
  it('maps known CLI-backed reasoning modes/backend names to provider ids', () => {
    expect(providerIdForReasoningIdentifier('claude-cli')).toBe('claude');
    expect(providerIdForReasoningIdentifier('claude-agent')).toBe('claude');
    expect(providerIdForReasoningIdentifier('shell-claude-cli')).toBe('claude');
    expect(providerIdForReasoningIdentifier('codex-cli')).toBe('codex');
    expect(providerIdForReasoningIdentifier('agy-cli')).toBe('agy');
    expect(providerIdForReasoningIdentifier('gemini-cli')).toBe('gemini');
    expect(providerIdForReasoningIdentifier('copilot')).toBe('copilot');
  });

  it('returns undefined for unmapped or absent identifiers, rather than guessing', () => {
    expect(providerIdForReasoningIdentifier('stub')).toBeUndefined();
    expect(providerIdForReasoningIdentifier('anthropic')).toBeUndefined();
    expect(providerIdForReasoningIdentifier(undefined)).toBeUndefined();
    expect(providerIdForReasoningIdentifier('')).toBeUndefined();
  });
});

// Sanity check that the real, checked-in default file used across the repo
// is itself valid against the schema (belt-and-braces alongside the
// dedicated contract test at tests/provider-egress-policy-contract.test.ts).
describe('the checked-in default policy', () => {
  it('loads and validates', () => {
    delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
    resetProviderEgressPolicyCache();
    const loaded = loadProviderEgressPolicy();
    expect(loaded.status).toBe('ok');
    resetProviderEgressPolicyCache();
  });
});
