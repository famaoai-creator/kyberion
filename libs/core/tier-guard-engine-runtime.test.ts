import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { runInResourceAccessScope } from './foundation/resource-access-scope.js';
import { inspectReadPermission, validateReadPermission } from './tier-guard.js';

const file = pathResolver.knowledge('personal/onboarding/engine-runtime.json');
beforeEach(() => {
  vi.stubEnv('KYBERION_SUDO', '');
  vi.stubEnv('MISSION_ROLE', '');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
});
afterEach(() => vi.unstubAllEnvs());

describe('optional engine profile permission classification', () => {
  it('marks only the generic personal-tier restriction and preserves legacy shape', () => {
    withExecutionContext('worker', () => {
      const inspected = inspectReadPermission(file);
      expect(inspected).toMatchObject({ allowed: false, denialKind: 'tier_restriction' });
      expect(validateReadPermission(file)).toEqual({ allowed: false, reason: inspected.reason });
    });
  });
  it('keeps authorized personal reads authorized', () => {
    withExecutionContext('ecosystem_architect', () => {
      expect(inspectReadPermission(file)).toEqual({ allowed: true });
      expect(validateReadPermission(file)).toEqual({ allowed: true });
    });
  });
  it('does not classify a resource ceiling denial as an optional personal default', () => {
    runInResourceAccessScope(
      { tenantSlug: 'engine-fixture', readExact: [], writeExact: [], mkdirExact: [] },
      () =>
        withExecutionContext('worker', () => {
          const decision = inspectReadPermission(file);
          expect(decision.allowed).toBe(false);
          expect(decision.reason).toContain('RESOURCE_SCOPE');
          expect(decision).not.toHaveProperty('denialKind');
        })
    );
  });
  it('preserves outside-repository denial instead of offering an optional fallback', () => {
    const decision = inspectReadPermission('/tmp/engine-runtime-outside-fixture.json');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('outside project root');
    expect(decision).not.toHaveProperty('denialKind');
  });
});
