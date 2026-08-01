import { describe, expect, it } from 'vitest';
import { createGapRecorder, GAP_PHASES, isKnownGapPhase, sanitizeGapSamples } from './gap-phase.js';
import { delegateTaskWithUntrustedData } from './reasoning-backend.js';

describe('gap-phase (QM-09)', () => {
  it('vocabulary accepts base phases and tool_body.* only', () => {
    for (const phase of GAP_PHASES) expect(isKnownGapPhase(phase)).toBe(true);
    expect(isKnownGapPhase('tool_body.browser:extract')).toBe(true);
    expect(isKnownGapPhase('made_up_phase')).toBe(false);
    expect(isKnownGapPhase('tool_body.')).toBe(false);
  });

  it('recorder attributes elapsed time to named phases in order', async () => {
    let clock = 0;
    const recorder = createGapRecorder(() => clock);
    recorder.measureSync('prompt_build', () => {
      clock += 5;
    });
    await recorder.measure('backend_dispatch', async () => {
      clock += 40;
    });
    expect(recorder.samples()).toEqual([
      { phase: 'prompt_build', ms: 5 },
      { phase: 'backend_dispatch', ms: 40 },
    ]);
    expect(recorder.totalMs()).toBe(45);
  });

  it('recorder attributes time even when the measured fn throws', async () => {
    let clock = 0;
    const recorder = createGapRecorder(() => clock);
    await expect(
      recorder.measure('backend_dispatch', async () => {
        clock += 10;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(recorder.samples()).toEqual([{ phase: 'backend_dispatch', ms: 10 }]);
  });

  it('sanitizeGapSamples drops unknown phases and invalid durations with a warning', () => {
    const warnings: string[] = [];
    const kept = sanitizeGapSamples(
      [
        { phase: 'backend_dispatch', ms: 12.6 },
        { phase: 'typo_phase', ms: 5 },
        { phase: 'parse', ms: -1 },
        { phase: 'tool_body.web', ms: 3 },
      ],
      (message) => warnings.push(message)
    );
    expect(kept).toEqual([
      { phase: 'backend_dispatch', ms: 13 },
      { phase: 'tool_body.web', ms: 3 },
    ]);
    expect(warnings).toHaveLength(2);
  });

  it('delegateTaskWithUntrustedData reports prompt_build and backend_dispatch phases', async () => {
    const backend = {
      delegateTask: async () => 'ok',
    };
    let observed: Array<{ phase: string; ms: number }> = [];
    const result = await delegateTaskWithUntrustedData(
      backend,
      'summarize',
      { untrustedData: 'external text' },
      {
        context: 'gap-test',
        onGapPhases: (samples) => {
          observed = samples;
        },
      }
    );
    expect(result).toBe('ok');
    expect(observed.map((sample) => sample.phase)).toEqual(['prompt_build', 'backend_dispatch']);
  });
});
