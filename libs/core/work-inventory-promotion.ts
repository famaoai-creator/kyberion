/**
 * WI-09: promote a work inventory candidate to a mission or a pipeline, measure
 * the realized outcome, calibrate scoring from it, and feed large gaps and
 * frequently overridden taxonomy rules to the organization learning queue —
 * docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md
 * §2.4 / §6 (WI-09).
 *
 * - Planning, applying, measuring, sampling, and signal detection are pure
 *   functions. Only `executeMissionPromotion`, `emitWorkInventoryLearningSignals`
 *   and `runWorkInventoryLearningCycle` touch disk or spawn processes.
 * - Promotion is a human decision only (`decided_by: {kind:'human', id:'user:<member>'}`,
 *   the same grammar `mission_controller --decided-by` enforces).
 * - The mission path mirrors the hearing hand-off
 *   (`presence/displays/presence-studio/hearing-mission-routes.ts`): the
 *   governed `mission_controller.js create` and `mission_alignment_request.js`
 *   run as built subprocesses (never imported), and the brief is written to
 *   `<mission>/evidence/mission-brief.json` under the `mission_controller`
 *   execution context, exactly as the hearing route does.
 * - The pipeline path only *plans* the `pnpm pipeline:promote` invocation; it
 *   never executes it (promotion of an ADF stays an operator step).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { slugify } from './foundation/text.js';
import { pathResolver, findMissionPath } from './path-resolver.js';
import { loadState } from './mission-state.js';
import { listApprovalRequests } from './approval-store.js';
import { withExecutionContext } from './authority.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import {
  enqueueOperationalLearningSignal,
  type OperationalLearningSignal,
} from './operational-learning.js';
import {
  classifyWorkStep,
  listWorkInventoryEntries,
  loadWorkInventoryTaxonomy,
  saveWorkInventoryEntry,
  validateWorkInventoryEntry,
  workInventoryScopeKey,
  type WorkInventoryEntry,
  type WorkInventoryOutcome,
  type WorkInventoryPromotion,
  type WorkInventoryScope,
  type WorkInventoryStep,
  type WorkInventoryTaxonomy,
  type WorkMethod,
  type WorkPromotionKind,
  type WorkObservationOrigin,
} from './work-inventory.js';
import { matchSignalsToEntries, type DemandSignal } from './work-inventory-harvest.js';
import {
  calibrateFromOutcomes,
  loadWorkInventoryCalibration,
  saveWorkInventoryCalibration,
  scoreWorkInventoryEntry,
  type WorkInventoryCalibration,
  type WorkInventoryCalibrationSample,
} from './work-inventory-scoring.js';

// ---------------------------------------------------------------------------
// Errors and shared grammar
// ---------------------------------------------------------------------------

export type WorkInventoryPromotionErrorCode =
  | 'INVALID_STATUS'
  | 'INVALID_DECIDED_BY'
  | 'NO_PIPELINE_SOURCE'
  | 'PLAN_MISMATCH'
  | 'NOT_PROMOTED'
  | 'INVALID_ENTRY'
  | 'INVALID_MISSION_ID'
  | 'MISSION_NOT_CREATED'
  | 'MISSION_ID_CONFLICT'
  | 'SCRIPT_NOT_BUILT';

export class WorkInventoryPromotionError extends Error {
  constructor(
    public readonly code: WorkInventoryPromotionErrorCode,
    message: string
  ) {
    super(`[WORK_INVENTORY_PROMOTION_${code}] ${message}`);
    this.name = 'WorkInventoryPromotionError';
  }
}

/** Same grammar as `scripts/lib/decided-by-args.ts` (`--decided-by user:<member-id>`). */
const DECIDED_BY_ID_PATTERN = /^user:[a-z][a-z0-9-]{1,30}$/;
/** Same grammar as `libs/core/mission-creation.ts` / `assertHearingMissionId`. */
const MISSION_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;
const MISSION_ID_PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,23}$/;
const MISSION_ID_MAX_LENGTH = 64;

const CONTROLLER_RELATIVE = 'dist/scripts/mission_controller.js';
const ALIGNMENT_REQUEST_RELATIVE = 'dist/scripts/mission_alignment_request.js';

const AUTOMATED_METHODS: WorkMethod[] = ['api', 'program', 'ai_reasoning', 'computer_operation'];
const RISK_EFFECTS = new Set(['money', 'irreversible', 'approval']);

const MISSION_SUCCESS_CRITERION =
  'The steps assigned to api/program/ai_reasoning/computer_operation run without human fallback; human steps stay human.';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type WorkInventoryDecidedBy = WorkInventoryPromotion['decided_by'];

/** Where a brief came from; lets an idempotent re-run prove the mission is this entry's. */
export interface WorkInventoryMissionBriefSource {
  kind: 'work_inventory';
  ref: string;
  tenantSlug?: string;
}

/** The subset of `mission-brief.schema.json` this module authors. */
export interface WorkInventoryMissionBrief {
  missionId: string;
  title: string;
  intent: string;
  tier: 'personal' | 'confidential';
  source: WorkInventoryMissionBriefSource;
  victoryConditions: string[];
  scope: { in: string[]; out?: string[] };
  flow: Array<{ step: string; title: string; detail: string; pipeline?: string }>;
  roles: Array<{ who: string; role: string }>;
  deliverables: string[];
  risks?: Array<{ risk: string; level: string; mitigation: string }>;
  openItems?: string[];
  estimate?: { effort: string };
}

export interface WorkInventoryMissionPromotionPlan {
  kind: 'mission';
  entry_id: string;
  decided_by: WorkInventoryDecidedBy;
  planned_at: string;
  mission_id: string;
  tier: 'personal' | 'confidential';
  tenant_slug?: string;
  brief: WorkInventoryMissionBrief;
  /** argv for `dist/scripts/mission_controller.js` (script path not included). */
  create_args: string[];
}

export interface WorkInventoryPipelinePromotionPlan {
  kind: 'pipeline';
  entry_id: string;
  decided_by: WorkInventoryDecidedBy;
  planned_at: string;
  /** Repository-relative ADF path handed to `--input`. */
  input: string;
  /** Slug handed to `--name` (becomes `pipelines/<name>.json`). */
  name: string;
  /** Where the source was found: a step binding or an on-demand trace observation. */
  source: { kind: 'step_binding'; step_id: string } | { kind: 'observation'; ref: string };
  /** Full invocation, for display or for the operator to run: `pnpm pipeline:promote ...`. */
  command: 'pnpm';
  args: string[];
}

export type WorkInventoryPromotionPlan =
  WorkInventoryMissionPromotionPlan | WorkInventoryPipelinePromotionPlan;

export interface PlanWorkInventoryPromotionOptions {
  kind: WorkPromotionKind;
  decided_by: WorkInventoryDecidedBy;
  now?: Date;
  /** Default `MSN-WI`. Must match `^[A-Z0-9][A-Z0-9_-]{1,23}$`. */
  missionIdPrefix?: string;
}

const missionBriefCatalog = defineCatalog<WorkInventoryMissionBrief>({
  id: 'work-inventory-mission-brief',
  // Never loaded from this path — `.validate()` only uses it to label a
  // schema-violation error. The brief is written to its mission evidence
  // path by `executeMissionPromotion`.
  path: 'work-inventory/mission-brief',
  schema: pathResolver.rootResolve('knowledge/product/schemas/mission-brief.schema.json'),
});

export function validateWorkInventoryMissionBrief(
  brief: WorkInventoryMissionBrief
): WorkInventoryMissionBrief {
  return missionBriefCatalog.validate(brief);
}

function assertPromotable(entry: WorkInventoryEntry, decidedBy: WorkInventoryDecidedBy): void {
  if (entry.status !== 'candidate' && entry.status !== 'confirmed') {
    throw new WorkInventoryPromotionError(
      'INVALID_STATUS',
      `entry ${entry.entry_id} is ${entry.status}; only candidate or confirmed entries can be promoted`
    );
  }
  if (decidedBy?.kind !== 'human' || !DECIDED_BY_ID_PATTERN.test(decidedBy.id ?? '')) {
    throw new WorkInventoryPromotionError(
      'INVALID_DECIDED_BY',
      `decided_by must be {kind:'human', id:'user:<member-id>'} (${DECIDED_BY_ID_PATTERN.source}) — promotion is a human decision`
    );
  }
}

/**
 * Deterministic mission id:
 * `<prefix>-<8 hex of sha256(scope key \n entry id)>-<entry id suffix>`,
 * upper-cased and constrained to the mission id grammar (the suffix — the
 * entry id without "WI-" — is truncated to fit 64 characters). The scope is
 * part of the hash, so the same entry id in two tenants (or a tenant and the
 * personal scope) never maps to the same mission.
 */
export function workInventoryMissionId(
  entryId: string,
  scope: WorkInventoryScope,
  prefix = 'MSN-WI'
): string {
  if (!MISSION_ID_PREFIX_PATTERN.test(prefix)) {
    throw new WorkInventoryPromotionError(
      'INVALID_MISSION_ID',
      `missionIdPrefix '${prefix}' must match ${MISSION_ID_PREFIX_PATTERN.source}`
    );
  }
  const digest = createHash('sha256')
    .update(`${workInventoryScopeKey(scope)}\n${entryId}`, 'utf8')
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  const room = MISSION_ID_MAX_LENGTH - prefix.length - digest.length - 2;
  const suffix = entryId
    .replace(/^WI-/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .slice(0, room)
    .replace(/^-+|-+$/g, '');
  const missionId = suffix ? `${prefix}-${digest}-${suffix}` : `${prefix}-${digest}`;
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new WorkInventoryPromotionError(
      'INVALID_MISSION_ID',
      `'${missionId}' must match ${MISSION_ID_PATTERN.source}`
    );
  }
  return missionId;
}

function describeStep(step: WorkInventoryStep): string {
  const binding = step.binding;
  const target = binding?.pipeline_id
    ? ` via pipeline ${binding.pipeline_id}`
    : binding?.actuator
      ? ` via ${binding.actuator}${binding.op ? `:${binding.op}` : ''}`
      : '';
  return `${step.step_id} [${step.stage}/${step.verb}] ${step.description} → ${step.method.assigned}${target}`;
}

function methodDetail(step: WorkInventoryStep): string {
  const rule = step.method.rule_id ? ` ${step.method.rule_id}` : '';
  return `method ${step.method.assigned} (${step.method.source}${rule}): ${step.method.rationale}`;
}

function frequencyLine(entry: WorkInventoryEntry): string | undefined {
  if (!entry.frequency) return undefined;
  return `Frequency: ${entry.frequency.count} per ${entry.frequency.per}`;
}

function buildMissionBrief(
  entry: WorkInventoryEntry,
  missionId: string,
  tier: 'personal' | 'confidential',
  decidedBy: WorkInventoryDecidedBy
): WorkInventoryMissionBrief {
  const automated = entry.steps.filter((step) => AUTOMATED_METHODS.includes(step.method.assigned));
  const human = entry.steps.filter((step) => step.method.assigned === 'human');
  const title = entry.title.length > 160 ? `${entry.title.slice(0, 157).trimEnd()}…` : entry.title;

  const observationLines = (entry.observations ?? []).map(
    (observation) =>
      `Observed (${observation.source}) ${observation.ref}${observation.digest ? `: ${observation.digest}` : ''}`
  );
  const intent = [
    `Automate work inventory entry ${entry.entry_id}: ${entry.title}`,
    `Trigger (${entry.trigger.kind}): ${entry.trigger.description}`,
    frequencyLine(entry),
    typeof entry.effort_minutes_per_run === 'number'
      ? `Effort: ${entry.effort_minutes_per_run} min per run`
      : undefined,
    ...observationLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  const risks = entry.steps.flatMap((step) =>
    step.effects
      .filter((effect) => RISK_EFFECTS.has(effect))
      .map((effect) => ({
        risk: `${step.step_id} has effect ${effect}`,
        level: 'high',
        mitigation: 'The step stays human and goes through an approval before it takes effect.',
      }))
  );

  const brief: WorkInventoryMissionBrief = {
    missionId,
    title,
    intent,
    tier,
    source: {
      kind: 'work_inventory',
      ref: entry.entry_id,
      ...(entry.scope.tenant_slug ? { tenantSlug: entry.scope.tenant_slug } : {}),
    },
    victoryConditions: [MISSION_SUCCESS_CRITERION],
    scope: {
      in: automated.length > 0 ? automated.map(describeStep) : [`Automate: ${entry.title}`],
      ...(human.length > 0
        ? { out: human.map((step) => `${describeStep(step)} (stays human)`) }
        : {}),
    },
    flow: entry.steps.map((step) => ({
      step: step.step_id,
      title: `${step.verb}: ${step.description}`,
      detail: methodDetail(step),
      ...(step.binding?.pipeline_id ? { pipeline: step.binding.pipeline_id } : {}),
    })),
    roles: [{ who: decidedBy.id, role: 'owner' }],
    deliverables: [
      `Automation for "${entry.title}" covering ${automated.length} of ${entry.steps.length} steps`,
      `Outcome measurement recorded on work inventory entry ${entry.entry_id}`,
    ],
    ...(risks.length > 0 ? { risks } : {}),
    ...(entry.steps.some((step) => step.requires_review)
      ? { openItems: ['Confirm the review-required steps with their owners before execution.'] }
      : {}),
    ...(typeof entry.effort_minutes_per_run === 'number'
      ? {
          estimate: {
            effort: `${entry.effort_minutes_per_run} min per run today${frequencyLine(entry) ? `; ${frequencyLine(entry)}` : ''}`,
          },
        }
      : {}),
  };
  return validateWorkInventoryMissionBrief(brief);
}

/**
 * Tier: a tenant-scoped entry lives in `knowledge/confidential/<tenant>/` and
 * becomes a `confidential` mission with `--tenant-slug` (mission creation
 * refuses confidential missions without a tenant); a personal entry becomes a
 * `personal` mission with no tenant, so personal work never lands in a tenant.
 */
function buildMissionCreateArgs(
  missionId: string,
  brief: WorkInventoryMissionBrief,
  tenantSlug: string | undefined,
  decidedBy: WorkInventoryDecidedBy
): string[] {
  return [
    'create',
    missionId,
    '--tier',
    brief.tier,
    ...(tenantSlug ? ['--tenant-slug', tenantSlug] : []),
    '--goal',
    brief.title,
    '--success-condition',
    MISSION_SUCCESS_CRITERION,
    '--decided-by',
    decidedBy.id,
  ];
}

function normalizePipelineRef(value: string): string {
  return value.trim();
}

function pipelineInputFromId(pipelineId: string): string {
  const trimmed = normalizePipelineRef(pipelineId);
  if (trimmed.endsWith('.json') || trimmed.includes('/')) return trimmed;
  return `pipelines/${trimmed}.json`;
}

/**
 * Observation refs that name a runnable ADF. Scheduled pipelines are system
 * cadence (already pipelines), so an observation whose origin is `scheduled`
 * never qualifies.
 */
function pipelineInputFromObservationRef(
  ref: string,
  origin: WorkObservationOrigin | undefined
): string | null {
  if (origin === 'scheduled') return null;
  if (ref.startsWith('adhoc_pipeline:')) {
    const value = ref.slice('adhoc_pipeline:'.length);
    return value ? pipelineInputFromId(value) : null;
  }
  if (ref.startsWith('pipeline:')) {
    const value = ref.slice('pipeline:'.length);
    return value ? pipelineInputFromId(value) : null;
  }
  return null;
}

function resolvePipelineSource(
  entry: WorkInventoryEntry
): Pick<WorkInventoryPipelinePromotionPlan, 'input' | 'source'> | null {
  for (const step of entry.steps) {
    if (step.binding?.pipeline_id) {
      return {
        input: pipelineInputFromId(step.binding.pipeline_id),
        source: { kind: 'step_binding', step_id: step.step_id },
      };
    }
  }
  for (const observation of entry.observations ?? []) {
    if (observation.source !== 'kyberion_trace') continue;
    const input = pipelineInputFromObservationRef(observation.ref, observation.origin);
    if (input) return { input, source: { kind: 'observation', ref: observation.ref } };
  }
  return null;
}

/**
 * Pure promotion plan. Throws `WorkInventoryPromotionError` unless the entry
 * is `candidate`/`confirmed` and `decided_by` is a human member.
 */
export function planWorkInventoryPromotion(
  entry: WorkInventoryEntry,
  options: PlanWorkInventoryPromotionOptions
): WorkInventoryPromotionPlan {
  assertPromotable(entry, options.decided_by);
  const decidedBy: WorkInventoryDecidedBy = { kind: 'human', id: options.decided_by.id };
  const plannedAt = nowIso(options.now ?? new Date());

  if (options.kind === 'mission') {
    const missionId = workInventoryMissionId(entry.entry_id, entry.scope, options.missionIdPrefix);
    const tenantSlug = entry.scope.tenant_slug;
    const tier: 'personal' | 'confidential' = tenantSlug ? 'confidential' : 'personal';
    const brief = buildMissionBrief(entry, missionId, tier, decidedBy);
    return {
      kind: 'mission',
      entry_id: entry.entry_id,
      decided_by: decidedBy,
      planned_at: plannedAt,
      mission_id: missionId,
      tier,
      ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
      brief,
      create_args: buildMissionCreateArgs(missionId, brief, tenantSlug, decidedBy),
    };
  }

  const source = resolvePipelineSource(entry);
  if (!source) {
    throw new WorkInventoryPromotionError(
      'NO_PIPELINE_SOURCE',
      `entry ${entry.entry_id} has no step bound to a pipeline_id and no on-demand kyberion_trace pipeline observation`
    );
  }
  const name = slugify(entry.title, { maxLength: 48 }) || entry.entry_id.toLowerCase();
  return {
    kind: 'pipeline',
    entry_id: entry.entry_id,
    decided_by: decidedBy,
    planned_at: plannedAt,
    input: source.input,
    name,
    source: source.source,
    command: 'pnpm',
    args: ['pipeline:promote', '--input', source.input, '--name', name],
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function assertValidEntry(entry: WorkInventoryEntry): WorkInventoryEntry {
  const check = validateWorkInventoryEntry(entry);
  if (!check.valid) {
    throw new WorkInventoryPromotionError(
      'INVALID_ENTRY',
      `entry ${entry.entry_id} failed validation: ${check.errors.join('; ')}`
    );
  }
  return entry;
}

/** Returns a new, validated entry marked `promoted` with the plan's decision and `ref`. */
export function applyWorkInventoryPromotion(
  entry: WorkInventoryEntry,
  plan: WorkInventoryPromotionPlan,
  options: { ref: string; now?: Date }
): WorkInventoryEntry {
  if (plan.entry_id !== entry.entry_id) {
    throw new WorkInventoryPromotionError(
      'PLAN_MISMATCH',
      `plan is for ${plan.entry_id}, not ${entry.entry_id}`
    );
  }
  assertPromotable(entry, plan.decided_by);
  const at = nowIso(options.now ?? new Date());
  return assertValidEntry({
    ...entry,
    status: 'promoted',
    promotion: {
      kind: plan.kind,
      ref: options.ref,
      promoted_at: at,
      decided_by: { kind: 'human', id: plan.decided_by.id },
    },
    updated_at: at,
  });
}

// ---------------------------------------------------------------------------
// Execute (mission)
// ---------------------------------------------------------------------------

export interface WorkInventoryExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export type WorkInventoryPromotionExec = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputMB: number }
) => WorkInventoryExecResult;

export interface ExecuteMissionPromotionOptions {
  rootDir?: string;
  /** Injectable for tests; defaults to `safeExecResult` after checking the script is built. */
  exec?: WorkInventoryPromotionExec;
}

export interface ExecuteMissionPromotionResult {
  mission_id: string;
  approval_request_id?: string;
  /** `false` when the mission already existed and `create` was skipped. */
  created: boolean;
}

function assertGovernedScriptBuilt(rootDir: string, relative: string): void {
  let ready = false;
  try {
    const safePath = assertSafeRepositoryPath(path.join(rootDir, relative), {
      allowMissingLeaf: true,
      rootDir,
    });
    ready = safeExistsSync(safePath) && safeLstat(safePath).isFile();
  } catch {
    ready = false;
  }
  if (!ready) {
    throw new WorkInventoryPromotionError('SCRIPT_NOT_BUILT', `${relative} is not built`);
  }
}

function resolveAlignmentRequestId(
  missionId: string,
  result: WorkInventoryExecResult
): string | undefined {
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { requestId?: string; reason?: string };
      if (parsed.requestId && !parsed.reason) return parsed.requestId;
    } catch {
      // Non-JSON stdout — fall through to the approval-store lookup.
    }
  }
  const correlationId = `mission-alignment-${missionId}`;
  return listApprovalRequests({ status: 'pending', kind: 'mission_gate' }).find(
    (item) => item.correlationId === correlationId
  )?.id;
}

function readStoredBrief(briefPath: string): unknown {
  try {
    return parseSafeJsonInput(
      String(safeReadFile(briefPath, { encoding: 'utf8' })),
      'existing mission brief'
    );
  } catch {
    return undefined;
  }
}

/**
 * An existing mission is this plan's only when its stored brief names the
 * same work inventory entry, tier, and tenant. Anything else (another
 * entry, another scope, a hand-written brief) is a `MISSION_ID_CONFLICT`.
 */
function assertExistingMissionBelongsToPlan(
  plan: WorkInventoryMissionPromotionPlan,
  stored: unknown
): void {
  const record =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : undefined;
  const source =
    record && typeof record.source === 'object' && record.source !== null
      ? (record.source as Record<string, unknown>)
      : undefined;
  const matches =
    source?.kind === 'work_inventory' &&
    source.ref === plan.entry_id &&
    record?.tier === plan.tier &&
    (source.tenantSlug ?? undefined) === plan.tenant_slug;
  if (!matches) {
    throw new WorkInventoryPromotionError(
      'MISSION_ID_CONFLICT',
      `mission ${plan.mission_id} already exists but its brief is not for work inventory entry ${plan.entry_id} (${plan.tier}${plan.tenant_slug ? `, tenant ${plan.tenant_slug}` : ''})`
    );
  }
}

/**
 * Runs the governed mission hand-off for a mission plan, mirroring
 * `hearing-mission-routes.ts`: `mission_controller.js create` (subprocess,
 * `MISSION_ROLE=mission_controller`), verify the mission landed `planned`,
 * write `evidence/mission-brief.json` under the `mission_controller`
 * execution context (a governed mission write the caller's own role may not
 * hold), then `mission_alignment_request.js --mission <id> --json`.
 *
 * Idempotent: an existing mission skips `create` and keeps an existing brief
 * (rewriting it would invalidate an alignment approval bound to its hash);
 * the alignment CLI reuses a pending request for the same brief. An existing
 * mission must carry a brief whose `source` is this entry in this tier/tenant —
 * otherwise `MISSION_ID_CONFLICT` (never adopt another scope's mission).
 */
export function executeMissionPromotion(
  plan: WorkInventoryPromotionPlan,
  options: ExecuteMissionPromotionOptions = {}
): ExecuteMissionPromotionResult {
  if (plan.kind !== 'mission') {
    throw new WorkInventoryPromotionError(
      'PLAN_MISMATCH',
      'executeMissionPromotion only runs mission plans; pipeline plans are handed to pnpm pipeline:promote by the operator'
    );
  }
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const exec: WorkInventoryPromotionExec =
    options.exec ??
    ((command, args, execOptions) => {
      assertGovernedScriptBuilt(rootDir, args[0]);
      return safeExecResult(command, args, execOptions);
    });
  const missionId = plan.mission_id;

  let missionDir = findMissionPath(missionId);
  const created = !missionDir;
  if (!missionDir) {
    const createResult = exec(process.execPath, [CONTROLLER_RELATIVE, ...plan.create_args], {
      env: { ...process.env, MISSION_ROLE: 'mission_controller' },
      cwd: rootDir,
      timeoutMs: 60_000,
      maxOutputMB: 5,
    });
    missionDir = findMissionPath(missionId);
    const state = missionDir ? loadState(missionId) : null;
    // Exit code 0 alone is not success: the mission must exist in `planned`.
    if (createResult.status !== 0 || !missionDir || state?.status !== 'planned') {
      throw new WorkInventoryPromotionError(
        'MISSION_NOT_CREATED',
        `mission ${missionId} was not created (exit ${String(createResult.status)})`
      );
    }
  }

  const dir = missionDir;
  if (!created) {
    const briefPath = assertSafeRepositoryPath(path.join(dir, 'evidence', 'mission-brief.json'), {
      allowMissingLeaf: true,
      rootDir,
    });
    const stored = withExecutionContext('mission_controller', () =>
      safeExistsSync(briefPath) ? readStoredBrief(briefPath) : undefined
    );
    assertExistingMissionBelongsToPlan(plan, stored);
  }
  withExecutionContext('mission_controller', () => {
    const evidenceDir = assertSafeRepositoryPath(path.join(dir, 'evidence'), {
      allowMissingLeaf: true,
      rootDir,
    });
    if (!safeExistsSync(evidenceDir)) safeMkdir(evidenceDir, { recursive: true });
    const briefPath = assertSafeRepositoryPath(path.join(dir, 'evidence', 'mission-brief.json'), {
      allowMissingLeaf: true,
      rootDir,
    });
    if (!safeExistsSync(briefPath)) {
      safeWriteFile(briefPath, `${JSON.stringify(plan.brief, null, 2)}\n`, { encoding: 'utf8' });
    }
  });

  const alignmentResult = exec(
    process.execPath,
    [ALIGNMENT_REQUEST_RELATIVE, '--mission', missionId, '--json'],
    { env: { ...process.env }, cwd: rootDir, timeoutMs: 30_000, maxOutputMB: 5 }
  );
  const approvalRequestId = resolveAlignmentRequestId(missionId, alignmentResult);
  return {
    mission_id: missionId,
    created,
    ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface MeasureWorkInventoryOutcomeOptions {
  now?: Date;
  taxonomy?: WorkInventoryTaxonomy;
}

function assertPromoted(
  entry: WorkInventoryEntry
): asserts entry is WorkInventoryEntry & { promotion: WorkInventoryPromotion } {
  if (entry.status !== 'promoted' || !entry.promotion) {
    throw new WorkInventoryPromotionError(
      'NOT_PROMOTED',
      `entry ${entry.entry_id} is not promoted; outcomes are measured only for promoted entries`
    );
  }
}

function promotionSignatures(promotion: WorkInventoryPromotion): string[] {
  if (promotion.kind !== 'pipeline') return [];
  const ref = promotion.ref.trim();
  const base = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  return [`pipeline:${base.replace(/\.json$/i, '')}`];
}

/**
 * Signal kinds that are lifetime tallies rather than windowed runs (the
 * ad-hoc ledger count, the unhandled-intent occurrence count). They cannot be
 * split at `promoted_at`, so they never count toward an outcome.
 */
const LIFETIME_SIGNAL_KINDS: ReadonlySet<DemandSignal['kind']> = new Set([
  'adhoc_pipeline',
  'unhandled_intent',
]);

/** Default look-back for outcome measurement (days). */
export const DEFAULT_OUTCOME_WINDOW_DAYS = 28;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Collects demand signals over `[since, now)`. Injected so outcomes are always
 * measured over a per-entry window that starts at the promotion.
 */
export type WorkInventoryCollectSignals = (since: Date) => DemandSignal[];

/** `max(promoted_at, now − windowDays)`: outcomes only ever count post-promotion runs. */
export function outcomeWindowSince(
  entry: WorkInventoryEntry,
  now: Date,
  windowDays: number = DEFAULT_OUTCOME_WINDOW_DAYS
): Date {
  assertPromoted(entry);
  const windowStart = now.getTime() - windowDays * MS_PER_DAY;
  const promotedAt = Date.parse(entry.promotion.promoted_at);
  return new Date(Number.isFinite(promotedAt) ? Math.max(promotedAt, windowStart) : windowStart);
}

/**
 * Demand signals attributable to a promoted entry (promotion ref + explicit
 * bindings + trace observations), limited to windowed kinds whose first run
 * is at/after `promoted_at` — a signal that starts before the promotion mixes
 * pre-promotion runs in and is dropped; collect it with `outcomeWindowSince`.
 */
export function signalsForPromotedEntry(
  entry: WorkInventoryEntry,
  signals: DemandSignal[]
): DemandSignal[] {
  assertPromoted(entry);
  const wanted = new Set(promotionSignatures(entry.promotion));
  for (const signal of matchSignalsToEntries([entry], signals).get(entry.entry_id) ?? []) {
    wanted.add(signal.signature);
  }
  const promotedAt = Date.parse(entry.promotion.promoted_at);
  return signals.filter((signal) => {
    if (!wanted.has(signal.signature) || LIFETIME_SIGNAL_KINDS.has(signal.kind)) return false;
    const firstAt = Date.parse(signal.first_at);
    return Number.isFinite(promotedAt) && Number.isFinite(firstAt) && firstAt >= promotedAt;
  });
}

/** Signals for one promoted entry, collected over `outcomeWindowSince`. */
export function collectSignalsForPromotedEntry(
  entry: WorkInventoryEntry,
  collectSignals: WorkInventoryCollectSignals,
  options: { now: Date; windowDays?: number }
): DemandSignal[] {
  return signalsForPromotedEntry(
    entry,
    collectSignals(outcomeWindowSince(entry, options.now, options.windowDays))
  );
}

/** 0..1 share of runs that completed without failure; 0 when nothing ran. */
export function outcomeSuccessRate(
  outcome: Pick<WorkInventoryOutcome, 'runs' | 'failures'>
): number {
  if (outcome.runs <= 0) return 0;
  return Math.max(0, 1 - outcome.failures / outcome.runs);
}

/**
 * Pure: an `outcomes[]` item for a promoted entry, from `signals` collected
 * with `since = outcomeWindowSince(entry, now)` (see `signalsForPromotedEntry`
 * for which signals count).
 * `minutes_saved_estimate = runs × effort_minutes_per_run × (runs>0 ? 1 − failures/runs : 0)`,
 * where effort is the self-reported value, else the observed median (same
 * resolution as scoring).
 */
export function measureWorkInventoryOutcome(
  entry: WorkInventoryEntry,
  signals: DemandSignal[],
  options: MeasureWorkInventoryOutcomeOptions = {}
): WorkInventoryOutcome {
  const matched = signalsForPromotedEntry(entry, signals);
  const runs = matched.reduce((sum, signal) => sum + signal.count, 0);
  const failures = Math.min(
    runs,
    matched.reduce((sum, signal) => sum + signal.failure_count, 0)
  );
  const effort =
    typeof entry.effort_minutes_per_run === 'number'
      ? entry.effort_minutes_per_run
      : scoreWorkInventoryEntry(entry, { taxonomy: options.taxonomy }).components.effort_minutes;
  const realized = outcomeSuccessRate({ runs, failures });
  return {
    measured_at: nowIso(options.now ?? new Date()),
    runs,
    minutes_saved_estimate: round2(runs * effort * realized),
    failures,
    source: 'kyberion_trace',
  };
}

/** Appends an outcome (replacing one with the same `measured_at`) and validates. */
export function recordWorkInventoryOutcome(
  entry: WorkInventoryEntry,
  outcome: WorkInventoryOutcome
): WorkInventoryEntry {
  assertPromoted(entry);
  const outcomes = [
    ...(entry.outcomes ?? []).filter((item) => item.measured_at !== outcome.measured_at),
    outcome,
  ].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  return assertValidEntry({ ...entry, outcomes });
}

function latestOutcome(entry: WorkInventoryEntry): WorkInventoryOutcome | undefined {
  const outcomes = [...(entry.outcomes ?? [])].sort((a, b) =>
    a.measured_at.localeCompare(b.measured_at)
  );
  return outcomes[outcomes.length - 1];
}

// ---------------------------------------------------------------------------
// Learning: calibration samples and learning signals
// ---------------------------------------------------------------------------

export interface BuildCalibrationSamplesOptions {
  taxonomy?: WorkInventoryTaxonomy;
  calibration?: WorkInventoryCalibration;
}

/**
 * Pure: calibration samples from promoted entries with ≥1 outcome. Skips
 * human-only entries (nothing to calibrate) and entries whose latest outcome
 * has zero runs (no evidence is not the same as a failure).
 *
 * `realized_automatable_ratio = predicted × success_rate`: both sides measure
 * the same quantity (the automatable share of the work), so realized /
 * predicted is the success rate and a mixed human/automated entry whose runs
 * never fail realizes exactly what was predicted.
 */
export function buildCalibrationSamples(
  entries: WorkInventoryEntry[],
  options: BuildCalibrationSamplesOptions = {}
): WorkInventoryCalibrationSample[] {
  const taxonomy = options.taxonomy ?? loadWorkInventoryTaxonomy();
  const samples: WorkInventoryCalibrationSample[] = [];
  for (const entry of entries) {
    if (entry.status !== 'promoted' || entry.steps.length === 0) continue;
    const outcome = latestOutcome(entry);
    if (!outcome || outcome.runs <= 0) continue;
    if (entry.steps.every((step) => step.method.assigned === 'human')) continue;

    const counts = new Map<WorkMethod, number>();
    for (const step of entry.steps) {
      counts.set(step.method.assigned, (counts.get(step.method.assigned) ?? 0) + 1);
    }
    const methodMix: Partial<Record<WorkMethod, number>> = {};
    for (const [method, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      methodMix[method] = round4(count / entry.steps.length);
    }
    const predicted = scoreWorkInventoryEntry(entry, {
      taxonomy,
      calibration: options.calibration,
    }).components.automatable_ratio;
    samples.push({
      entry_id: entry.entry_id,
      method_mix: methodMix,
      predicted_automatable_ratio: predicted,
      realized_automatable_ratio: round4(predicted * outcomeSuccessRate(outcome)),
    });
  }
  return samples.sort((a, b) => a.entry_id.localeCompare(b.entry_id));
}

export interface DetectWorkInventoryLearningSignalsOptions {
  /** When set, only entries of this tenant are considered and signals are confidential to it. */
  tenantSlug?: string;
  /** |predicted − realized| above this is a gap signal. Default 0.25. */
  gapThreshold?: number;
  /** Overrides of one rule at or above this count are a pattern signal. Default 3. */
  overrideThreshold?: number;
  /** Systems with an API integration, for re-deriving the rule a step would get. */
  apiSystems?: string[];
  taxonomy?: WorkInventoryTaxonomy;
  calibration?: WorkInventoryCalibration;
}

/**
 * Source types (the closed `OrganizationLearningSourceType` set):
 * - a prediction gap is a recurring routine that did not behave as expected →
 *   `routine_exception`;
 * - a frequently overridden rule is humans repeatedly deciding against a
 *   governed catalog rule → `governance_decision`.
 */
const GAP_SOURCE_TYPE: OperationalLearningSignal['sourceType'] = 'routine_exception';
const OVERRIDE_SOURCE_TYPE: OperationalLearningSignal['sourceType'] = 'governance_decision';

function scopeKey(tenantSlug: string | undefined): string {
  return tenantSlug ?? '';
}

function tierFields(
  tenantSlug: string | undefined
): Pick<OperationalLearningSignal, 'tier' | 'tenantSlug'> {
  return tenantSlug ? { tier: 'confidential', tenantSlug } : { tier: 'personal' };
}

/**
 * Pure: learning signals for (a) promoted entries whose realized ratio
 * (`predicted × success_rate`, see `buildCalibrationSamples`) falls short of
 * the predicted automatable ratio by more than `gapThreshold`,
 * and (b) taxonomy rules that humans overrode at least `overrideThreshold`
 * times. The overridden rule is re-derived with `classifyWorkStep` (a
 * `human_override` step no longer records it). Overrides are counted per
 * tenant/personal scope so one scope's signal never carries another's entries.
 */
export function detectWorkInventoryLearningSignals(
  entries: WorkInventoryEntry[],
  options: DetectWorkInventoryLearningSignalsOptions = {}
): OperationalLearningSignal[] {
  const taxonomy = options.taxonomy ?? loadWorkInventoryTaxonomy();
  const gapThreshold = options.gapThreshold ?? 0.25;
  const overrideThreshold = options.overrideThreshold ?? 3;
  const apiSystems = new Set((options.apiSystems ?? []).map((system) => system.toLowerCase()));
  const scoped = entries.filter(
    (entry) => options.tenantSlug === undefined || entry.scope.tenant_slug === options.tenantSlug
  );
  const signals: OperationalLearningSignal[] = [];

  const samples = new Map(
    buildCalibrationSamples(scoped, { taxonomy, calibration: options.calibration }).map(
      (sample) => [sample.entry_id, sample] as const
    )
  );
  for (const entry of scoped) {
    const sample = samples.get(entry.entry_id);
    if (!sample) continue;
    const gap = round4(sample.realized_automatable_ratio - sample.predicted_automatable_ratio);
    if (Math.abs(gap) <= gapThreshold) continue;
    signals.push({
      signalId: `work-inventory-gap-${entry.entry_id}`,
      sourceType: GAP_SOURCE_TYPE,
      sourceRef: `work-inventory:${entry.entry_id}`,
      title: `Automation of "${entry.title}" diverged from its prediction`,
      summary: `Predicted automatable ratio ${sample.predicted_automatable_ratio}, realized ${sample.realized_automatable_ratio} (gap ${gap}, threshold ${gapThreshold}).`,
      evidenceRefs: entry.promotion ? [entry.promotion.ref] : [],
      targetKind: 'knowledge_hint',
      ...tierFields(entry.scope.tenant_slug),
      metadata: {
        entry_id: entry.entry_id,
        predicted: sample.predicted_automatable_ratio,
        realized: sample.realized_automatable_ratio,
        gap,
      },
    });
  }

  interface OverrideTally {
    tenantSlug?: string;
    ruleId: string;
    ruleAssign: WorkMethod;
    count: number;
    overriddenTo: Partial<Record<WorkMethod, number>>;
    entryIds: Set<string>;
  }
  const tallies = new Map<string, OverrideTally>();
  for (const entry of scoped) {
    for (const step of entry.steps) {
      if (step.method.source !== 'human_override') continue;
      const systemHasApi = Boolean(step.system && apiSystems.has(step.system.toLowerCase()));
      const rule = classifyWorkStep(step, { system_has_api: systemHasApi }, taxonomy);
      if (rule.method === step.method.assigned) continue; // override agreed with the rule
      const key = `${scopeKey(entry.scope.tenant_slug)}\u0000${rule.rule_id}`;
      let tally = tallies.get(key);
      if (!tally) {
        tally = {
          ...(entry.scope.tenant_slug ? { tenantSlug: entry.scope.tenant_slug } : {}),
          ruleId: rule.rule_id,
          ruleAssign: rule.method,
          count: 0,
          overriddenTo: {},
          entryIds: new Set(),
        };
        tallies.set(key, tally);
      }
      tally.count += 1;
      tally.overriddenTo[step.method.assigned] =
        (tally.overriddenTo[step.method.assigned] ?? 0) + 1;
      tally.entryIds.add(entry.entry_id);
    }
  }
  for (const tally of [...tallies.values()].sort(
    (a, b) =>
      scopeKey(a.tenantSlug).localeCompare(scopeKey(b.tenantSlug)) ||
      a.ruleId.localeCompare(b.ruleId)
  )) {
    if (tally.count < overrideThreshold) continue;
    const entryIds = [...tally.entryIds].sort();
    signals.push({
      signalId: `work-inventory-rule-override-${tally.ruleId}`,
      sourceType: OVERRIDE_SOURCE_TYPE,
      sourceRef: `work-inventory-taxonomy:${tally.ruleId}`,
      title: `Classification rule ${tally.ruleId} is often overridden`,
      summary: `Rule ${tally.ruleId} assigns ${tally.ruleAssign}, but people overrode it ${tally.count} times across ${entryIds.length} entries (threshold ${overrideThreshold}).`,
      evidenceRefs: entryIds.map((id) => `work-inventory:${id}`),
      targetKind: 'pattern',
      ...tierFields(tally.tenantSlug),
      metadata: {
        rule_id: tally.ruleId,
        rule_assign: tally.ruleAssign,
        override_count: tally.count,
        overridden_to: tally.overriddenTo,
        entry_ids: entryIds,
      },
    });
  }
  return signals;
}

export interface EmitWorkInventoryLearningSignalsOptions {
  now?: Date;
  rootDir?: string;
}

/** Enqueues each signal as a proposed organization learning candidate; returns the enqueued ids. */
export function emitWorkInventoryLearningSignals(
  signals: OperationalLearningSignal[],
  options: EmitWorkInventoryLearningSignalsOptions = {}
): string[] {
  const enqueued: string[] = [];
  for (const signal of signals) {
    const id = enqueueOperationalLearningSignal(
      { ...signal, ...tierFields(signal.tenantSlug) },
      options
    );
    if (id) enqueued.push(id);
  }
  return enqueued;
}

// ---------------------------------------------------------------------------
// Learning cycle
// ---------------------------------------------------------------------------

export interface RunWorkInventoryLearningCycleOptions {
  scope: WorkInventoryScope;
  /** Called once per promoted entry with `since = outcomeWindowSince(entry, now, windowDays)`. */
  collectSignals: WorkInventoryCollectSignals;
  /** Outcome look-back in days (capped below by each entry's `promoted_at`). Default 28. */
  windowDays?: number;
  rootDir?: string;
  now?: Date;
  taxonomy?: WorkInventoryTaxonomy;
  gapThreshold?: number;
  overrideThreshold?: number;
  apiSystems?: string[];
}

export interface WorkInventoryLearningCycleSummary {
  /** Promoted entries that received a new outcome. */
  measured: number;
  /** Methods whose `method_automatable` moved (e.g. `api`). */
  calibrated_methods: string[];
  learning_signals: OperationalLearningSignal[];
  /** Learning candidate ids actually enqueued. */
  enqueued: string[];
}

/**
 * load entries → measure + record outcomes for promoted entries → save →
 * calibrate from samples (saved with reason `learning-cycle <date>`) →
 * detect + emit learning signals.
 */
export function runWorkInventoryLearningCycle(
  options: RunWorkInventoryLearningCycleOptions
): WorkInventoryLearningCycleSummary {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const now = options.now ?? new Date();
  const taxonomy = options.taxonomy ?? loadWorkInventoryTaxonomy();
  const tenantSlug = options.scope.tenant_slug;

  let measured = 0;
  const entries = listWorkInventoryEntries(options.scope, { rootDir }).map((entry) => {
    if (entry.status !== 'promoted' || !entry.promotion) return entry;
    const signals = collectSignalsForPromotedEntry(entry, options.collectSignals, {
      now,
      windowDays: options.windowDays,
    });
    const outcome = measureWorkInventoryOutcome(entry, signals, { now, taxonomy });
    measured += 1;
    return saveWorkInventoryEntry(recordWorkInventoryOutcome(entry, outcome), { rootDir });
  });

  const calibration = loadWorkInventoryCalibration(tenantSlug ? { tenant_slug: tenantSlug } : {}, {
    rootDir,
  });
  const samples = buildCalibrationSamples(entries, { taxonomy, calibration });
  let calibratedMethods: string[] = [];
  if (samples.length > 0) {
    const next = calibrateFromOutcomes(calibration, samples, {
      now,
      reason: `learning-cycle ${now.toISOString().slice(0, 10)}`,
    });
    saveWorkInventoryCalibration(next, { rootDir });
    const changes = next.history[next.history.length - 1]?.changes ?? {};
    calibratedMethods = Object.keys(changes)
      .map((key) => key.replace(/^method_automatable\./, ''))
      .sort();
  }

  // Detect against the pre-calibration weights: the gap is between what was
  // predicted when the entry was ranked and what happened.
  const learningSignals = detectWorkInventoryLearningSignals(entries, {
    ...(tenantSlug ? { tenantSlug } : {}),
    gapThreshold: options.gapThreshold,
    overrideThreshold: options.overrideThreshold,
    apiSystems: options.apiSystems,
    taxonomy,
    calibration,
  });
  const enqueued = emitWorkInventoryLearningSignals(learningSignals, { now, rootDir });
  return {
    measured,
    calibrated_methods: calibratedMethods,
    learning_signals: learningSignals,
    enqueued,
  };
}
