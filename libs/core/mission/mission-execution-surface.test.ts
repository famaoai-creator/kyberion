import { describe, expect, it } from 'vitest';

import { resolveMissionExecutionSurface } from './mission-execution-surface.js';

describe('mission execution surface', () => {
  it('keeps short read-mostly work on the CLI subagent surface', () => {
    const decision = resolveMissionExecutionSurface({
      signals: { expected_duration: 1, write_volume: 0, recovery_requirement: 1 },
    });

    expect(decision.surface).toBe('cli_subagent');
    expect(decision.active_surface).toBe('cli_subagent');
    expect(decision.selected_by).toBe('rubric');
  });

  it('uses hybrid when escalation is plausible but not forced', () => {
    const decision = resolveMissionExecutionSurface({
      signals: { write_volume: 2, recovery_requirement: 2 },
    });

    expect(decision.surface).toBe('hybrid');
    expect(decision.active_surface).toBe('cli_subagent');
    expect(decision.escalation_axes).toEqual(['write_volume', 'recovery_requirement']);
  });

  it('forces agent-runtime when one axis reaches the hard threshold', () => {
    const decision = resolveMissionExecutionSurface({
      signals: { recovery_requirement: 3 },
    });

    expect(decision.surface).toBe('agent_runtime');
    expect(decision.active_surface).toBe('agent_runtime');
  });

  it('honors an explicit surface and accepts the workitem aliases', () => {
    expect(resolveMissionExecutionSurface({ requested: 'subagent' }).surface).toBe('cli_subagent');
    expect(resolveMissionExecutionSurface({ requested: 'agent-runtime' }).surface).toBe(
      'agent_runtime'
    );
    expect(resolveMissionExecutionSurface({ requested: 'hybrid' }).active_surface).toBe(
      'cli_subagent'
    );
  });

  it('rejects an unknown explicit surface instead of silently selecting a fallback', () => {
    expect(() => resolveMissionExecutionSurface({ requested: 'agent-runtim' })).toThrow(
      '[EXECUTION_SURFACE_INVALID]'
    );
  });
});
