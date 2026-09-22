/**
 * WI-06: deterministic candidate scoring and tenant/personal-scoped
 * calibration for work inventory entries.
 *
 * Ranking and calibration are pure functions over the record type defined in
 * `work-inventory.ts` and the `scoring_defaults` block of the governed
 * taxonomy catalog. A calibration record narrows or overrides the taxonomy
 * defaults for one tenant/personal scope and is learned from realized
 * automation outcomes, never guessed by an LLM — see
 * docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md
 * §2.4 / §6 (WI-06).
 */
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { compileSchema } from './foundation/ajv.js';
import { nowIso } from './foundation/time.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import {
  loadWorkInventoryTaxonomy,
  workInventoryRoot,
  type WorkEffect,
  type WorkEntryStatus,
  type WorkFrequencyPer,
  type WorkInventoryEntry,
  type WorkInventoryObservation,
  type WorkInventoryScope,
  type WorkInventoryScoringWeights,
  type WorkInventoryTaxonomy,
  type WorkMethod,
  type WorkObservationSource,
} from './work-inventory.js';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type WorkInventoryScoreBasisRuns = 'observed' | 'self_report' | 'none';
export type WorkInventoryScoreBasisEffort = 'self_report' | 'observed' | 'none';

export interface WorkInventoryScoreComponents {
  runs_per_month: number;
  effort_minutes: number;
  hours_per_month: number;
  automatable_ratio: number;
  confidence: number;
  risk: number;
}

export interface WorkInventoryScoreResult {
  entry_id: string;
  score: number;
  components: WorkInventoryScoreComponents;
  basis: { runs: WorkInventoryScoreBasisRuns; effort: WorkInventoryScoreBasisEffort };
  explanation: string[];
}

export interface WorkInventoryScoreOptions {
  taxonomy?: WorkInventoryTaxonomy;
  calibration?: WorkInventoryCalibration;
  /** Reserved for future recency-weighting; not used by the current formula. */
  now?: Date;
}

const OBSERVED_RUNS_SOURCES: WorkObservationSource[] = [
  'kyberion_trace',
  'desktop_recording',
  'browser_recording',
];

/**
 * Only recordings of a person operating the machine measure *human* effort.
 * A `kyberion_trace` duration is machine time (how long an automated run
 * took) and never stands in for the minutes a person spends on the work.
 */
const OBSERVED_EFFORT_SOURCES: WorkObservationSource[] = ['desktop_recording', 'browser_recording'];

/** self-report frequency → runs per month, per plan §6 (WI-06 acceptance). */
const FREQUENCY_PER_MONTH_MULTIPLIER: Record<WorkFrequencyPer, number> = {
  day: 21.7,
  week: 52 / 12,
  month: 1,
  quarter: 1 / 3,
  year: 1 / 12,
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function resolveRunsPerMonth(entry: WorkInventoryEntry): {
  value: number;
  basis: WorkInventoryScoreBasisRuns;
} {
  const observedPerWeek = (entry.observations ?? [])
    .filter(
      (
        observation
      ): observation is WorkInventoryObservation & {
        metrics: { per_week: number };
      } =>
        OBSERVED_RUNS_SOURCES.includes(observation.source) &&
        typeof observation.metrics?.per_week === 'number'
    )
    .map((observation) => observation.metrics.per_week);
  if (observedPerWeek.length > 0) {
    const maxPerWeek = Math.max(...observedPerWeek);
    return { value: maxPerWeek * (52 / 12), basis: 'observed' };
  }
  if (entry.frequency) {
    const multiplier = FREQUENCY_PER_MONTH_MULTIPLIER[entry.frequency.per];
    return { value: entry.frequency.count * multiplier, basis: 'self_report' };
  }
  return { value: 0, basis: 'none' };
}

function resolveEffortMinutes(entry: WorkInventoryEntry): {
  value: number;
  basis: WorkInventoryScoreBasisEffort;
} {
  if (typeof entry.effort_minutes_per_run === 'number') {
    return { value: entry.effort_minutes_per_run, basis: 'self_report' };
  }
  const observedDurations = (entry.observations ?? [])
    .filter(
      (
        observation
      ): observation is WorkInventoryObservation & {
        metrics: { median_duration_ms: number };
      } =>
        OBSERVED_EFFORT_SOURCES.includes(observation.source) &&
        typeof observation.metrics?.median_duration_ms === 'number'
    )
    .map((observation) => observation.metrics.median_duration_ms);
  if (observedDurations.length > 0) {
    return { value: Math.max(...observedDurations) / 60000, basis: 'observed' };
  }
  return { value: 0, basis: 'none' };
}

function resolveAutomatableRatio(
  entry: WorkInventoryEntry,
  methodAutomatable: Record<WorkMethod, number>
): number {
  if (entry.steps.length === 0) return 0;
  const total = entry.steps.reduce(
    (sum, step) => sum + (methodAutomatable[step.method.assigned] ?? 0),
    0
  );
  return total / entry.steps.length;
}

function resolveConfidence(
  entry: WorkInventoryEntry,
  sourceConfidence: Record<WorkObservationSource, number>
): number {
  const observations = entry.observations ?? [];
  if (observations.length === 0) return sourceConfidence.self_report;
  return Math.max(...observations.map((observation) => sourceConfidence[observation.source] ?? 0));
}

function distinctEffects(entry: WorkInventoryEntry): WorkEffect[] {
  const effects = new Set<WorkEffect>();
  for (const step of entry.steps) {
    for (const effect of step.effects) effects.add(effect);
  }
  return [...effects].sort();
}

function resolveRisk(
  entry: WorkInventoryEntry,
  riskEffectPenalty: WorkInventoryTaxonomy['scoring_defaults']['risk_effect_penalty']
): { value: number; effects: WorkEffect[] } {
  const effects = distinctEffects(entry);
  const total = effects.reduce((sum, effect) => sum + (riskEffectPenalty[effect] ?? 0), 0);
  return { value: Math.min(1, total), effects };
}

/**
 * Deterministic score for one entry: higher means a better automation
 * candidate. Weights and `method_automatable` come from `calibration` when
 * provided, else the taxonomy's `scoring_defaults` (plan §6, WI-06:
 * "順位が入力に対して決定的。校正で重みが変わると順位が変わる").
 */
export function scoreWorkInventoryEntry(
  entry: WorkInventoryEntry,
  options: WorkInventoryScoreOptions = {}
): WorkInventoryScoreResult {
  const taxonomy = options.taxonomy ?? loadWorkInventoryTaxonomy();
  const weights: WorkInventoryScoringWeights =
    options.calibration?.weights ?? taxonomy.scoring_defaults.weights;
  const methodAutomatable: Record<WorkMethod, number> =
    options.calibration?.method_automatable ?? taxonomy.scoring_defaults.method_automatable;

  const runs = resolveRunsPerMonth(entry);
  const effort = resolveEffortMinutes(entry);
  const automatableRatio = resolveAutomatableRatio(entry, methodAutomatable);
  const confidence = resolveConfidence(
    entry,
    taxonomy.scoring_defaults.observation_source_confidence
  );
  const risk = resolveRisk(entry, taxonomy.scoring_defaults.risk_effect_penalty);
  const hoursPerMonth = (runs.value * effort.value) / 60;

  const score = round4(
    Math.pow(runs.value, weights.frequency) *
      Math.pow(effort.value / 60, weights.effort) *
      Math.pow(automatableRatio, weights.automatable_ratio) *
      Math.pow(confidence, weights.confidence) *
      Math.pow(1 - risk.value, weights.risk_penalty)
  );

  const explanation = [
    `runs_per_month: ${round4(runs.value)} (${runs.basis})`,
    `effort_minutes: ${round4(effort.value)} (${effort.basis})`,
    `automatable_ratio: ${round4(automatableRatio)} (mean over ${entry.steps.length} step${
      entry.steps.length === 1 ? '' : 's'
    })`,
    `confidence: ${round4(confidence)} (${
      (entry.observations ?? []).length > 0 ? 'max observed source' : 'self_report default'
    })`,
    `risk: ${round4(risk.value)}${
      risk.effects.length > 0 ? ` (effects: ${risk.effects.join(', ')})` : ''
    }`,
    `score: ${score}`,
  ];

  return {
    entry_id: entry.entry_id,
    score,
    components: {
      runs_per_month: round4(runs.value),
      effort_minutes: round4(effort.value),
      hours_per_month: round4(hoursPerMonth),
      automatable_ratio: round4(automatableRatio),
      confidence: round4(confidence),
      risk: round4(risk.value),
    },
    basis: { runs: runs.basis, effort: effort.basis },
    explanation,
  };
}

const DEFAULT_CANDIDATE_STATUSES: WorkEntryStatus[] = ['draft', 'confirmed', 'candidate'];

export interface WorkInventoryRankOptions {
  taxonomy?: WorkInventoryTaxonomy;
  calibration?: WorkInventoryCalibration;
  includeStatuses?: WorkEntryStatus[];
  limit?: number;
}

/**
 * Scores and ranks entries descending by score, ties broken by `entry_id`
 * ascending so the order is fully deterministic for identical inputs.
 */
export function rankWorkInventoryCandidates(
  entries: WorkInventoryEntry[],
  options: WorkInventoryRankOptions = {}
): WorkInventoryScoreResult[] {
  const taxonomy = options.taxonomy ?? loadWorkInventoryTaxonomy();
  const includeStatuses = options.includeStatuses ?? DEFAULT_CANDIDATE_STATUSES;
  const scored = entries
    .filter((entry) => includeStatuses.includes(entry.status))
    .map((entry) => scoreWorkInventoryEntry(entry, { taxonomy, calibration: options.calibration }))
    .sort((a, b) => b.score - a.score || a.entry_id.localeCompare(b.entry_id));
  return typeof options.limit === 'number' ? scored.slice(0, options.limit) : scored;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface WorkInventoryCalibrationScope {
  tenant_slug?: string;
}

export interface WorkInventoryCalibrationChange {
  from: number;
  to: number;
}

export interface WorkInventoryCalibrationHistoryEntry {
  at: string;
  reason: string;
  changes: Record<string, WorkInventoryCalibrationChange>;
}

export interface WorkInventoryCalibration {
  schema_version: 'work-inventory-calibration.v1';
  scope: WorkInventoryCalibrationScope;
  weights: WorkInventoryScoringWeights;
  method_automatable: Record<WorkMethod, number>;
  updated_at: string;
  history: WorkInventoryCalibrationHistoryEntry[];
}

const MAX_CALIBRATION_HISTORY = 50;

const CALIBRATION_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/work-inventory-calibration.schema.json'
);
let calibrationValidator: ValidateFunction<WorkInventoryCalibration> | undefined;

function getCalibrationValidator(): ValidateFunction<WorkInventoryCalibration> {
  calibrationValidator ||= compileSchema<WorkInventoryCalibration>(CALIBRATION_SCHEMA_PATH);
  return calibrationValidator;
}

export function validateWorkInventoryCalibration(input: unknown): {
  valid: boolean;
  errors: string[];
} {
  const validate = getCalibrationValidator();
  if (validate(input)) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
  return { valid: false, errors };
}

/** Builds an unpersisted calibration seeded from the taxonomy's `scoring_defaults`. */
export function defaultWorkInventoryCalibration(
  scope: WorkInventoryCalibrationScope,
  taxonomy: WorkInventoryTaxonomy = loadWorkInventoryTaxonomy(),
  now: Date = new Date()
): WorkInventoryCalibration {
  return {
    schema_version: 'work-inventory-calibration.v1',
    scope: scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {},
    weights: { ...taxonomy.scoring_defaults.weights },
    method_automatable: { ...taxonomy.scoring_defaults.method_automatable },
    updated_at: nowIso(now),
    history: [],
  };
}

function calibrationPath(scope: WorkInventoryCalibrationScope, rootDir: string): string {
  const root = workInventoryRoot(scope as WorkInventoryScope, rootDir);
  const candidate = path.join(root, 'calibration.json');
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true, rootDir });
}

/** Loads the tenant/personal calibration, falling back to the taxonomy defaults when absent. */
export function loadWorkInventoryCalibration(
  scope: WorkInventoryCalibrationScope,
  options: { rootDir?: string } = {}
): WorkInventoryCalibration {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const filePath = calibrationPath(scope, rootDir);
  if (!safeExistsSync(filePath)) return defaultWorkInventoryCalibration(scope);
  const raw = parseSafeJsonInput(
    String(safeReadFile(filePath, { encoding: 'utf8' })),
    `work inventory calibration ${scope.tenant_slug ?? 'personal'}`
  );
  const check = validateWorkInventoryCalibration(raw);
  if (!check.valid) {
    throw new Error(
      `Invalid work inventory calibration at ${filePath}: ${check.errors.join('; ')}`
    );
  }
  return raw as WorkInventoryCalibration;
}

export function saveWorkInventoryCalibration(
  calibration: WorkInventoryCalibration,
  options: { rootDir?: string } = {}
): WorkInventoryCalibration {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const check = validateWorkInventoryCalibration(calibration);
  if (!check.valid) {
    throw new Error(`Invalid work inventory calibration: ${check.errors.join('; ')}`);
  }
  const filePath = calibrationPath(calibration.scope, rootDir);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(calibration, null, 2)}\n`, { encoding: 'utf8' });
  return calibration;
}

export interface WorkInventoryCalibrationSample {
  entry_id: string;
  /** Share of steps assigned to each method; shares for one sample sum to 1. */
  method_mix: Partial<Record<WorkMethod, number>>;
  /** Mean automatable share of the steps (same quantity scoring ranks on). */
  predicted_automatable_ratio: number;
  /**
   * Same quantity, realized: `predicted_automatable_ratio × success_rate`
   * where `success_rate = 1 − failures/runs`. So `realized / predicted` is the
   * success rate (≤ 1) — a half-api/half-human entry whose automated runs
   * never fail realizes exactly its prediction.
   */
  realized_automatable_ratio: number;
}

export interface CalibrateFromOutcomesOptions {
  now?: Date;
  learningRate?: number;
  reason: string;
}

/**
 * Learns `method_automatable` from realized promotion outcomes: each method
 * in a sample's mix moves toward `current × (realized / predicted)` — i.e.
 * `current × success_rate` (see `WorkInventoryCalibrationSample`) — weighted
 * by how much of the observed mix it represents and by `learningRate`. With
 * samples from `buildCalibrationSamples` (work-inventory-promotion.ts) the
 * ratio is ≤ 1, so methods are only lowered, and only when automated runs failed. `human` never moves (plan §2.4:
 * 判断を要するステップは人間のまま); samples with a non-positive prediction
 * are ignored so the function stays a pure fold over valid samples.
 */
export function calibrateFromOutcomes(
  calibration: WorkInventoryCalibration,
  samples: WorkInventoryCalibrationSample[],
  options: CalibrateFromOutcomesOptions
): WorkInventoryCalibration {
  const now = options.now ?? new Date();
  const learningRate = options.learningRate ?? 0.2;
  const validSamples = samples.filter((sample) => sample.predicted_automatable_ratio > 0);

  const shareTotals = new Map<WorkMethod, number>();
  const weightedTargetTotals = new Map<WorkMethod, number>();

  for (const sample of validSamples) {
    const ratio = sample.realized_automatable_ratio / sample.predicted_automatable_ratio;
    for (const [methodKey, share] of Object.entries(sample.method_mix)) {
      const method = methodKey as WorkMethod;
      if (method === 'human') continue;
      if (!share || share <= 0) continue;
      const current = calibration.method_automatable[method];
      shareTotals.set(method, (shareTotals.get(method) ?? 0) + share);
      weightedTargetTotals.set(
        method,
        (weightedTargetTotals.get(method) ?? 0) + share * (current * ratio)
      );
    }
  }

  const nextMethodAutomatable = { ...calibration.method_automatable };
  const changes: Record<string, WorkInventoryCalibrationChange> = {};

  for (const [method, totalShare] of shareTotals) {
    if (totalShare <= 0) continue;
    const targetAverage = (weightedTargetTotals.get(method) ?? 0) / totalShare;
    const current = calibration.method_automatable[method];
    const next = clamp01(current + learningRate * (targetAverage - current));
    if (next !== current) {
      changes[`method_automatable.${method}`] = { from: current, to: next };
      nextMethodAutomatable[method] = next;
    }
  }

  const historyEntry: WorkInventoryCalibrationHistoryEntry = {
    at: nowIso(now),
    reason: options.reason,
    changes,
  };
  const history = [...calibration.history, historyEntry].slice(-MAX_CALIBRATION_HISTORY);

  return {
    ...calibration,
    method_automatable: nextMethodAutomatable,
    updated_at: nowIso(now),
    history,
  };
}
