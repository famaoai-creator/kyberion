import { afterEach, describe, expect, it } from 'vitest';
import {
  composeAudienceFloor,
  evaluateEgressPolicy,
  evaluateAudienceEgress,
  normalizeEgressHost,
  _resetEgressPolicyCacheForTests,
} from './egress-policy.js';
import {
  findAudienceFloorViolations,
  resolveCustomerAudienceFloor,
} from './customer-conversation.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';

describe('audience egress floor (QM-11)', () => {
  const tenant = {
    participant: 'tenant:acme',
    allowed_domains: ['acme.example', 'shared.example', 'docs.example'],
  };
  const operator = {
    participant: 'operator',
    allowed_domains: ['shared.example', 'docs.example', 'operator-only.example'],
    blocked_domains: ['tracker.example'],
  };

  it('allow is the INTERSECTION across participants', () => {
    const floor = composeAudienceFloor([tenant, operator]);
    expect(floor.allowed_domains).toEqual(['docs.example', 'shared.example']);
    expect(evaluateAudienceEgress('shared.example', floor).verdict).toBe('allow');
    expect(evaluateAudienceEgress('acme.example', floor).verdict).toBe('deny');
    expect(evaluateAudienceEgress('operator-only.example', floor).verdict).toBe('deny');
  });

  it('deny is the UNION — one participant denial denies everyone', () => {
    const floor = composeAudienceFloor([
      { ...tenant, allowed_domains: [...tenant.allowed_domains, 'tracker.example'] },
      operator,
    ]);
    const decision = evaluateAudienceEgress('tracker.example', floor);
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('denial denies everyone');
  });

  it('deny wins even when every participant allows the host', () => {
    const floor = composeAudienceFloor([
      { participant: 'a', allowed_domains: ['x.example'], blocked_domains: ['x.example'] },
      { participant: 'b', allowed_domains: ['x.example'] },
    ]);
    expect(evaluateAudienceEgress('x.example', floor).verdict).toBe('deny');
  });

  it('subdomains inherit both allow and deny coverage', () => {
    const floor = composeAudienceFloor([tenant, operator]);
    expect(evaluateAudienceEgress('a.b.shared.example', floor).verdict).toBe('allow');
    expect(evaluateAudienceEgress('cdn.tracker.example', floor).verdict).toBe('deny');
    expect(evaluateAudienceEgress('notshared.example', floor).verdict).toBe('deny');
  });

  it('an empty audience permits nothing', () => {
    const floor = composeAudienceFloor([]);
    expect(evaluateAudienceEgress('anything.example', floor).verdict).toBe('deny');
  });

  it('observation provenance denies external egress even for an otherwise allowed host', () => {
    const decision = evaluateEgressPolicy('https://docs.example', {
      tier: 'public',
      tenant_slug: 'tenant-a',
      provenance: {
        missionId: 'mission-provenance',
        highestTier: 'personal',
        tenants: ['tenant-a'],
        prohibitExternal: true,
        observationIds: ['observation-1'],
      },
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('PROVENANCE_EGRESS_DENIED');
  });

  it('normalizes wildcard and trailing-dot host forms', () => {
    expect(normalizeEgressHost('*.Example.COM.')).toBe('example.com');
    const floor = composeAudienceFloor([
      { participant: 'a', allowed_domains: ['*.docs.example'] },
      { participant: 'b', allowed_domains: ['docs.example.'] },
    ]);
    expect(floor.allowed_domains).toEqual(['docs.example']);
  });

  it('userinfo-bearing URLs fail closed (review finding 1)', () => {
    const floor = composeAudienceFloor([tenant, operator]);
    const violations = findAudienceFloorViolations(
      'see https://docs.example:x@evil.example/payload and https://user@evil2.example/x',
      floor
    );
    expect(violations).toHaveLength(2);
    expect(violations.join(' ')).toContain('userinfo');
  });

  it('scheme-less www and protocol-relative links are scanned too (review finding 7)', () => {
    const floor = composeAudienceFloor([tenant, operator]);
    expect(findAudienceFloorViolations('visit www.evil.example for details', floor)).toHaveLength(
      1
    );
    expect(findAudienceFloorViolations('load //evil.example/script.js', floor)).toHaveLength(1);
    expect(findAudienceFloorViolations('visit www.shared.example please', floor)).toEqual([]);
  });

  it('a literal * allow entry expresses allow-all (review finding 8)', () => {
    const floor = composeAudienceFloor([
      { participant: 'a', allowed_domains: ['*'] },
      { participant: 'b', allowed_domains: ['*'] },
    ]);
    expect(evaluateAudienceEgress('anything.example', floor).verdict).toBe('allow');
  });

  describe('resolveCustomerAudienceFloor round-trips through the policy file (review defects 1-2)', () => {
    const policyPath = pathResolver.sharedTmp(`qm11-egress-policy-${Date.now()}.json`);
    afterEach(() => {
      delete process.env.KYBERION_EGRESS_POLICY_PATH;
      _resetEgressPolicyCacheForTests();
      safeRmSync(policyPath, { force: true });
    });
    const usePolicy = (policy: Record<string, unknown>) => {
      safeWriteFile(policyPath, JSON.stringify(policy));
      process.env.KYBERION_EGRESS_POLICY_PATH = policyPath;
      _resetEgressPolicyCacheForTests();
    };

    it('link_allowed_domains survives load normalization and activates the operator', () => {
      usePolicy({
        tenant_allowed_domains: { acme: ['docs.example', 'ops.example'] },
        link_allowed_domains: ['docs.example'],
      });
      const floor = resolveCustomerAudienceFloor('acme');
      expect(floor.active).toBe(true);
      expect(floor.participants).toContain('operator');
      expect(evaluateAudienceEgress('docs.example', floor).verdict).toBe('allow');
      expect(evaluateAudienceEgress('ops.example', floor).verdict).toBe('deny');
    });

    it('blocked_domains deny even in a tenant-only configuration', () => {
      usePolicy({
        tenant_allowed_domains: { acme: ['tracker.example', 'docs.example'] },
        blocked_domains: ['tracker.example'],
      });
      const floor = resolveCustomerAudienceFloor('acme');
      expect(evaluateAudienceEgress('tracker.example', floor).verdict).toBe('deny');
      expect(evaluateAudienceEgress('docs.example', floor).verdict).toBe('allow');
    });

    it('a blocked-only configuration activates the floor with an unrestricted allow side', () => {
      usePolicy({ blocked_domains: ['evil.example'] });
      const floor = resolveCustomerAudienceFloor('acme');
      expect(floor.active).toBe(true);
      expect(evaluateAudienceEgress('evil.example', floor).verdict).toBe('deny');
      expect(evaluateAudienceEgress('anything.example', floor).verdict).toBe('allow');
    });

    it('an unconfigured policy leaves the floor inactive', () => {
      usePolicy({});
      expect(resolveCustomerAudienceFloor('acme').active).toBe(false);
    });
  });

  it("a participant declaring '*' joins without narrowing the intersection", () => {
    const floor = composeAudienceFloor([
      { participant: 'unrestricted', allowed_domains: ['*'] },
      { participant: 'restricted', allowed_domains: ['docs.example'] },
    ]);
    expect(evaluateAudienceEgress('docs.example', floor).verdict).toBe('allow');
    expect(evaluateAudienceEgress('other.example', floor).verdict).toBe('deny');
  });

  it('trailing prose punctuation is not part of the link host', () => {
    const floor = composeAudienceFloor([tenant, operator]);
    expect(findAudienceFloorViolations('see https://docs.example, thanks', floor)).toEqual([]);
    expect(findAudienceFloorViolations('see https://evil.example, thanks', floor)).toHaveLength(1);
  });

  it('findAudienceFloorViolations flags every offending link in a message body', () => {
    const floor = composeAudienceFloor([tenant, operator]);
    const body = [
      'See https://docs.example/guide and http://shared.example/page.',
      'Also https://evil.example/x plus https://tracker.example/pixel?id=1.',
    ].join('\n');
    const violations = findAudienceFloorViolations(body, floor);
    expect(violations).toHaveLength(2);
    expect(violations.join(' ')).toContain('evil.example');
    expect(violations.join(' ')).toContain('tracker.example');
    expect(findAudienceFloorViolations('no links here', floor)).toEqual([]);
  });
});
