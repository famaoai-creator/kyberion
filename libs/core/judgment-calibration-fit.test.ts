import { describe, expect, it } from 'vitest';
import {
  computeReliability,
  fitTemperature,
  proposeCalibrationEntry,
  type CalibrationSample,
} from './judgment-calibration-fit.js';

/** `n` samples stated at `confidence`, of which `accuracy` are correct. */
function band(confidence: number, n: number, accuracy: number, stable = true): CalibrationSample[] {
  return Array.from({ length: n }, (_, index) => ({
    id: `${confidence}-${index}`,
    confidence,
    correct: index < Math.round(n * accuracy),
    stable,
  }));
}

/** Well calibrated: each band is right about as often as it claims. */
const CALIBRATED = [
  ...band(0.1, 40, 0.1),
  ...band(0.3, 40, 0.3),
  ...band(0.5, 40, 0.5),
  ...band(0.7, 40, 0.7),
  ...band(0.9, 40, 0.9),
];

/** Overconfident: claims 0.9, delivers 0.5. */
const OVERCONFIDENT = [
  ...band(0.9, 60, 0.5),
  ...band(0.7, 60, 0.4),
  ...band(0.5, 60, 0.3),
  ...band(0.3, 60, 0.2),
  ...band(0.1, 60, 0.1),
];

describe('computeReliability', () => {
  it('reports near-zero error for a calibrated provider', () => {
    const report = computeReliability(CALIBRATED);
    expect(report.samples).toBe(200);
    expect(report.ece).toBeLessThan(0.05);
    expect(Math.abs(report.overconfidence)).toBeLessThan(0.05);
  });

  it('names overconfidence with a sign', () => {
    const report = computeReliability(OVERCONFIDENT);
    expect(report.ece).toBeGreaterThan(0.15);
    // Positive means claiming more than delivering.
    expect(report.overconfidence).toBeGreaterThan(0.15);
  });

  it('survives an empty sample set', () => {
    const report = computeReliability([]);
    expect(report.samples).toBe(0);
    expect(report.bins).toEqual([]);
  });
});

describe('fitTemperature', () => {
  it('leaves a calibrated provider roughly alone', () => {
    expect(fitTemperature(CALIBRATED)).toBeGreaterThan(0.7);
    expect(fitTemperature(CALIBRATED)).toBeLessThan(1.5);
  });

  it('softens an overconfident one', () => {
    expect(fitTemperature(OVERCONFIDENT)).toBeGreaterThan(1.2);
  });
});

describe('proposeCalibrationEntry', () => {
  const base = {
    providerId: 'laya-mlx',
    questionId: 'error.category',
    fittedFrom: 'unclassified-error-registry',
  };

  it('refuses a sample set too small to estimate a frequency', () => {
    const proposal = proposeCalibrationEntry({ ...base, samples: band(0.9, 12, 0.9) });
    expect(proposal.accepted).toBe(false);
    expect(proposal.reason).toMatch(/12 labelled samples/);
    expect(proposal.entry).toBeUndefined();
  });

  it('refuses when a confidence band is too thin, even with enough total', () => {
    const proposal = proposeCalibrationEntry({
      ...base,
      // 150 samples, but one band holds 3 of them.
      samples: [...band(0.9, 147, 0.9), ...band(0.1, 3, 0.1)],
    });
    expect(proposal.accepted).toBe(false);
    expect(proposal.reason).toMatch(/below 10 samples|is noise/);
  });

  it('refuses a provider whose runs disagree', () => {
    const proposal = proposeCalibrationEntry({
      ...base,
      providerId: 'typesafe-jev',
      samples: CALIBRATED.map((sample, index) => ({ ...sample, stable: index % 10 !== 0 })),
      requireDeterministic: true,
    });
    expect(proposal.accepted).toBe(false);
    expect(proposal.reason).toMatch(/disagreed/);
  });

  it('refuses when stability was never checked', () => {
    const proposal = proposeCalibrationEntry({
      ...base,
      samples: CALIBRATED.map(({ stable: _stable, ...rest }) => rest),
      requireDeterministic: true,
    });
    expect(proposal.accepted).toBe(false);
    expect(proposal.reason).toMatch(/not checked for run-to-run stability/);
  });

  it('refuses when scaling cannot fix the provider', () => {
    // Confidence that is unrelated to correctness: every band right 50% of
    // the time. No single temperature makes that calibrated across bands.
    const noise = [
      ...band(0.1, 50, 0.5),
      ...band(0.3, 50, 0.5),
      ...band(0.5, 50, 0.5),
      ...band(0.7, 50, 0.5),
      ...band(0.9, 50, 0.5),
    ];
    const proposal = proposeCalibrationEntry({ ...base, samples: noise, maxEce: 0.05 });
    expect(proposal.accepted).toBe(false);
    expect(proposal.reason).toMatch(/residual ECE/);
  });

  it('accepts a deterministic, well-populated, fixable provider', () => {
    // Temperature scaling is monotone in the logit, so it can only undo a
    // distribution that was *sharpened* by one. Building the fixture the
    // other way round — stating 0.9 while delivering 0.5, and 0.1 while
    // delivering 0.1 — asks for T=∞ and T=1 at once, which no single
    // temperature satisfies; `proposeCalibrationEntry` correctly refuses
    // that, and the 'residual ECE' case above covers it.
    const sharpen = (p: number, by: number) => {
      const logit = Math.log(p / (1 - p));
      return 1 / (1 + Math.exp(-logit / by));
    };
    const fixable = [0.2, 0.4, 0.6, 0.8].flatMap((trueAccuracy) =>
      band(sharpen(trueAccuracy, 0.5), 50, trueAccuracy)
    );
    const proposal = proposeCalibrationEntry({
      ...base,
      samples: fixable,
      requireDeterministic: true,
      maxEce: 0.15,
    });
    expect(proposal.accepted).toBe(true);
    expect(proposal.entry?.questions).toEqual(['error.category']);
    expect(proposal.entry?.temperatures?.['error.category']).toBeGreaterThan(1);
    expect(proposal.entry?.temperatures?.['error.category']).toBe(proposal.temperature);
    expect(proposal.entry?.fitted_from).toBe('unclassified-error-registry');
    expect(proposal.reason).toMatch(/ECE .* -> /);
  });
});
