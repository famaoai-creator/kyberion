/**
 * Deciding whether a provider has earned `calibrated: true`.
 *
 * `judgment-backend.ts` refuses to let a provider declare its own
 * calibration and reads `judgment-calibration.json` instead. This is what
 * produces an entry for that file — and, far more often, what refuses to.
 *
 * Calibration means a stated confidence matches observed frequency: answers
 * given at 0.8 are right about 80% of the time. Measuring that needs enough
 * labelled samples per confidence band to estimate a frequency at all. On
 * twelve synthetic cases, or on a handful of real ones, expected calibration
 * error is a number you can compute and must not believe, so
 * `proposeCalibrationEntry` returns a refusal with its reason rather than a
 * fit. Refusing is the normal outcome and not a failure.
 *
 * A provider must also be deterministic before any of this means anything:
 * a fit describes a fixed relationship between confidence and correctness,
 * and TypeSafe Jev returned three different answers to one utterance asked
 * three times. `requireDeterministic` enforces that the samples came from
 * repeated identical runs.
 */

export interface CalibrationSample {
  /** What was judged; carried for audit, not used in the fit. */
  id: string;
  /** The provider's stated confidence, 0..1. */
  confidence: number;
  /** Whether the answer was right. */
  correct: boolean;
  /** Repeated identical runs agreed. Absent means unknown. */
  stable?: boolean;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  /** Mean stated confidence in this bin. */
  meanConfidence: number;
  /** Observed fraction correct in this bin. */
  accuracy: number;
}

export interface ReliabilityReport {
  samples: number;
  accuracy: number;
  /** Expected calibration error: the gap between claim and observation. */
  ece: number;
  /** Signed: positive means the provider claims more than it delivers. */
  overconfidence: number;
  bins: ReliabilityBin[];
}

const DEFAULT_BINS = 5;

/** Reliability bins, accuracy and ECE. Computing this is always allowed. */
export function computeReliability(
  samples: readonly CalibrationSample[],
  binCount = DEFAULT_BINS
): ReliabilityReport {
  const usable = samples.filter(
    (sample) => Number.isFinite(sample.confidence) && typeof sample.correct === 'boolean'
  );
  if (usable.length === 0) {
    return {
      samples: 0,
      accuracy: Number.NaN,
      ece: Number.NaN,
      overconfidence: Number.NaN,
      bins: [],
    };
  }

  const bins: ReliabilityBin[] = [];
  for (let index = 0; index < binCount; index++) {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const inBin = usable.filter((sample) =>
      index === binCount - 1
        ? sample.confidence >= lower && sample.confidence <= upper
        : sample.confidence >= lower && sample.confidence < upper
    );
    if (inBin.length === 0) continue;
    bins.push({
      lower,
      upper,
      count: inBin.length,
      meanConfidence: inBin.reduce((sum, s) => sum + s.confidence, 0) / inBin.length,
      accuracy: inBin.filter((s) => s.correct).length / inBin.length,
    });
  }

  const ece = bins.reduce(
    (sum, bin) => sum + (bin.count / usable.length) * Math.abs(bin.meanConfidence - bin.accuracy),
    0
  );
  const overconfidence = bins.reduce(
    (sum, bin) => sum + (bin.count / usable.length) * (bin.meanConfidence - bin.accuracy),
    0
  );

  return {
    samples: usable.length,
    accuracy: usable.filter((s) => s.correct).length / usable.length,
    ece,
    overconfidence,
    bins,
  };
}

/**
 * Temperature scaling on the stated confidence.
 *
 * A single parameter that sharpens or softens confidence without changing
 * the ranking, fitted by minimising negative log likelihood over a coarse
 * grid. One parameter is the right size of model for a few hundred samples;
 * anything richer would fit the sample rather than the provider.
 */
export function fitTemperature(samples: readonly CalibrationSample[]): number {
  const usable = samples.filter(
    (sample) =>
      sample.confidence > 0 && sample.confidence < 1 && typeof sample.correct === 'boolean'
  );
  if (usable.length === 0) return 1;

  let best = 1;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (let temperature = 0.25; temperature <= 4.0001; temperature += 0.05) {
    let loss = 0;
    for (const sample of usable) {
      const logit = Math.log(sample.confidence / (1 - sample.confidence));
      const scaled = 1 / (1 + Math.exp(-logit / temperature));
      const clamped = Math.min(0.999999, Math.max(0.000001, scaled));
      loss -= sample.correct ? Math.log(clamped) : Math.log(1 - clamped);
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = temperature;
    }
  }
  return Math.round(best * 100) / 100;
}

export interface CalibrationProposalInput {
  providerId: string;
  questionId: string;
  samples: readonly CalibrationSample[];
  /** Where the samples came from; recorded in the entry. */
  fittedFrom: string;
  /** Minimum labelled samples. Default 100. */
  minSamples?: number;
  /** Minimum samples in any populated confidence band. Default 10. */
  minPerBin?: number;
  /** Refuse unless every sample came from a run that repeated identically. */
  requireDeterministic?: boolean;
  /** Refuse if residual ECE after scaling exceeds this. Default 0.1. */
  maxEce?: number;
}

export interface CalibrationProposal {
  accepted: boolean;
  /** Why it was refused, or how it was fitted. */
  reason: string;
  report: ReliabilityReport;
  temperature?: number;
  /** Ready to merge into judgment-calibration.json when accepted. */
  entry?: {
    questions: string[];
    fitted_from: string;
    fitted_at: string;
    temperatures: Record<string, number>;
  };
}

/**
 * Propose a calibration entry, or explain why the data does not support one.
 *
 * Refusing is the expected result until a corpus exists.
 */
export function proposeCalibrationEntry(input: CalibrationProposalInput): CalibrationProposal {
  const minSamples = input.minSamples ?? 100;
  const minPerBin = input.minPerBin ?? 10;
  const maxEce = input.maxEce ?? 0.1;
  const samples = input.samples || [];
  const report = computeReliability(samples);

  const refuse = (reason: string): CalibrationProposal => ({ accepted: false, reason, report });

  if (report.samples < minSamples) {
    return refuse(
      `${report.samples} labelled samples; ${minSamples} are needed before a confidence band means anything`
    );
  }

  if (input.requireDeterministic) {
    const unstable = samples.filter((sample) => sample.stable === false);
    if (unstable.length > 0) {
      return refuse(
        `${unstable.length} of ${samples.length} samples came from runs that disagreed; a fit describes a fixed relationship and this provider does not have one`
      );
    }
    const unknown = samples.filter((sample) => sample.stable === undefined);
    if (unknown.length > 0) {
      return refuse(
        `${unknown.length} samples were not checked for run-to-run stability; re-run them before fitting`
      );
    }
  }

  const thin = report.bins.filter((bin) => bin.count < minPerBin);
  if (thin.length > 0) {
    return refuse(
      `confidence bands ${thin
        .map((bin) => `${bin.lower.toFixed(1)}-${bin.upper.toFixed(1)} (n=${bin.count})`)
        .join(', ')} are below ${minPerBin} samples; their observed frequency is noise`
    );
  }

  const temperature = fitTemperature(samples);
  const scaled = samples.map((sample) => {
    const logit = Math.log(
      Math.min(0.999999, Math.max(0.000001, sample.confidence)) /
        (1 - Math.min(0.999999, Math.max(0.000001, sample.confidence)))
    );
    return { ...sample, confidence: 1 / (1 + Math.exp(-logit / temperature)) };
  });
  const after = computeReliability(scaled);

  if (after.ece > maxEce) {
    return {
      accepted: false,
      reason: `residual ECE ${after.ece.toFixed(3)} after temperature ${temperature} exceeds ${maxEce}; scaling cannot make this provider calibrated for '${input.questionId}'`,
      report: after,
      temperature,
    };
  }

  return {
    accepted: true,
    reason: `ECE ${report.ece.toFixed(3)} -> ${after.ece.toFixed(3)} at temperature ${temperature} over ${report.samples} samples`,
    report: after,
    temperature,
    entry: {
      questions: [input.questionId],
      fitted_from: input.fittedFrom,
      fitted_at: new Date().toISOString(),
      temperatures: { [input.questionId]: temperature },
    },
  };
}
