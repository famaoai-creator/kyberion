import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditChain } from './audit-chain.js';
import {
  RESERVED_GOAL_OP_PREFIX,
  SUBAGENT_CAPABILITY_PROFILES,
  assertSubagentOpAllowed,
  describeSubagentCapabilityCatalog,
  getSubagentCapabilityProfile,
  isOpAllowedForProfile,
  listSubagentCapabilityProfileNames,
} from './subagent-capability-profiles.js';
import {
  getDefaultWorkerEventStream,
  resetDefaultWorkerEventStream,
  type WorkerEventEnvelope,
} from './worker-event-stream.js';

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

const recordGovernanceAction = vi.fn();
vi.mock('./kill-switch.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => recordGovernanceAction(...args),
}));

describe('subagent-capability-profiles (KD-05)', () => {
  beforeEach(() => {
    vi.mocked(auditChain.record).mockClear();
    recordGovernanceAction.mockClear();
    resetDefaultWorkerEventStream();
  });

  afterEach(() => {
    resetDefaultWorkerEventStream();
  });

  it('registers at least the three required tiers: implementer, explorer, planner', () => {
    const names = listSubagentCapabilityProfileNames();
    expect(names).toContain('implementer');
    expect(names).toContain('explorer');
    expect(names).toContain('planner');
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it('every registered profile is a well-formed typed capability record', () => {
    for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
      expect(typeof profile.name).toBe('string');
      expect(profile.name.length).toBeGreaterThan(0);
      expect(typeof profile.description).toBe('string');
      expect(typeof profile.whenToUse).toBe('string');
      expect(typeof profile.systemPromptPrefix).toBe('string');
      expect(profile.allowedOps === '*' || Array.isArray(profile.allowedOps)).toBe(true);
    }
  });

  it('throws a descriptive error for an unregistered tier name', () => {
    expect(() => getSubagentCapabilityProfile('nonexistent-tier')).toThrow(
      /SUBAGENT_PROFILE_UNKNOWN/
    );
  });

  it('reflects the live registry into the catalog description (boundary follows registration)', () => {
    const catalog = describeSubagentCapabilityCatalog();
    for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
      expect(catalog).toContain(profile.name);
      expect(catalog).toContain(profile.whenToUse);
    }
  });

  it('implementer tier (full write) allows an arbitrary write-type op', () => {
    const decision = assertSubagentOpAllowed({ profileName: 'implementer', opId: 'file:write' });
    expect(decision.allowed).toBe(true);
  });

  it('explorer tier (read-only) allows its declared read ops', () => {
    const decision = assertSubagentOpAllowed({ profileName: 'explorer', opId: 'file:read' });
    expect(decision.allowed).toBe(true);
  });

  it('acceptance criterion 1: explorer tier rejects a write-type op via policy and records it to the worker event stream envelope', () => {
    const events: WorkerEventEnvelope[] = [];
    getDefaultWorkerEventStream().subscribe((event) => events.push(event));

    expect(() =>
      assertSubagentOpAllowed({
        profileName: 'explorer',
        opId: 'file:write',
        delegationId: 'deleg-1',
      })
    ).toThrow(/SUBAGENT_POLICY_BLOCKED/);

    // Recorded to the kill-switch audit trail and the audit chain (existing
    // governance mechanisms), and reflected as a governance_action envelope
    // on the worker event stream.
    expect(recordGovernanceAction).toHaveBeenCalledWith(
      'subagent',
      'file:write',
      expect.stringContaining('subagent_tier_denied:explorer'),
      true
    );
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'policy_violation',
        operation: 'file:write',
        result: 'failed',
        metadata: expect.objectContaining({
          subagent_profile: 'explorer',
          delegation_id: 'deleg-1',
        }),
      })
    );

    const governanceEvents = events.filter((event) => event.type === 'governance_action');
    expect(governanceEvents).toHaveLength(1);
    expect(governanceEvents[0]?.payload).toMatchObject({
      kind: 'subagent_op_denied',
      profile: 'explorer',
      op: 'file:write',
      delegation_id: 'deleg-1',
    });
  });

  it('planner tier (no exec, no writes) rejects any op, including reads', () => {
    expect(() => assertSubagentOpAllowed({ profileName: 'planner', opId: 'file:read' })).toThrow(
      /SUBAGENT_POLICY_BLOCKED/
    );
    expect(() => assertSubagentOpAllowed({ profileName: 'planner', opId: 'exec:run' })).toThrow(
      /SUBAGENT_POLICY_BLOCKED/
    );
  });

  it('reserved goal:* ops are denied for every tier, including implementer (KD-01 reservation)', () => {
    for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
      expect(isOpAllowedForProfile(profile, `${RESERVED_GOAL_OP_PREFIX}update`)).toBe(false);
      expect(() =>
        assertSubagentOpAllowed({
          profileName: profile.name,
          opId: `${RESERVED_GOAL_OP_PREFIX}update`,
        })
      ).toThrow(/KD-01/);
    }
  });

  it('throws for an unknown profile name passed to assertSubagentOpAllowed', () => {
    expect(() =>
      assertSubagentOpAllowed({ profileName: 'nonexistent-tier', opId: 'file:read' })
    ).toThrow(/SUBAGENT_PROFILE_UNKNOWN/);
  });

  it('every explicit allowlist entry resolves against the real actuator op registry', async () => {
    const { listKnownActuatorOps } = await import('./actuator-op-registry.js');
    for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
      if (profile.allowedOps === '*') continue;
      for (const entry of profile.allowedOps) {
        const [domain, op] = entry.split(':');
        expect(domain, `allowlist entry "${entry}" must be domain-qualified`).toBeTruthy();
        expect(op, `allowlist entry "${entry}" must be domain-qualified`).toBeTruthy();
        expect(
          listKnownActuatorOps(domain).includes(op),
          `allowlist entry "${entry}" (tier "${profile.name}") does not exist in the actuator op registry — fictional op vocabulary defeats the tier`
        ).toBe(true);
      }
    }
  });
});
