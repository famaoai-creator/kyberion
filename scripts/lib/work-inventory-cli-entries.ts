/**
 * WI-07: entry lifecycle command handlers for `pnpm inventory` — add / list /
 * show / classify / override / status / candidates. See
 * scripts/work_inventory.ts for the dispatcher and
 * scripts/lib/work-inventory-cli-shared.ts for the shared argv helpers.
 */
import {
  applyClassification,
  createWorkInventoryEntry,
  listWorkInventoryEntries,
  loadWorkInventoryEntry,
  migrateInferredBindings,
  saveWorkInventoryEntry,
  stepForcedHumanEffects,
  type WorkEntryStatus,
  type WorkInventoryEntry,
  type WorkInventoryStep,
  type WorkMethod,
  type WorkTriggerKind,
} from '@agent/core/work-inventory';
import { proposeWorkDecomposition } from '@agent/core/work-inventory-decompose';
import {
  loadWorkInventoryCalibration,
  rankWorkInventoryCandidates,
  scoreWorkInventoryEntry,
  type WorkInventoryScoreResult,
} from '@agent/core/work-inventory-scoring';
import {
  csv,
  formatTable,
  getFlag,
  governed,
  hasFlag,
  parseEffortMinutesFlag,
  parseFrequencyFlag,
  parseLimitFlag,
  requireDecidedBy,
  requireFlag,
  resolveScope,
  truncate,
  WorkInventoryCliUsageError,
} from './work-inventory-cli-shared.js';

export interface WorkInventoryCliOptions {
  rootDir?: string;
}

const TRIGGER_KINDS: readonly WorkTriggerKind[] = ['schedule', 'event', 'request', 'ad_hoc'];
const STATUS_TRANSITIONS: readonly WorkEntryStatus[] = ['confirmed', 'candidate', 'retired'];
const METHODS: readonly WorkMethod[] = [
  'api',
  'computer_operation',
  'ai_reasoning',
  'program',
  'human',
];

function parseTriggerKind(argv: string[]): WorkTriggerKind | undefined {
  const raw = getFlag(argv, '--trigger');
  if (!raw) return undefined;
  if (!TRIGGER_KINDS.includes(raw as WorkTriggerKind)) {
    throw new WorkInventoryCliUsageError(`--trigger must be one of: ${TRIGGER_KINDS.join(', ')}`);
  }
  return raw as WorkTriggerKind;
}

function notFound(entryId: string): never {
  throw new WorkInventoryCliUsageError(`work inventory entry not found: ${entryId}`);
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddResult {
  entry: WorkInventoryEntry;
  warnings: string[];
  source: 'model' | 'heuristic' | 'empty';
}

/** Always writes a *new* entry (`mode: 'create'`): an id collision fails, never overwrites. */
export async function runAdd(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): Promise<AddResult> {
  const title = requireFlag(argv, '--title', 'add');
  const stepsText = getFlag(argv, '--steps');
  const systems = csv(argv, '--systems');
  const apiSystems = csv(argv, '--api-systems');
  const frequency = parseFrequencyFlag(argv);
  const effortMinutesPerRun = parseEffortMinutesFlag(argv);
  const triggerKind = parseTriggerKind(argv);
  const useModel = !hasFlag(argv, '--no-model');
  const scope = resolveScope(argv);
  const rootDir = options.rootDir;

  if (stepsText && stepsText.trim()) {
    const result = await proposeWorkDecomposition(
      {
        title,
        description: stepsText,
        scope,
        ...(systems.length > 0 ? { systems } : {}),
        ...(apiSystems.length > 0 ? { apiSystems } : {}),
        trigger: { kind: triggerKind ?? 'ad_hoc', description: stepsText.slice(0, 500) },
        ...(frequency ? { frequency } : {}),
        ...(effortMinutesPerRun !== undefined
          ? { effort_minutes_per_run: effortMinutesPerRun }
          : {}),
      },
      { useModel, ...(options.now ? { now: options.now } : {}) }
    );
    const saved = governed(() => saveWorkInventoryEntry(result.entry, { rootDir, mode: 'create' }));
    return { entry: saved, warnings: result.warnings, source: result.source };
  }

  const draft = createWorkInventoryEntry(
    {
      title,
      scope,
      trigger: { kind: triggerKind ?? 'ad_hoc', description: title },
      ...(frequency ? { frequency } : {}),
      ...(effortMinutesPerRun !== undefined ? { effort_minutes_per_run: effortMinutesPerRun } : {}),
      ...(systems.length > 0 ? { systems } : {}),
    },
    options.now
  );
  const classified = applyClassification(draft, { apiSystems });
  const saved = governed(() => saveWorkInventoryEntry(classified, { rootDir, mode: 'create' }));
  return { entry: saved, warnings: [], source: 'empty' };
}

// ---------------------------------------------------------------------------
// list / show / classify / override / status
// ---------------------------------------------------------------------------

export function runList(argv: string[], options: WorkInventoryCliOptions): WorkInventoryEntry[] {
  const scope = resolveScope(argv);
  const status = getFlag(argv, '--status');
  const entries = listWorkInventoryEntries(scope, { rootDir: options.rootDir });
  return status ? entries.filter((entry) => entry.status === status) : entries;
}

export interface ShowResult {
  entry: WorkInventoryEntry;
  score: WorkInventoryScoreResult;
}

export function runShow(
  entryId: string,
  argv: string[],
  options: WorkInventoryCliOptions
): ShowResult {
  const scope = resolveScope(argv);
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir: options.rootDir });
  if (!entry) notFound(entryId);
  return { entry, score: scoreWorkInventoryEntry(entry) };
}

export function runClassify(
  entryId: string,
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryEntry {
  const scope = resolveScope(argv);
  const apiSystems = csv(argv, '--api-systems');
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir: options.rootDir });
  if (!entry) notFound(entryId);
  const classified = applyClassification(entry, { apiSystems });
  return saveWorkInventoryEntry(classified, { rootDir: options.rootDir });
}

export function runOverride(
  entryId: string,
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryEntry {
  const scope = resolveScope(argv);
  const stepId = requireFlag(argv, '--step', 'override');
  const method = requireFlag(argv, '--method', 'override') as WorkMethod;
  if (!METHODS.includes(method)) {
    throw new WorkInventoryCliUsageError(`--method must be one of: ${METHODS.join(', ')}`);
  }
  const reason = requireFlag(argv, '--reason', 'override');
  const decidedBy = requireDecidedBy(argv);
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir: options.rootDir });
  if (!entry) notFound(entryId);
  const target = entry.steps.find((step) => step.step_id === stepId);
  if (!target) {
    throw new WorkInventoryCliUsageError(`entry ${entryId} has no step ${stepId}`);
  }
  const forced = stepForcedHumanEffects(target);
  if (method !== 'human' && forced.length > 0) {
    throw new WorkInventoryCliUsageError(
      `step ${stepId} has effect ${forced.join(', ')}, which always stays human; it cannot be overridden to ${method}`
    );
  }
  const steps: WorkInventoryStep[] = entry.steps.map((step) =>
    step.step_id === stepId
      ? {
          ...step,
          method: {
            assigned: method,
            source: 'human_override' as const,
            rationale: `${reason} (decided by ${decidedBy.id})`,
          },
        }
      : step
  );
  const reclassified = applyClassification({ ...entry, steps }, {});
  return saveWorkInventoryEntry(reclassified, { rootDir: options.rootDir });
}

export function runStatus(
  entryId: string,
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryEntry {
  const scope = resolveScope(argv);
  const to = requireFlag(argv, '--to', 'status') as WorkEntryStatus;
  if (!STATUS_TRANSITIONS.includes(to)) {
    throw new WorkInventoryCliUsageError(`--to must be one of: ${STATUS_TRANSITIONS.join(', ')}`);
  }
  // Enforced (a human decision, same grammar as promotion) but the entry
  // schema has no generic per-status decided_by field to persist it into —
  // only `promotion.decided_by` exists for the promoted transition.
  requireDecidedBy(argv);
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir: options.rootDir });
  if (!entry) notFound(entryId);
  return saveWorkInventoryEntry({ ...entry, status: to }, { rootDir: options.rootDir });
}

export function runCandidates(
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryScoreResult[] {
  const scope = resolveScope(argv);
  const limit = parseLimitFlag(argv);
  const entries = listWorkInventoryEntries(scope, { rootDir: options.rootDir });
  const calibration = loadWorkInventoryCalibration(
    scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {},
    { rootDir: options.rootDir }
  );
  return rankWorkInventoryCandidates(entries, { calibration, ...(limit ? { limit } : {}) });
}

// ---------------------------------------------------------------------------
// migrate (WI-17)
// ---------------------------------------------------------------------------

export interface MigrateEntryResult {
  entry_id: string;
  /** Steps whose `binding.inferred` was backfilled to `true`. */
  changed: number;
}

export interface MigrateResult {
  results: MigrateEntryResult[];
  /** Sum of `changed` across every touched entry. */
  total_changed: number;
  dry_run: boolean;
}

/**
 * WI-17: backfills `binding.inferred` on legacy entries whose binding
 * already matches the verb's first taxonomy candidate (see
 * `migrateInferredBindings`). Scans every entry in scope; only entries with
 * at least one changed step are saved (`--dry-run` saves nothing).
 */
export function runMigrate(
  argv: string[],
  options: WorkInventoryCliOptions & { dryRun: boolean }
): MigrateResult {
  const scope = resolveScope(argv);
  const entries = listWorkInventoryEntries(scope, { rootDir: options.rootDir });
  const results: MigrateEntryResult[] = [];
  let totalChanged = 0;
  for (const entry of entries) {
    const { entry: migrated, changed } = migrateInferredBindings(entry);
    if (changed === 0) continue;
    results.push({ entry_id: entry.entry_id, changed });
    totalChanged += changed;
    if (!options.dryRun) saveWorkInventoryEntry(migrated, { rootDir: options.rootDir });
  }
  return { results, total_changed: totalChanged, dry_run: options.dryRun };
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

export function formatStepsTable(
  steps: readonly WorkInventoryStep[],
  withRationale = false
): string {
  const headers = withRationale
    ? ['step', 'stage', 'verb', 'method', 'rationale']
    : ['step', 'stage', 'verb', 'method'];
  const rows = steps.map((step) =>
    withRationale
      ? [
          step.step_id,
          step.stage,
          step.verb,
          step.method.assigned,
          truncate(step.method.rationale, 80),
        ]
      : [step.step_id, step.stage, step.verb, step.method.assigned]
  );
  return formatTable(headers, rows);
}

export function formatEntryList(entries: readonly WorkInventoryEntry[]): string {
  return formatTable(
    ['entry_id', 'title', 'status'],
    entries.map((entry) => [entry.entry_id, truncate(entry.title, 48), entry.status])
  );
}

export function formatShow(result: ShowResult): string {
  const { entry, score } = result;
  const lines = [
    `${entry.entry_id}  ${entry.title}  [${entry.status}]`,
    `Trigger: ${entry.trigger.kind} — ${entry.trigger.description}`,
    '',
    'Steps:',
    formatStepsTable(entry.steps, true),
  ];
  if (entry.observations && entry.observations.length > 0) {
    lines.push('', 'Observations:');
    lines.push(
      formatTable(
        ['source', 'ref', 'observed_at', 'digest'],
        entry.observations.map((observation) => [
          observation.source,
          observation.ref,
          observation.observed_at,
          truncate(observation.digest ?? '', 60),
        ])
      )
    );
  }
  lines.push('', 'Score:', ...score.explanation.map((line) => `  ${line}`));
  return lines.join('\n');
}

export function formatCandidates(results: readonly WorkInventoryScoreResult[]): string {
  return formatTable(
    ['entry_id', 'score', 'hours/mo', 'automatable', 'confidence', 'risk', 'basis'],
    results.map((result) => [
      result.entry_id,
      String(result.score),
      String(result.components.hours_per_month),
      String(result.components.automatable_ratio),
      String(result.components.confidence),
      String(result.components.risk),
      `${result.basis.runs}/${result.basis.effort}`,
    ])
  );
}

export function formatMigrate(result: MigrateResult): string {
  const lines = [
    `${result.dry_run ? '(dry-run) ' : ''}entries changed: ${result.results.length}`,
    `bindings marked inferred: ${result.total_changed}`,
  ];
  if (result.results.length > 0) {
    lines.push(
      '',
      formatTable(
        ['entry_id', 'changed'],
        result.results.map((r) => [r.entry_id, String(r.changed)])
      )
    );
  }
  return lines.join('\n');
}
