import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateMissionGate,
  resolveGateOverrideSignatureMode,
  signHumanOverride,
} from './mission-gate-engine.js';
import { resetA2ASecretCache } from './a2a-envelope-signature.js';

// MO-02: human_override checks must carry an attributable HMAC signature.
// warn (default) preserves the legacy pass-through; enforce rejects
// missing or tampered signatures.

describe('human_override signature (MO-02)', () => {
  beforeEach(() => {
    process.env.KYBERION_A2A_SECRET = 'test-secret';
    resetA2ASecretCache();
  });

  afterEach(() => {
    delete process.env.KYBERION_A2A_SECRET;
    delete process.env.KYBERION_GATE_OVERRIDE_SIGNATURE;
    resetA2ASecretCache();
  });

  async function evaluate(params: Record<string, unknown>) {
    return evaluateMissionGate({
      missionId: 'M-TEST',
      gate: { id: 'gate-1', checks: [{ kind: 'human_override', params }] },
    });
  }

  it('defaults to warn mode and keeps unsigned overrides passing', async () => {
    expect(resolveGateOverrideSignatureMode()).toBe('warn');
    const result = await evaluate({});
    expect(result.verdict).toBe('pass');
  });

  it('enforce rejects an unsigned override', async () => {
    process.env.KYBERION_GATE_OVERRIDE_SIGNATURE = 'enforce';
    const result = await evaluate({});
    expect(result.verdict).toBe('fail');
    expect(result.reasons.join(' ')).toContain('approved_by');
  });

  it('enforce accepts a properly signed override', async () => {
    process.env.KYBERION_GATE_OVERRIDE_SIGNATURE = 'enforce';
    const params = signHumanOverride({ gateId: 'gate-1', approvedBy: 'sovereign-user' });
    const result = await evaluate(params);
    expect(result.verdict).toBe('pass');
  });

  it('enforce rejects a signature bound to a different gate', async () => {
    process.env.KYBERION_GATE_OVERRIDE_SIGNATURE = 'enforce';
    const params = signHumanOverride({ gateId: 'other-gate', approvedBy: 'sovereign-user' });
    const result = await evaluate(params);
    expect(result.verdict).toBe('fail');
    expect(result.reasons.join(' ')).toContain('does not verify');
  });

  it('enforce rejects a tampered approver', async () => {
    process.env.KYBERION_GATE_OVERRIDE_SIGNATURE = 'enforce';
    const params = signHumanOverride({ gateId: 'gate-1', approvedBy: 'sovereign-user' });
    params.approved_by = 'mallory';
    const result = await evaluate(params);
    expect(result.verdict).toBe('fail');
  });

  it('explicit denial still fails regardless of mode', async () => {
    const result = await evaluate({ allow: false, reason: 'denied by operator' });
    expect(result.verdict).toBe('fail');
    expect(result.reasons).toContain('denied by operator');
  });
});
