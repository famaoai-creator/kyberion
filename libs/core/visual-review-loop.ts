import { createLogger } from './logger.js';
import {
  formatVisualReviewReport,
  loadVisualReviewRubric,
  runVisualReview,
  type VisualFinding,
  type VisualReviewReport,
  type RunVisualReviewInput,
} from './visual-review.js';

/**
 * MP-04: the review loop — render, look, fix, look again.
 *
 * A single critique pass finds problems but changes nothing; the value is in
 * closing the loop. Each round rasterizes the current artifact, critiques the
 * pixels, applies the fixes the caller knows how to apply, and re-renders.
 *
 * Three guarantees shape the design:
 *
 * - **Bounded.** Rounds are capped (3 by default). Each round costs a render
 *   plus a model call, and the deterministic layout fit already removed the
 *   mechanical defects a longer loop would otherwise chase.
 * - **Honest on exit.** A loop that stops with findings still open reports them
 *   rather than returning success. "Reviewed and still imperfect" and "never
 *   reviewed" are distinct outcomes, and neither is "passed".
 * - **Explicit delivery policy.** The loop itself only reports; the caller's
 *   delivery gate decides whether residual or unreviewed output may ship.
 *   This keeps model disagreement separate from the deterministic policy that
 *   requires an actual clean review for governed media delivery.
 */

const logger = createLogger('visual-review-loop');

export interface VisualReviewRound {
  round: number;
  status: VisualReviewReport['status'];
  error_count: number;
  warning_count: number;
  /** Findings the applier reported as addressed this round. */
  applied_fixes: number;
  skipped_reason?: string;
}

export interface VisualReviewLoopResult {
  /**
   * `clean` — reviewed with no errors left.
   * `residual` — reviewed, findings remain (delivered with them surfaced).
   * `unreviewed` — never got to look (no rasterizer, egress denied, stub).
   */
  outcome: 'clean' | 'residual' | 'unreviewed';
  rounds: VisualReviewRound[];
  /** Findings still open when the loop stopped. */
  outstanding: VisualFinding[];
  /** Operator-facing summary; safe to log or attach to a delivery. */
  summary: string;
  final_report?: VisualReviewReport;
}

export interface VisualReviewLoopInput {
  /**
   * Produce the current artifact's page images. Called once per round, so a
   * re-render after fixes is reflected in the next critique.
   */
  render: (round: number) => Promise<{ images: string[]; unavailable_reason?: string }>;
  /**
   * Apply the findings. Return how many were actually addressed — returning 0
   * stops the loop, because re-critiquing an unchanged artifact just spends
   * tokens to receive the same findings.
   */
  applyFixes?: (findings: VisualFinding[], round: number) => Promise<number>;
  review: Omit<RunVisualReviewInput, 'images'>;
  maxRounds?: number;
  /** Called after each round; used to write Trace entries. */
  onRound?: (round: VisualReviewRound, report: VisualReviewReport) => void;
}

export async function runVisualReviewLoop(
  input: VisualReviewLoopInput
): Promise<VisualReviewLoopResult> {
  const rubric = input.review.rubric ?? loadVisualReviewRubric();
  const maxRounds = Math.max(1, Math.min(10, input.maxRounds ?? rubric.iteration.max_rounds));
  const rounds: VisualReviewRound[] = [];
  let lastReport: VisualReviewReport | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    const rendered = await input.render(round);

    const report = await runVisualReview({
      ...input.review,
      images: rendered.images,
      rubric,
    });
    lastReport = report;

    // A render that never produced pixels is reported as unreviewed, carrying
    // the renderer's own reason when it gave one.
    if (report.status === 'skipped' && rendered.unavailable_reason) {
      report.skipped_reason = rendered.unavailable_reason;
    }

    let appliedFixes = 0;
    const actionable = report.findings.filter((finding) => finding.severity === 'error');
    if (report.status === 'reviewed' && actionable.length > 0 && input.applyFixes) {
      try {
        appliedFixes = await input.applyFixes(report.findings, round);
      } catch (error: any) {
        logger.warn(`[visual-review] fix application failed in round ${round}: ${error?.message}`);
      }
    }

    const roundRecord: VisualReviewRound = {
      round,
      status: report.status,
      error_count: report.error_count,
      warning_count: report.warning_count,
      applied_fixes: appliedFixes,
      ...(report.skipped_reason ? { skipped_reason: report.skipped_reason } : {}),
    };
    rounds.push(roundRecord);
    input.onRound?.(roundRecord, report);

    if (report.status !== 'reviewed') break;
    if (rubric.iteration.stop_when_no_errors && report.error_count === 0) break;
    // Nothing changed, so the next critique would see the same artifact.
    if (appliedFixes === 0) break;
  }

  const finalReport = lastReport;
  const reviewed = finalReport?.status === 'reviewed';
  const outstanding = reviewed ? (finalReport?.findings ?? []) : [];
  const outcome: VisualReviewLoopResult['outcome'] = !reviewed
    ? 'unreviewed'
    : (finalReport?.findings.length ?? 0) === 0
      ? 'clean'
      : 'residual';

  return {
    outcome,
    rounds,
    outstanding,
    summary: buildSummary(outcome, rounds, finalReport),
    ...(finalReport ? { final_report: finalReport } : {}),
  };
}

function buildSummary(
  outcome: VisualReviewLoopResult['outcome'],
  rounds: VisualReviewRound[],
  report?: VisualReviewReport
): string {
  const roundCount = rounds.length;
  if (outcome === 'unreviewed') {
    const reason = rounds[rounds.length - 1]?.skipped_reason ?? 'no reason recorded';
    // Deliberately worded so this cannot be mistaken for a pass.
    return `visual review did not run — the artifact was NOT inspected: ${reason}`;
  }
  if (outcome === 'clean') {
    return `visual review passed after ${roundCount} round(s)${
      report?.verdict ? `: ${report.verdict}` : ''
    }`;
  }
  return [
    `visual review finished with findings still open after ${roundCount} round(s) — delivered with known issues:`,
    report ? formatVisualReviewReport(report) : '',
  ]
    .filter(Boolean)
    .join('\n');
}
