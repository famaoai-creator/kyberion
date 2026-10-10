import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

/**
 * HA-08 mode resolution against the active approval-policy.json (customer
 * overlay or product default): the stricter of policy and environment wins,
 * and a policy the store cannot read never relaxes anything.
 */
const mocks = vi.hoisted(() => ({
  customerRoot: vi.fn(() => null as string | null),
  warn: vi.fn(),
}));

vi.mock('../customer-resolver.js', () => ({
  customerRoot: mocks.customerRoot,
}));

vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>();
  return {
    ...actual,
    createLogger: (name: string) =>
      name === 'approval-policy'
        ? { ...actual.createLogger(name), warn: mocks.warn }
        : actual.createLogger(name),
  };
});

let fixture = 0;

function overlay(contents: string): void {
  const file = pathResolver.sharedTmp(
    `approval-assurance-mode-${process.pid}-${Date.now()}-${fixture++}.json`
  );
  safeWriteFile(file, contents);
  mocks.customerRoot.mockReturnValue(file);
}

function policyWith(fields: Record<string, unknown>): string {
  return JSON.stringify({
    defaults: { requires_approval: false },
    rules: [
      {
        id: 'fixture',
        intent_ids: ['fixture:op'],
        requires_approval: true,
        missing_requirements: [],
      },
    ],
    ...fields,
  });
}

async function load() {
  vi.resetModules();
  const policy = await import('./approval-policy.js');
  const assurance = await import('./approval-assurance.js');
  return { ...policy, ...assurance };
}

beforeEach(() => {
  mocks.warn.mockReset();
});

afterEach(() => {
  mocks.customerRoot.mockReturnValue(null);
  vi.unstubAllEnvs();
});

describe('approval assurance mode resolution', () => {
  it('policy enforce + env warn resolves to enforce', async () => {
    overlay(policyWith({ assurance_mode: 'enforce' }));
    const mod = await load();
    expect(mod.resolvePolicyApprovalAssuranceMode()).toBe('enforce');
    expect(mod.resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'warn' })).toBe(
      'enforce'
    );
  });

  it('policy warn + env enforce resolves to enforce', async () => {
    overlay(policyWith({ assurance_mode: 'warn' }));
    const mod = await load();
    expect(mod.resolvePolicyApprovalAssuranceMode()).toBe('warn');
    expect(mod.resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'enforce' })).toBe(
      'enforce'
    );
    expect(mod.resolveApprovalAssuranceMode({})).toBe('warn');
  });

  it('honours the customer overlay over the product default', async () => {
    overlay(policyWith({ assurance_mode: 'enforce', passkey_enrollment_cooldown_hours: 2 }));
    const mod = await load();
    expect(mod.resolveApprovalAssuranceMode({})).toBe('enforce');
    expect(mod.resolvePasskeyEnrollmentCooldownHours()).toBe(2);
  });

  it('reads an unreadable policy as enforce, warning once per interval', async () => {
    overlay('{ not json');
    const mod = await load();
    expect(mod.resolvePolicyApprovalAssuranceMode()).toBe('enforce');
    expect(mod.resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'warn' })).toBe(
      'enforce'
    );
    expect(mod.resolvePolicyApprovalAssuranceMode()).toBe('enforce');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0]?.[0]).toMatch(
      /approval-policy\.json unreadable — assurance_mode treated as enforce \| next: /u
    );
  });

  it('reads a schema-invalid policy as enforce', async () => {
    overlay(policyWith({ assurance_mode: 'off' }));
    const mod = await load();
    expect(mod.resolvePolicyApprovalAssuranceMode()).toBe('enforce');
    expect(mod.resolveApprovalAssuranceMode({})).toBe('enforce');
  });

  it('keeps the default cooldown and an A3 floor when the policy is unreadable', async () => {
    overlay('{ not json');
    const mod = await load();
    expect(mod.resolvePasskeyEnrollmentCooldownHours()).toBe(
      mod.DEFAULT_PASSKEY_ENROLLMENT_COOLDOWN_HOURS
    );
    expect(mod.resolvePolicyAssuranceFloor({ effectBinding: 'ingress:expose' })).toBe('A3');
  });
});

describe('decision-time assurance floor', () => {
  it('derives A3 from dual-key rules and min_assurance, by rule id or effect binding', async () => {
    overlay(
      policyWith({
        rules: [
          {
            id: 'dual',
            intent_ids: ['secret:grant'],
            requires_approval: true,
            missing_requirements: ['dual_key_confirmation'],
          },
          {
            id: 'plain',
            intent_ids: ['ingress:expose'],
            requires_approval: true,
            missing_requirements: [],
          },
          {
            id: 'raised',
            intent_ids: ['config:update'],
            requires_approval: true,
            missing_requirements: [],
            min_assurance: 'A3',
          },
        ],
      })
    );
    const mod = await load();
    expect(mod.resolvePolicyAssuranceFloor({ effectBinding: 'secret:grant' })).toBe('A3');
    expect(mod.resolvePolicyAssuranceFloor({ ruleId: 'raised' })).toBe('A3');
    expect(mod.resolvePolicyAssuranceFloor({ ruleId: 'plain' })).toBeUndefined();
    expect(mod.resolvePolicyAssuranceFloor({ effectBinding: 'unknown:op' })).toBeUndefined();
    expect(mod.resolvePolicyAssuranceFloor({})).toBeUndefined();
    // Union: a gate-internal rule id never hides an A3 rule naming the effect.
    expect(
      mod.resolvePolicyAssuranceFloor({
        ruleId: 'strict-posture-floor',
        effectBinding: 'config:update',
      })
    ).toBe('A3');
    expect(
      mod.resolvePolicyAssuranceFloor({ ruleId: 'plain', effectBinding: 'secret:grant' })
    ).toBe('A3');
  });

  it('counts the built-in fallback rules (dual-key secret fallback → A3)', async () => {
    overlay(policyWith({}));
    const mod = await load();
    expect(mod.resolvePolicyAssuranceFloor({ effectBinding: 'secret:rotate' })).toBe('A3');
    expect(mod.resolvePolicyAssuranceFloor({ ruleId: 'fallback-dangerous-secret' })).toBe('A3');
    expect(mod.resolvePolicyAssuranceFloor({ effectBinding: 'shell:run' })).toBeUndefined();
  });

  it('clamps the enrollment cooldown to at least an hour', async () => {
    overlay(policyWith({ passkey_enrollment_cooldown_hours: 1 }));
    expect((await load()).resolvePasskeyEnrollmentCooldownHours()).toBe(1);
    overlay(policyWith({ passkey_enrollment_cooldown_hours: 0 }));
    // Below the schema minimum: schema-invalid, so the default applies.
    expect((await load()).resolvePasskeyEnrollmentCooldownHours()).toBe(24);
  });
});
