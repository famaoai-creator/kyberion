import { describe, expect, it, vi } from 'vitest';
import { runMachineOnlyMissionGate, type MachineMissionGatePorts } from './mission_machine_gate.js';
import type { StoredGateEvaluationResult } from '@agent/core/mission/mission-process-planning';

function harness(
  result: StoredGateEvaluationResult = {
    found: true,
    phase: 'execution',
    position: 'exit',
    evaluation: {
      gate_id: 'EXECUTION_DONE',
      verdict: 'pass',
      reasons: [],
      checked_at: '2026-10-18T00:00:00Z',
      checks: [{ kind: 'command_succeeds', passed: true }],
    },
  }
) {
  const events: string[] = [];
  const ports = {
    evaluateStored: vi.fn(
      async (_input: { missionId: string; gateId: string; humanConfirmed: false }) => {
        events.push('evaluate');
        return result;
      }
    ),
    advance: vi.fn(async () => {
      events.push('advance');
    }),
    markCompleted: vi.fn(() => {
      events.push('mark');
      return 2;
    }),
    activate: vi.fn(async () => {
      events.push('activate');
      return true;
    }),
    recordEvaluation: vi.fn(() => {
      events.push('record');
    }),
  } satisfies MachineMissionGatePorts;
  return { ports, events };
}
const input = { missionId: 'msn-machine-test', gateId: 'EXECUTION_DONE' };

describe('machine-only mission gate', () => {
  it('evaluates stored checks without manufacturing human confirmation, then advances in order', async () => {
    const h = harness();
    expect(await runMachineOnlyMissionGate(input, h.ports)).toEqual({
      mission_id: 'MSN-MACHINE-TEST',
      gate_id: 'EXECUTION_DONE',
      verdict: 'pass',
      completed_tasks: 2,
      activated: true,
    });
    expect(h.ports.evaluateStored).toHaveBeenCalledWith({
      missionId: 'MSN-MACHINE-TEST',
      gateId: 'EXECUTION_DONE',
      humanConfirmed: false,
    });
    expect(h.events).toEqual(['evaluate', 'record', 'advance', 'mark', 'activate']);
    expect(h.ports.advance).toHaveBeenCalledWith('MSN-MACHINE-TEST', 'execution');
  });
  it.each(['ci', 'scope', 'mixed'] as const)(
    'labels only a sole typed CI waiting refusal (%s)',
    async (mode) => {
      const h = harness({
        found: true,
        phase: 'test',
        position: 'exit',
        evaluation: {
          gate_id: 'TESTS_PASSED',
          verdict: 'fail',
          checked_at: '2026-11-02T00:00:00Z',
          reasons: [
            mode === 'scope' ? 'Scope mismatch' : '[DEVELOPMENT_CI_WAITING] Current checks pending',
          ],
          checks: [
            { kind: 'development_ci_verified', passed: false },
            ...(mode === 'mixed' ? [{ kind: 'evidence_exists' as const, passed: false }] : []),
          ],
        },
      });
      let message = '';
      try {
        await runMachineOnlyMissionGate({ ...input, gateId: 'TESTS_PASSED' }, h.ports);
      } catch (error) {
        message = String(error);
      }
      expect(message.includes('[DEVELOPMENT_CI_WAITING]')).toBe(mode === 'ci');
      expect(h.ports.advance).not.toHaveBeenCalled();
      expect(h.ports.markCompleted).not.toHaveBeenCalled();
    }
  );
  it.each([
    undefined,
    'gate.json',
    '../EXECUTION_DONE',
    '/tmp/gate',
    'definitions/GATE',
    'gate\\file',
    'GATE.id',
    '--note',
  ])('rejects evidence file or malformed gate ID %s before evaluation', async (gateId) => {
    const h = harness();
    await expect(runMachineOnlyMissionGate({ ...input, gateId }, h.ports)).rejects.toThrow(
      'stored gate ID'
    );
    expect(h.events).toEqual([]);
  });
  it.each([{ found: false }, { found: true }])(
    'fails closed when the stored definition/evaluation is unavailable: %j',
    async (stored) => {
      const h = harness(stored);
      await expect(runMachineOnlyMissionGate(input, h.ports)).rejects.toThrow('definition missing');
      expect(h.events).toEqual(['evaluate']);
      expect(h.ports.advance).not.toHaveBeenCalled();
      expect(h.ports.markCompleted).not.toHaveBeenCalled();
      expect(h.ports.activate).not.toHaveBeenCalled();
    }
  );
  it.each(['command_succeeds'] as const)(
    'never advances or marks tasks on failed %s checks',
    async (kind) => {
      const h = harness({
        found: true,
        phase: 'execution',
        position: 'exit',
        evaluation: {
          gate_id: 'EXECUTION_DONE',
          verdict: 'fail',
          reasons: ['Required evidence missing'],
          checked_at: '2026-10-18T00:00:00Z',
          checks: [{ kind, passed: false }],
        },
      });
      await expect(runMachineOnlyMissionGate(input, h.ports)).rejects.toThrow('checks failed');
      expect(h.ports.evaluateStored.mock.calls[0][0].humanConfirmed).toBe(false);
      expect(h.events).toEqual(['evaluate', 'record']);
    }
  );
  it.each(['reviewer_approved', 'human_override'] as const)(
    'rejects raw %s even when static gate params nominally pass',
    async (kind) => {
      const h = harness({
        found: true,
        phase: 'execution',
        position: 'exit',
        evaluation: {
          gate_id: 'EXECUTION_DONE',
          verdict: 'pass',
          reasons: [],
          checked_at: '2026-10-18T00:00:00Z',
          checks: [{ kind, passed: true }],
        },
      });
      await expect(runMachineOnlyMissionGate(input, h.ports)).rejects.toThrow(
        'cannot supply human or reviewer'
      );
      expect(h.events).toEqual(['evaluate']);
      expect(h.ports.advance).not.toHaveBeenCalled();
      expect(h.ports.markCompleted).not.toHaveBeenCalled();
      expect(h.ports.activate).not.toHaveBeenCalled();
    }
  );
  it('accepts a successful approval-bound machine check without claiming human identity', async () => {
    const h = harness({
      found: true,
      position: 'entry',
      phase: 'alignment',
      evaluation: {
        gate_id: 'ALIGNMENT_APPROVED',
        verdict: 'pass',
        reasons: [],
        checked_at: '2026-10-18T00:00:00Z',
        checks: [{ kind: 'command_succeeds', passed: true }],
      },
    });
    await runMachineOnlyMissionGate({ ...input, gateId: 'ALIGNMENT_APPROVED' }, h.ports);
    expect(h.events).toEqual(['evaluate', 'record', 'activate']);
    expect(h.ports.evaluateStored.mock.calls[0][0]).not.toHaveProperty('actorId');
    expect(h.ports.markCompleted).not.toHaveBeenCalled();
  });
  it('propagates evaluator failures without attempting advancement or fallback', async () => {
    const h = harness();
    h.ports.evaluateStored.mockRejectedValue(new Error('Invalid stored contract'));
    await expect(runMachineOnlyMissionGate(input, h.ports)).rejects.toThrow(
      'Invalid stored contract'
    );
    expect(h.ports.advance).not.toHaveBeenCalled();
    expect(h.ports.markCompleted).not.toHaveBeenCalled();
    expect(h.ports.activate).not.toHaveBeenCalled();
  });
  it('never marks contracts if phase advancement fails', async () => {
    const h = harness();
    h.ports.advance.mockRejectedValue(new Error('phase transition rejected'));
    await expect(runMachineOnlyMissionGate(input, h.ports)).rejects.toThrow(
      'phase transition rejected'
    );
    expect(h.ports.markCompleted).not.toHaveBeenCalled();
    expect(h.ports.activate).not.toHaveBeenCalled();
  });
});
