import { randomUUID } from 'node:crypto';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile } from './secure-io.js';
import {
  createDistillCandidateRecord,
  listDistillCandidateRecords,
  saveDistillCandidateRecord,
  updateDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { t } from './t.js';

const FEEDBACK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/execution-feedback.schema.json'
);
const FEEDBACK_STORE_PATH = pathResolver.shared('runtime/execution-feedback.json');
const MAX_FEEDBACK_ENTRIES = 500;
const MAX_FEEDBACK_TEXT_LENGTH = 2000;

export type ExecutionFeedbackOutcome = 'satisfied' | 'partially_satisfied' | 'dissatisfied';

export interface ExecutionFeedbackInput {
  scenario_id: string;
  intent_id: string;
  correlation_id?: string;
  surface?: string;
  outcome: ExecutionFeedbackOutcome;
  comment?: string;
  correction?: string;
  source?: 'user' | 'operator';
}

export interface ExecutionFeedbackRecord extends Required<
  Pick<ExecutionFeedbackInput, 'scenario_id' | 'intent_id' | 'outcome'>
> {
  kind: 'execution-feedback';
  schema_version: '1.0.0';
  feedback_id: string;
  correlation_id?: string;
  surface?: string;
  comment?: string;
  correction?: string;
  source: 'user' | 'operator';
  recorded_at: string;
}

export interface ExecutionFeedbackStore {
  version: '1.0.0';
  entries: ExecutionFeedbackRecord[];
}

export interface ExecutionFeedbackSummary {
  scenario_id: string;
  intent_id: string;
  sample_count: number;
  outcome_counts: Record<ExecutionFeedbackOutcome, number>;
  satisfaction_rate: number;
  common_corrections: string[];
  recent_comments: string[];
  last_outcome?: ExecutionFeedbackOutcome;
  improvement_status: 'none' | 'observing' | 'candidate';
}

export interface ExecutionFeedbackRequest {
  scenario_id: string;
  intent_id: string;
  correlation_id?: string;
  outcomes: ExecutionFeedbackOutcome[];
  structured: true;
}

export interface ExecutionFeedbackCandidateResult {
  summary: ExecutionFeedbackSummary;
  candidate: DistillCandidateRecord | null;
}

/**
 * Turn a non-positive execution result into a reviewable improvement item.
 *
 * Feedback is deliberately kept separate from the procedure catalog: a user
 * correction proposes a change, but never silently changes an executable
 * procedure. A human must review the candidate before it can be promoted.
 */
export function materializeExecutionFeedbackCandidate(input: {
  feedback: ExecutionFeedbackRecord;
  procedureId?: string;
}): ExecutionFeedbackCandidateResult {
  const summary = summarizeExecutionFeedback({
    scenarioId: input.feedback.scenario_id,
    intentId: input.feedback.intent_id,
  });
  if (summary.improvement_status !== 'candidate') {
    return { summary, candidate: null };
  }

  const existing = listDistillCandidateRecords().find((candidate) => {
    const metadata = candidate.metadata;
    return (
      candidate.status === 'proposed' &&
      metadata?.improvement_kind === 'execution_feedback' &&
      metadata.scenario_id === input.feedback.scenario_id &&
      metadata.intent_id === input.feedback.intent_id
    );
  });
  const correction =
    summary.common_corrections[0] ||
    input.feedback.correction ||
    input.feedback.comment ||
    t('recorder:recorder_default_correction', undefined, 'en');
  // Persist a locale-neutral canonical representation. The CLI translates its
  // surrounding state, but a candidate must not change identity or content
  // merely because it was materialized from a different operator locale.
  const title = t(
    'recorder:recorder_candidate_title',
    {
      id: input.procedureId || input.feedback.intent_id,
    },
    'en'
  );
  const candidateInput = {
    source_type: 'task_session' as const,
    tier: 'personal' as const,
    task_session_id: input.feedback.correlation_id,
    title,
    summary: t(
      'recorder:recorder_candidate_summary',
      {
        outcome: input.feedback.outcome,
        correction,
      },
      'en'
    ),
    locale: 'en',
    status: 'proposed' as const,
    target_kind: 'procedure' as const,
    evidence_refs: [
      `execution-feedback:${input.feedback.feedback_id}`,
      `intent:${input.feedback.intent_id}`,
    ],
    metadata: {
      improvement_kind: 'execution_feedback',
      scenario_id: input.feedback.scenario_id,
      intent_id: input.feedback.intent_id,
      ...(input.procedureId ? { procedure_id: input.procedureId } : {}),
      latest_outcome: input.feedback.outcome,
      common_corrections: summary.common_corrections,
      review_required: true,
      recommended_action: 'review and update the procedure before the next run',
    },
  };
  const candidate = existing
    ? updateDistillCandidateRecord(existing.candidate_id, {
        title: candidateInput.title,
        summary: candidateInput.summary,
        evidence_refs: [
          ...new Set([...(existing.evidence_refs || []), ...candidateInput.evidence_refs]),
        ],
        metadata: { ...(existing.metadata || {}), ...candidateInput.metadata },
      })
    : (() => {
        const created = createDistillCandidateRecord(candidateInput);
        saveDistillCandidateRecord(created);
        return created;
      })();
  return { summary, candidate };
}

export function parseExecutionFeedbackText(text: string): ExecutionFeedbackInput | null {
  const match = text
    .trim()
    .match(
      /^評価\s+(use-case-[a-z0-9_-]+)\s*[:：]\s*(満足|一部違う|不満|satisfied|partially_satisfied|dissatisfied)(?:\s*[:：]\s*(.+))?$/iu
    );
  if (!match) return null;
  const outcomeByLabel: Record<string, ExecutionFeedbackOutcome> = {
    満足: 'satisfied',
    一部違う: 'partially_satisfied',
    不満: 'dissatisfied',
    satisfied: 'satisfied',
    partially_satisfied: 'partially_satisfied',
    dissatisfied: 'dissatisfied',
  };
  const scenarioId = match[1];
  const label = match[2];
  const detail = normalizeFeedbackText(match[3]);
  return {
    scenario_id: scenarioId,
    intent_id: scenarioId.slice('use-case-'.length),
    outcome: outcomeByLabel[label.toLowerCase()] || outcomeByLabel[label],
    ...(detail
      ? {
          ...(outcomeByLabel[label.toLowerCase()] === 'satisfied'
            ? { comment: detail }
            : { correction: detail, comment: detail }),
        }
      : {}),
  };
}

function defaultStore(): ExecutionFeedbackStore {
  return { version: '1.0.0', entries: [] };
}

const executionFeedbackCatalog: GovernedCatalog<ExecutionFeedbackStore> = defineCatalog({
  id: 'execution-feedback',
  path: FEEDBACK_STORE_PATH,
  schema: FEEDBACK_SCHEMA_PATH,
  fallback: defaultStore,
  fallbackOnInvalid: true,
});

function validateStore(store: unknown): ExecutionFeedbackStore {
  try {
    return executionFeedbackCatalog.validate(store, FEEDBACK_STORE_PATH);
  } catch (error) {
    throw new Error(
      `Invalid execution feedback store: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function loadStoreFromDisk(): ExecutionFeedbackStore {
  return executionFeedbackCatalog.load();
}

function normalizeFeedbackText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_FEEDBACK_TEXT_LENGTH);
}

export function resolveExecutionFeedbackPath(): string {
  return FEEDBACK_STORE_PATH;
}

export function loadExecutionFeedbackStore(): ExecutionFeedbackStore {
  return loadStoreFromDisk();
}

export function recordExecutionFeedback(input: ExecutionFeedbackInput): ExecutionFeedbackRecord {
  const record: ExecutionFeedbackRecord = {
    kind: 'execution-feedback',
    schema_version: '1.0.0',
    feedback_id: randomUUID(),
    scenario_id: input.scenario_id.trim(),
    intent_id: input.intent_id.trim(),
    outcome: input.outcome,
    source: input.source || 'user',
    recorded_at: nowIso(),
    ...(input.correlation_id?.trim() ? { correlation_id: input.correlation_id.trim() } : {}),
    ...(input.surface?.trim() ? { surface: input.surface.trim() } : {}),
    ...(normalizeFeedbackText(input.comment)
      ? { comment: normalizeFeedbackText(input.comment) }
      : {}),
    ...(normalizeFeedbackText(input.correction)
      ? { correction: normalizeFeedbackText(input.correction) }
      : {}),
  };
  const store = loadStoreFromDisk();
  const nextStore = validateStore({
    version: '1.0.0',
    entries: [...store.entries, record].slice(-MAX_FEEDBACK_ENTRIES),
  });
  safeWriteFile(FEEDBACK_STORE_PATH, JSON.stringify(nextStore, null, 2));
  return record;
}

export function summarizeExecutionFeedback(input: {
  scenarioId: string;
  intentId: string;
}): ExecutionFeedbackSummary {
  const entries = loadStoreFromDisk().entries.filter(
    (entry) => entry.scenario_id === input.scenarioId && entry.intent_id === input.intentId
  );
  const outcomeCounts: Record<ExecutionFeedbackOutcome, number> = {
    satisfied: 0,
    partially_satisfied: 0,
    dissatisfied: 0,
  };
  const correctionCounts = new Map<string, number>();
  for (const entry of entries) {
    outcomeCounts[entry.outcome] += 1;
    if (entry.correction) {
      correctionCounts.set(entry.correction, (correctionCounts.get(entry.correction) || 0) + 1);
    }
  }
  const commonCorrections = [...correctionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([correction]) => correction);
  const recentComments = entries
    .slice(-3)
    .reverse()
    .map((entry) => entry.comment)
    .filter((comment): comment is string => Boolean(comment));
  const sampleCount = entries.length;
  const nonSatisfied = outcomeCounts.partially_satisfied + outcomeCounts.dissatisfied;
  return {
    scenario_id: input.scenarioId,
    intent_id: input.intentId,
    sample_count: sampleCount,
    outcome_counts: outcomeCounts,
    satisfaction_rate:
      sampleCount === 0 ? 0 : Number((outcomeCounts.satisfied / sampleCount).toFixed(4)),
    common_corrections: commonCorrections,
    recent_comments: recentComments,
    ...(entries.at(-1)?.outcome ? { last_outcome: entries.at(-1)?.outcome } : {}),
    improvement_status: sampleCount === 0 ? 'none' : nonSatisfied > 0 ? 'candidate' : 'observing',
  };
}

export function buildExecutionFeedbackHints(summary: ExecutionFeedbackSummary): string[] {
  if (summary.sample_count === 0) return [];
  const hints: string[] = [];
  if (summary.common_corrections.length > 0) {
    hints.push(
      `Prior user corrections for this scenario: ${summary.common_corrections.join(' / ')}`
    );
  }
  if (summary.outcome_counts.dissatisfied > 0) {
    hints.push(
      'Previous user feedback included dissatisfaction; confirm scope and success conditions before repeating the same handoff.'
    );
  } else if (summary.outcome_counts.partially_satisfied > 0) {
    hints.push(
      'Previous user feedback was partially satisfied; address known gaps before presenting the scenario as complete.'
    );
  }
  return hints;
}

export function validateExecutionFeedback(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: ExecutionFeedbackStore;
} {
  try {
    return { valid: true, errors: [], value: executionFeedbackCatalog.validate(value) };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
