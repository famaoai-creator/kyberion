import { describe, it, expect, vi, beforeEach } from 'vitest';
import { internals, processGovernanceAudit } from './lib.js';

describe('pmo-governance-lead lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should audit a specific phase correctly', () => {
    const checkSpy = vi.spyOn(internals, 'checkEvidence').mockImplementation((dir, evidence) => {
      if (evidence.label === 'Source Code' || evidence.label === 'Development Standards') {
        return { found: true, match: 'mocked-match' };
      }
      return { found: false, match: null };
    });

    const result = internals.auditPhase('/test', 'implementation');
    // 3 items in implementation. 2 found -> 66%
    expect(result.completion).toBeGreaterThanOrEqual(66);
    expect(result.status).toBe('partial');

    checkSpy.mockRestore();
  });

  it('should identify missing evidence and risks', () => {
    const checkSpy = vi
      .spyOn(internals, 'checkEvidence')
      .mockReturnValue({ found: false, match: null });

    const result = internals.auditPhase('/test', 'testing');
    expect(result.completion).toBe(0);
    expect(result.status).toBe('not_ready');

    const risks = internals.identifyRisks([result]);
    expect(risks.some((r) => r.severity === 'high')).toBe(true);

    checkSpy.mockRestore();
  });

  it('should process full governance audit', () => {
    // 内部呼び出しを全てスパイでコントロール
    const phaseSpy = vi.spyOn(internals, 'auditPhase').mockReturnValue({
      phase: 'Mock Phase',
      completion: 100,
      status: 'ready',
      evidence: [],
    });
    const riskSpy = vi.spyOn(internals, 'identifyRisks').mockReturnValue([]);

    const result = processGovernanceAudit('/test', 'all');
    expect(result.overallCompletion).toBe(100);
    expect(result.overallStatus).toBe('ready');
    expect(result.phases.length).toBe(5);

    phaseSpy.mockRestore();
    riskSpy.mockRestore();
  });
});
