import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
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
  const detail = normalizeText(match[3]);
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

let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, FEEDBACK_SCHEMA_PATH);
  return validateFn;
}

function defaultStore(): ExecutionFeedbackStore {
  return { version: '1.0.0', entries: [] };
}

function validateStore(store: unknown): ExecutionFeedbackStore {
  const validate = ensureValidator();
  if (!validate(store)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid execution feedback store: ${errors}`);
  }
  return store as ExecutionFeedbackStore;
}

function loadStoreFromDisk(): ExecutionFeedbackStore {
  if (!safeExistsSync(FEEDBACK_STORE_PATH)) return defaultStore();
  try {
    return validateStore(
      JSON.parse(safeReadFile(FEEDBACK_STORE_PATH, { encoding: 'utf8' }) as string)
    );
  } catch {
    return defaultStore();
  }
}

function normalizeText(value: string | undefined): string | undefined {
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
    recorded_at: new Date().toISOString(),
    ...(input.correlation_id?.trim() ? { correlation_id: input.correlation_id.trim() } : {}),
    ...(input.surface?.trim() ? { surface: input.surface.trim() } : {}),
    ...(normalizeText(input.comment) ? { comment: normalizeText(input.comment) } : {}),
    ...(normalizeText(input.correction) ? { correction: normalizeText(input.correction) } : {}),
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
  const validate = ensureValidator();
  const valid = Boolean(validate(value));
  return {
    valid,
    errors: valid
      ? []
      : (validate.errors || []).map(
          (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
        ),
    value: valid ? (value as ExecutionFeedbackStore) : undefined,
  };
}
