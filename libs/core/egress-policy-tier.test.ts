/**
 * SA-04 Task 2: tier-aware egress.
 *
 * The gap this closes: the policy allowlist answers "is this host generally
 * reachable", which says nothing about whether a *tenant's confidential*
 * material may go there. Rasterized slide images were the first payload that
 * made the difference matter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import { evaluateEgressPolicy, resetEgressPolicyCache } from './egress-policy.js';

const POLICY_DIR = pathResolver.sharedTmp('egress-tier-tests');
const POLICY_PATH = path.join(POLICY_DIR, 'egress-policy.json');

function writePolicy(policy: Record<string, unknown>): void {
  safeMkdir(POLICY_DIR, { recursive: true });
  safeWriteFile(POLICY_PATH, JSON.stringify(policy));
  process.env.KYBERION_EGRESS_POLICY_PATH = POLICY_PATH;
  resetEgressPolicyCache();
}

beforeEach(() => {
  writePolicy({
    version: '1',
    mode: 'warn',
    manual_allowed_domains: ['api.anthropic.com'],
    blocked_domains: ['evil.example'],
    tenant_allowed_domains: { 'aster-bank': ['review.aster-bank.example'] },
  });
});

afterEach(() => {
  delete process.env.KYBERION_EGRESS_POLICY_PATH;
  resetEgressPolicyCache();
});

describe('public material', () => {
  it('keeps the previous behaviour when no tier is declared', () => {
    const decision = evaluateEgressPolicy('https://api.anthropic.com/v1/messages');
    expect(decision.verdict).toBe('allow');
  });

  it('warns rather than denying an unlisted host in warn mode', () => {
    const decision = evaluateEgressPolicy('https://unlisted.example/x');
    expect(decision.verdict).toBe('warn');
  });

  it('treats an explicit public tier the same as no tier', () => {
    const decision = evaluateEgressPolicy('https://api.anthropic.com/v1/messages', {
      tier: 'public',
    });
    expect(decision.verdict).toBe('allow');
  });
});

describe('confidential material', () => {
  it('is denied to a host that is merely on the general allowlist', () => {
    // The whole point: generally reachable is not the same as approved for
    // this tenant's confidential data.
    const decision = evaluateEgressPolicy('https://api.anthropic.com/v1/messages', {
      tier: 'confidential',
      tenant_slug: 'aster-bank',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('TIER_EGRESS_DENIED');
  });

  it('is allowed to a host approved for that tenant', () => {
    const decision = evaluateEgressPolicy('https://review.aster-bank.example/upload', {
      tier: 'confidential',
      tenant_slug: 'aster-bank',
    });
    expect(decision.verdict).toBe('allow');
    expect(decision.tier).toBe('confidential');
  });

  it('does not let one tenant use another tenant approval', () => {
    const decision = evaluateEgressPolicy('https://review.aster-bank.example/upload', {
      tier: 'confidential',
      tenant_slug: 'other-corp',
    });
    expect(decision.verdict).toBe('deny');
  });

  it('denies even in warn mode', () => {
    // warn mode exists so an unlisted public host does not break a workflow;
    // it must not also soften tenant data leaving the box.
    writePolicy({ version: '1', mode: 'warn', tenant_allowed_domains: {} });
    const decision = evaluateEgressPolicy('https://anywhere.example/x', {
      tier: 'confidential',
      tenant_slug: 'aster-bank',
    });
    expect(decision.verdict).toBe('deny');
  });

  it('still honours the blocklist above any tenant approval', () => {
    writePolicy({
      version: '1',
      mode: 'warn',
      blocked_domains: ['evil.example'],
      tenant_allowed_domains: { 'aster-bank': ['evil.example'] },
    });
    const decision = evaluateEgressPolicy('https://evil.example/x', {
      tier: 'confidential',
      tenant_slug: 'aster-bank',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('blocked domain');
  });

  it('supports a wildcard approval across tenants', () => {
    writePolicy({
      version: '1',
      mode: 'warn',
      tenant_allowed_domains: { '*': ['internal-review.example'] },
    });
    const decision = evaluateEgressPolicy('https://internal-review.example/x', {
      tier: 'confidential',
      tenant_slug: 'any-tenant',
    });
    expect(decision.verdict).toBe('allow');
  });
});

describe('personal material', () => {
  it('is held to the same rule as confidential', () => {
    const decision = evaluateEgressPolicy('https://api.anthropic.com/v1/messages', {
      tier: 'personal',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.tier).toBe('personal');
  });
});

describe('defaults', () => {
  it('denies tenant material when no tenant table is configured at all', () => {
    writePolicy({ version: '1', mode: 'warn', manual_allowed_domains: ['api.anthropic.com'] });
    const decision = evaluateEgressPolicy('https://api.anthropic.com/v1/messages', {
      tier: 'confidential',
      tenant_slug: 'aster-bank',
    });
    expect(decision.verdict).toBe('deny');
  });
});
