import {
  evaluateDeliverableQuality,
  type DeliverableQualityReport,
} from './deliverable-quality.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { logger } from './core.js';

/**
 * MO-07 Task 4.2: draft → rubric critique → refine for long-form
 * deliverables (doc/deck text). The deterministic deliverable rubric seeds
 * the critique so the refine pass targets concrete findings instead of
 * generic "make it better" churn. Hard caps: at most two refine passes and
 * an early exit as soon as the rubric is clean — the loop multiplies token
 * cost and is meant for high-risk / strict work only (callers gate it).
 */

export interface DraftRefineInput {
  kind: 'doc' | 'deck';
  content: string;
  goalSummary?: string;
  /** 1 (default) or 2 — anything higher is clamped. */
  maxPasses?: number;
  /**
   * Refine function. Given the current draft and rubric findings, returns
   * the improved draft. Defaults to a reasoning-backend prompt; injectable
   * so tests (and stub environments) stay deterministic.
   */
  refine?: (draft: string, findings: string[]) => Promise<string>;
}

export interface DraftRefinePass {
  pass: number;
  findings: string[];
  severity: DeliverableQualityReport['severity'];
}

export interface DraftRefineOutcome {
  content: string;
  passes: number;
  improved: boolean;
  initial_severity: DeliverableQualityReport['severity'];
  final_severity: DeliverableQualityReport['severity'];
  history: DraftRefinePass[];
}

const SEVERITY_RANK: Record<DeliverableQualityReport['severity'], number> = {
  ok: 2,
  warn: 1,
  poor: 0,
};

function defaultRefine(kind: 'doc' | 'deck', goalSummary?: string) {
  return async (draft: string, findings: string[]): Promise<string> => {
    const backend = getReasoningBackend();
    const prompt = [
      `You previously drafted the following ${kind === 'deck' ? 'presentation content' : 'document'}.`,
      goalSummary ? `Goal: ${goalSummary}` : '',
      `A quality rubric flagged these findings:`,
      ...findings.map((finding) => `- ${finding}`),
      '',
      'Rewrite the draft to resolve every finding. Preserve the existing',
      'structure, headings and factual content; do not invent layout or',
      'design directives. Return ONLY the rewritten draft.',
      '',
      '--- DRAFT ---',
      draft,
    ]
      .filter(Boolean)
      .join('\n');
    return await backend.prompt(prompt);
  };
}

export async function draftRefine(input: DraftRefineInput): Promise<DraftRefineOutcome> {
  const maxPasses = Math.min(Math.max(input.maxPasses ?? 1, 0), 2);
  const refine = input.refine ?? defaultRefine(input.kind, input.goalSummary);

  let current = input.content;
  let report = evaluateDeliverableQuality(input.kind, current);
  const initialSeverity = report.severity;
  const history: DraftRefinePass[] = [];
  let passes = 0;

  while (report.severity !== 'ok' && passes < maxPasses) {
    const findings = [...report.hard_checks, ...report.soft_checks];
    history.push({ pass: passes + 1, findings, severity: report.severity });
    let revised: string;
    try {
      revised = await refine(current, findings);
    } catch (err: any) {
      logger.warn(`[draft-refine] pass ${passes + 1} failed: ${err?.message || err}`);
      break;
    }
    passes += 1;
    if (!revised || !revised.trim()) break;

    const revisedReport = evaluateDeliverableQuality(input.kind, revised);
    // Keep the revision only if it does not regress the rubric.
    if (SEVERITY_RANK[revisedReport.severity] >= SEVERITY_RANK[report.severity]) {
      current = revised;
      report = revisedReport;
    } else {
      logger.warn(
        `[draft-refine] pass ${passes} regressed (${report.severity} → ${revisedReport.severity}); keeping the previous draft`
      );
      break;
    }
  }

  return {
    content: current,
    passes,
    improved: SEVERITY_RANK[report.severity] > SEVERITY_RANK[initialSeverity],
    initial_severity: initialSeverity,
    final_severity: report.severity,
    history,
  };
}
