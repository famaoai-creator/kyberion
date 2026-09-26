/**
 * Tenant egress overlay (KYBERION_TENANT_EGRESS_POLICY_PATH): a tenant-owned
 * confidential policy file may approve destinations for ITS OWN tenant's
 * material only, and only in a process bound to that tenant.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  _resetEgressPolicyCacheForTests,
  _setTenantEgressOverlayRootForTests,
  evaluateEgressPolicy,
  loadEgressPolicy,
} from './egress-policy.js';

const ROOT = pathResolver.sharedTmp(`egress-tenant-overlay-${randomUUID()}`);
const BASE = path.join(ROOT, 'egress-policy.json');
const OVERLAY_REL = 'knowledge/confidential/aster-bank/governance/egress-policy.json';
const OVERLAY = path.join(ROOT, OVERLAY_REL);
const ENV_KEYS = [
  'KYBERION_EGRESS_POLICY_PATH',
  'KYBERION_TENANT_EGRESS_POLICY_PATH',
  'KYBERION_TENANT',
] as const;
const saved: Record<string, string | undefined> = {};

function writeJson(file: string, value: unknown): void {
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value));
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  writeJson(BASE, {
    version: '1',
    mode: 'warn',
    manual_allowed_domains: ['api.anthropic.com'],
    blocked_domains: ['evil.example'],
    tenant_allowed_providers: { default: ['claude'] },
  });
  writeJson(OVERLAY, {
    version: '1',
    tenant_allowed_providers: { 'aster-bank': ['claude'] },
    _meta_rationale: 'Commercial plan without training on inputs.',
  });
  process.env.KYBERION_EGRESS_POLICY_PATH = BASE;
  _setTenantEgressOverlayRootForTests(ROOT);
  _resetEgressPolicyCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _setTenantEgressOverlayRootForTests(null);
  _resetEgressPolicyCacheForTests();
});

afterAll(() => safeRmSync(ROOT, { recursive: true, force: true }));

const confidential = { tier: 'confidential' as const, tenant_slug: 'aster-bank' };

describe('tenant egress overlay', () => {
  it('denies the tenant without an overlay', () => {
    expect(evaluateEgressPolicy('https://api.anthropic.com/v1', confidential).verdict).toBe('deny');
  });

  it('approves the bound tenant from its own overlay', () => {
    process.env.KYBERION_TENANT = 'aster-bank';
    process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = OVERLAY;
    expect(evaluateEgressPolicy('https://api.anthropic.com/v1', confidential).verdict).toBe(
      'allow'
    );
    // The governed floor is untouched: mode and blocked domains stay the base's.
    const policy = loadEgressPolicy();
    expect(policy.blocked_domains).toEqual(['evil.example']);
    expect(policy.tenant_allowed_providers).toEqual({
      default: ['claude'],
      'aster-bank': ['claude'],
    });
  });

  it('is ignored in a process that is not bound to a tenant', () => {
    process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = OVERLAY;
    expect(evaluateEgressPolicy('https://api.anthropic.com/v1', confidential).verdict).toBe('deny');
  });

  it('refuses an overlay outside the bound tenant root', () => {
    process.env.KYBERION_TENANT = 'other-co';
    process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = OVERLAY;
    expect(() => loadEgressPolicy()).toThrow('[EGRESS_OVERLAY_SCOPE]');
  });

  it('refuses an overlay that approves another tenant, and caches nothing', () => {
    writeJson(OVERLAY, { tenant_allowed_providers: { 'other-co': ['claude'] } });
    process.env.KYBERION_TENANT = 'aster-bank';
    process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = OVERLAY;
    expect(() => loadEgressPolicy()).toThrow(/may only list its own tenant/);
    expect(() => loadEgressPolicy()).toThrow(/may only list its own tenant/);
  });
});
