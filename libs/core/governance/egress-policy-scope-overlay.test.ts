/**
 * Scope-bound tenant egress overlay: inside one multi-tenant process (the
 * agent-runtime supervisor running resident Dots), an execution scope bound to
 * tenant T merges T's conventional overlay
 * knowledge/confidential/T/governance/egress-policy.json — and only T's own
 * entries, only for that scope.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { validateReadPermission } from '../tier-guard.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  _resetEgressPolicyCacheForTests,
  _setTenantEgressOverlayRootForTests,
  evaluateEgressPolicy,
  loadEgressPolicy,
} from './egress-policy.js';

const ROOT = pathResolver.sharedTmp(`egress-scope-overlay-${randomUUID()}`);
const BASE = path.join(ROOT, 'egress-policy.json');
const overlayOf = (tenant: string) =>
  path.join(ROOT, 'knowledge/confidential', tenant, 'governance/egress-policy.json');
const ENV_KEYS = [
  'KYBERION_EGRESS_POLICY_PATH',
  'KYBERION_TENANT_EGRESS_POLICY_PATH',
  'KYBERION_TENANT',
] as const;
const saved: Record<string, string | undefined> = {};
const ANTHROPIC = 'https://api.anthropic.com/v1';

function writeJson(file: string, value: unknown): void {
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value));
}

function asTenant<T>(tenant: string, fn: () => T): T {
  return runInExecutionScope({ tenantBound: true, tenantSlug: tenant }, fn);
}

const confidentialFor = (tenant: string) => ({
  tier: 'confidential' as const,
  tenant_slug: tenant,
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  safeRmSync(path.join(ROOT, 'knowledge'), { recursive: true, force: true });
  writeJson(BASE, {
    version: '1',
    mode: 'warn',
    manual_allowed_domains: ['api.anthropic.com'],
    blocked_domains: ['evil.example'],
    tenant_allowed_providers: { default: ['claude'] },
  });
  writeJson(overlayOf('aster-bank'), {
    version: '1',
    tenant_allowed_providers: { 'aster-bank': ['claude'] },
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

describe('scope-bound tenant egress overlay', () => {
  it('approves a scope bound to the tenant from its conventional overlay', () => {
    const decision = asTenant('aster-bank', () =>
      evaluateEgressPolicy(ANTHROPIC, confidentialFor('aster-bank'))
    );
    expect(decision.verdict).toBe('allow');
    const policy = asTenant('aster-bank', () => loadEgressPolicy());
    expect(policy.blocked_domains).toEqual(['evil.example']);
    expect(policy.mode).toBe('warn');
    expect(policy.tenant_allowed_providers).toEqual({
      default: ['claude'],
      'aster-bank': ['claude'],
    });
  });

  it('does not approve another tenant scope in the same process', () => {
    const other = asTenant('other-co', () =>
      evaluateEgressPolicy(ANTHROPIC, confidentialFor('other-co'))
    );
    expect(other.verdict).toBe('deny');
    // Even aster-bank material evaluated under other-co's scope gets no approval.
    const crossed = asTenant('other-co', () =>
      evaluateEgressPolicy(ANTHROPIC, confidentialFor('aster-bank'))
    );
    expect(crossed.verdict).toBe('deny');
  });

  it('reads no overlay in an unbound scope', () => {
    expect(evaluateEgressPolicy(ANTHROPIC, confidentialFor('aster-bank')).verdict).toBe('deny');
    const cleared = runInExecutionScope({ tenantBound: true, tenantCleared: true }, () =>
      evaluateEgressPolicy(ANTHROPIC, confidentialFor('aster-bank'))
    );
    expect(cleared.verdict).toBe('deny');
  });

  it('treats an absent overlay as no overlay, and picks up one added later', () => {
    expect(
      asTenant('late-co', () => evaluateEgressPolicy(ANTHROPIC, confidentialFor('late-co'))).verdict
    ).toBe('deny');
    writeJson(overlayOf('late-co'), { tenant_allowed_providers: { 'late-co': ['claude'] } });
    expect(
      asTenant('late-co', () => evaluateEgressPolicy(ANTHROPIC, confidentialFor('late-co'))).verdict
    ).toBe('allow');
  });

  it('ignores entries for other tenants in a scope overlay', () => {
    writeJson(overlayOf('aster-bank'), {
      tenant_allowed_providers: { 'aster-bank': ['claude'], 'other-co': ['claude'] },
      tenant_allowed_domains: { 'other-co': ['exfil.example'] },
    });
    const policy = asTenant('aster-bank', () => loadEgressPolicy());
    expect(policy.tenant_allowed_providers).toEqual({
      default: ['claude'],
      'aster-bank': ['claude'],
    });
    expect(policy.tenant_allowed_domains).toEqual({});
    expect(
      asTenant('aster-bank', () => evaluateEgressPolicy(ANTHROPIC, confidentialFor('other-co')))
        .verdict
    ).toBe('deny');
  });

  it('fails closed on an invalid overlay', () => {
    writeJson(overlayOf('aster-bank'), { tenant_allowed_providers: 'claude' });
    expect(
      asTenant('aster-bank', () => evaluateEgressPolicy(ANTHROPIC, confidentialFor('aster-bank')))
        .verdict
    ).toBe('deny');
  });

  it('keeps merged policies isolated while tenants alternate in one process', () => {
    writeJson(overlayOf('other-co'), {
      tenant_allowed_domains: { 'other-co': ['partner.example'] },
    });
    for (let round = 0; round < 3; round += 1) {
      const aster = asTenant('aster-bank', () => loadEgressPolicy());
      const other = asTenant('other-co', () => loadEgressPolicy());
      const unbound = loadEgressPolicy();
      expect(aster.tenant_allowed_providers).toEqual({
        default: ['claude'],
        'aster-bank': ['claude'],
      });
      expect(aster.tenant_allowed_domains).toEqual({});
      expect(other.tenant_allowed_providers).toEqual({ default: ['claude'] });
      expect(other.tenant_allowed_domains).toEqual({ 'other-co': ['partner.example'] });
      expect(unbound.tenant_allowed_providers).toEqual({ default: ['claude'] });
      expect(unbound.tenant_allowed_domains).toEqual({});
    }
  });

  it('lets the chronos env overlay win for its own tenant scope', () => {
    const envOverlay = path.join(ROOT, 'knowledge/confidential/aster-bank/pipelines/egress.json');
    writeJson(envOverlay, { tenant_allowed_domains: { 'aster-bank': ['env.example'] } });
    process.env.KYBERION_TENANT = 'aster-bank';
    process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = envOverlay;
    const policy = asTenant('aster-bank', () => loadEgressPolicy());
    expect(policy.tenant_allowed_domains).toEqual({ 'aster-bank': ['env.example'] });
    expect(policy.tenant_allowed_providers).toEqual({ default: ['claude'] });
  });

  it('rejects an env overlay outside the tenant root even when the scope matches', () => {
    process.env.KYBERION_TENANT = 'aster-bank';
    process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = overlayOf('other-co');
    expect(() => asTenant('aster-bank', () => loadEgressPolicy())).toThrow(
      '[EGRESS_OVERLAY_SCOPE]'
    );
  });

  it("is readable by the resident Dot's tenant-bound organization_operator role, own tenant only", () => {
    const conventional = (tenant: string) =>
      `knowledge/confidential/${tenant}/governance/egress-policy.json`;
    const [own, foreign] = withExecutionContext(
      'organization_operator',
      () => [
        validateReadPermission(conventional('aster-bank')),
        validateReadPermission(conventional('other-co')),
      ],
      undefined,
      'aster-bank'
    );
    expect(own.allowed).toBe(true);
    expect(foreign.allowed).toBe(false);
  });
});
