/**
 * WI-07: `pnpm inventory promote` and `pnpm inventory learn` command
 * handlers.
 */
import {
  listWorkInventoryEntries,
  loadWorkInventoryEntry,
  loadWorkInventoryTaxonomy,
  saveWorkInventoryEntry,
} from '@agent/core/work-inventory';
import {
  applyWorkInventoryPromotion,
  buildCalibrationSamples,
  detectWorkInventoryLearningSignals,
  executeMissionPromotion,
  measureWorkInventoryOutcome,
  planWorkInventoryPromotion,
  recordWorkInventoryOutcome,
  runWorkInventoryLearningCycle,
  type WorkInventoryPromotionPlan,
} from '@agent/core/work-inventory-promotion';
import { collectKyberionDemandSignals } from '@agent/core/work-inventory-harvest';
import {
  calibrateFromOutcomes,
  loadWorkInventoryCalibration,
  type WorkInventoryCalibration,
} from '@agent/core/work-inventory-scoring';
import type { OperationalLearningSignal } from '@agent/core/operational-learning';
import {
  csv,
  requireDecidedBy,
  requireFlag,
  hasFlag,
  parseDaysFlag,
  resolveScope,
} from './work-inventory-cli-shared.js';
import type { WorkInventoryCliOptions } from './work-inventory-cli-entries.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PROMOTION_KINDS = ['mission', 'pipeline'] as const;

export interface PromoteResult {
  plan: WorkInventoryPromotionPlan;
  executed: boolean;
  ref?: string;
  approval_request_id?: string;
  pipeline_command?: string;
}

export function runPromotePlan(
  entryId: string,
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): { plan: WorkInventoryPromotionPlan; entry: ReturnType<typeof loadWorkInventoryEntry> } {
  const kind = requireFlag(argv, '--kind', 'promote');
  if (!PROMOTION_KINDS.includes(kind as (typeof PROMOTION_KINDS)[number])) {
    throw new Error(`--kind must be one of: ${PROMOTION_KINDS.join(', ')}`);
  }
  const decidedBy = requireDecidedBy(argv);
  const scope = resolveScope(argv);
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir: options.rootDir });
  if (!entry) throw new Error(`work inventory entry not found: ${entryId}`);
  const plan = planWorkInventoryPromotion(entry, {
    kind: kind as (typeof PROMOTION_KINDS)[number],
    decided_by: decidedBy,
    now: options.now,
  });
  return { plan, entry };
}

export function runPromote(
  entryId: string,
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): PromoteResult {
  const { plan, entry } = runPromotePlan(entryId, argv, options);
  const execute = hasFlag(argv, '--execute');

  if (plan.kind === 'pipeline') {
    // Never executed by this CLI — an ADF promotion stays an operator step.
    return { plan, executed: false, pipeline_command: `${plan.command} ${plan.args.join(' ')}` };
  }

  if (!execute || !entry) return { plan, executed: false };

  const execResult = executeMissionPromotion(plan, { rootDir: options.rootDir });
  const applied = applyWorkInventoryPromotion(entry, plan, {
    ref: execResult.mission_id,
    now: options.now,
  });
  saveWorkInventoryEntry(applied, { rootDir: options.rootDir });
  return {
    plan,
    executed: true,
    ref: execResult.mission_id,
    ...(execResult.approval_request_id
      ? { approval_request_id: execResult.approval_request_id }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// learn
// ---------------------------------------------------------------------------

export interface LearnResult {
  dry_run: boolean;
  measured: number;
  calibrated_methods: string[];
  learning_signals: OperationalLearningSignal[];
  enqueued: string[];
}

function previewCalibratedMethods(
  calibration: WorkInventoryCalibration,
  samples: ReturnType<typeof buildCalibrationSamples>,
  now: Date
): string[] {
  if (samples.length === 0) return [];
  const next = calibrateFromOutcomes(calibration, samples, {
    now,
    reason: 'inventory learn --dry-run preview',
  });
  const changes = next.history[next.history.length - 1]?.changes ?? {};
  return Object.keys(changes)
    .map((key) => key.replace(/^method_automatable\./, ''))
    .sort();
}

export function runLearn(
  argv: string[],
  options: WorkInventoryCliOptions & { dryRun: boolean; now?: Date }
): LearnResult {
  const scope = resolveScope(argv);
  const rootDir = options.rootDir;
  const now = options.now ?? new Date();
  const days = parseDaysFlag(argv);
  const apiSystems = csv(argv, '--api-systems');
  const taxonomy = loadWorkInventoryTaxonomy();

  const signals = collectKyberionDemandSignals({
    rootDir,
    now,
    since: new Date(now.getTime() - days * MS_PER_DAY),
    until: now,
    ...(scope.tenant_slug ? { tenantSlug: scope.tenant_slug } : {}),
  });

  if (!options.dryRun) {
    const summary = runWorkInventoryLearningCycle({
      scope,
      signals,
      rootDir,
      now,
      taxonomy,
      ...(apiSystems.length > 0 ? { apiSystems } : {}),
    });
    return { dry_run: false, ...summary };
  }

  // Pure preview: measure + calibrate without saving anything.
  const entries = listWorkInventoryEntries(scope, { rootDir });
  let measured = 0;
  const previewed = entries.map((entry) => {
    if (entry.status !== 'promoted' || !entry.promotion) return entry;
    measured += 1;
    const outcome = measureWorkInventoryOutcome(entry, signals, { now, taxonomy });
    return recordWorkInventoryOutcome(entry, outcome);
  });
  const calibration = loadWorkInventoryCalibration(
    scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {},
    { rootDir }
  );
  const samples = buildCalibrationSamples(previewed, { taxonomy, calibration });
  const calibratedMethods = previewCalibratedMethods(calibration, samples, now);
  const learningSignals = detectWorkInventoryLearningSignals(previewed, {
    ...(scope.tenant_slug ? { tenantSlug: scope.tenant_slug } : {}),
    ...(apiSystems.length > 0 ? { apiSystems } : {}),
    taxonomy,
    calibration,
  });

  return {
    dry_run: true,
    measured,
    calibrated_methods: calibratedMethods,
    learning_signals: learningSignals,
    enqueued: [],
  };
}
