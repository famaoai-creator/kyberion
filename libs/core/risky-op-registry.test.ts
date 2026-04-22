import { describe, expect, it, vi } from 'vitest';

vi.mock('./approval-gate.js', () => ({
  enforceApprovalGate: vi.fn(),
}));

import { enforceApprovalGate } from './approval-gate.js';
import { RISKY_OPS, isKnownRiskyOp, requireApprovalForOp } from './risky-op-registry.js';

describe('risky-op-registry', () => {
  describe('RISKY_OPS constants', () => {
    it('includes the expected op ids', () => {
      expect(RISKY_OPS.SECRET_GRANT_ACCESS).toBe('secret:grant_access');
      expect(RISKY_OPS.AUTH_GRANT_AUTHORITY).toBe('auth:grant_authority');
      expect(RISKY_OPS.CONFIG_UPDATE).toBe('config:update');
      expect(RISKY_OPS.VAULT_WRITE).toBe('vault:write');
    });
  });

  describe('isKnownRiskyOp', () => {
    it('returns true for known ops', () => {
      expect(isKnownRiskyOp('secret:grant_access')).toBe(true);
      expect(isKnownRiskyOp('vault:write')).toBe(true);
    });

    it('returns false for unknown ops', () => {
      expect(isKnownRiskyOp('arbitrary:op')).toBe(false);
      expect(isKnownRiskyOp('')).toBe(false);
    });
  });

  describe('requireApprovalForOp', () => {
    it('delegates to enforceApprovalGate with defaults', () => {
      const mock = enforceApprovalGate as unknown as ReturnType<typeof vi.fn>;
      mock.mockReturnValue({ allowed: false, status: 'pending', message: 'pending review' });

      const result = requireApprovalForOp({
        opId: RISKY_OPS.SECRET_GRANT_ACCESS,
        agentId: 'mission_controller',
        payload: { missionId: 'MSN-1', serviceId: 'svc', ttlMinutes: 15 },
      });

      expect(result.allowed).toBe(false);
      expect(mock).toHaveBeenCalledTimes(1);
      const call = mock.mock.calls[0][0];
      expect(call.operationId).toBe('secret:grant_access');
      expect(call.intentId).toBe('secret:grant_access');
      expect(call.agentId).toBe('mission_controller');
      expect(call.channel).toBe('system');
      expect(typeof call.correlationId).toBe('string');
      expect(call.correlationId.length).toBeGreaterThan(0);
      expect(call.payload).toEqual({ missionId: 'MSN-1', serviceId: 'svc', ttlMinutes: 15 });
    });

    it('honours explicit correlationId and channel', () => {
      const mock = enforceApprovalGate as unknown as ReturnType<typeof vi.fn>;
      mock.mockReturnValue({ allowed: true, status: 'approved' });

      requireApprovalForOp({
        opId: RISKY_OPS.VAULT_WRITE,
        agentId: 'mission_controller',
        correlationId: 'caller-supplied-id',
        channel: 'slack',
      });

      const call = mock.mock.calls.at(-1)?.[0];
      expect(call?.correlationId).toBe('caller-supplied-id');
      expect(call?.channel).toBe('slack');
    });
  });
});
