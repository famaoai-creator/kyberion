/**
 * WI-02: work inventory record type, governed taxonomy catalog, declarative
 * method classification, and tenant/personal-scoped storage.
 *
 * The taxonomy (`work-inventory-taxonomy.json`) is the single source of
 * truth for stages, verbs, methods, effects, and the ordered rule table that
 * decides `method.assigned` for a step. An LLM may *propose* a decomposition
 * (WI-04) but never decides the method directly — `classifyWorkStep` /
 * `applyClassification` always re-derive it from the rules, per
 * docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md §2.2.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { defineCatalog } from './foundation/governed-catalog.js';
import { compileSchema } from './foundation/ajv.js';
import { nowIso } from './foundation/time.js';
import { slugify } from './foundation/text.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { isValidTenantSlug } from './entity-scope.js';
import { resolveKnowledgeScopeSet } from './knowledge-scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkStage =
  'trigger' | 'gather' | 'understand' | 'decide' | 'act' | 'verify' | 'record';

export type WorkVerb =
  | 'receive'
  | 'search'
  | 'read'
  | 'input'
  | 'transform'
  | 'judge'
  | 'create'
  | 'operate'
  | 'communicate'
  | 'manage'
  | 'record'
  | 'coordinate';

export type WorkMethod = 'api' | 'computer_operation' | 'ai_reasoning' | 'program' | 'human';

export type WorkEffect = 'external_send' | 'money' | 'personal_data' | 'irreversible' | 'approval';

export type WorkObservationSource =
  'self_report' | 'kyberion_trace' | 'desktop_recording' | 'browser_recording';

export type WorkDataSensitivity = 'public' | 'internal' | 'confidential' | 'personal';

export type WorkEntryStatus = 'draft' | 'confirmed' | 'candidate' | 'promoted' | 'retired';

export type WorkMethodSource = 'rule' | 'proposal' | 'human_override';

export type WorkTriggerKind = 'schedule' | 'event' | 'request' | 'ad_hoc';

export type WorkFrequencyPer = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type WorkPromotionKind = 'mission' | 'pipeline';

export interface WorkInventoryStepMethod {
  assigned: WorkMethod;
  source: WorkMethodSource;
  rule_id?: string;
  rationale: string;
}

export interface WorkInventoryStepBinding {
  actuator?: string;
  op?: string;
  pipeline_id?: string;
  intent_id?: string;
  /**
   * `true` when `actuator`/`op` were filled from the verb's first taxonomy
   * candidate rather than declared by a person or a demand signal. Inferred
   * bindings are display / promotion hints only — demand-signal matching
   * never uses them (a generic `browser-actuator:computer_interaction` run is
   * not evidence of any particular entry).
   */
  inferred?: boolean;
}

export interface WorkInventoryStep {
  step_id: string;
  stage: WorkStage;
  verb: WorkVerb;
  description: string;
  system?: string;
  data_sensitivity: WorkDataSensitivity;
  effects: WorkEffect[];
  method: WorkInventoryStepMethod;
  binding?: WorkInventoryStepBinding;
  requires_review?: boolean;
}

export interface WorkInventoryScope {
  tenant_slug?: string;
  organization_id?: string;
  owner_member_id?: string;
}

export interface WorkInventoryTrigger {
  kind: WorkTriggerKind;
  description: string;
}

export interface WorkInventoryFrequency {
  per: WorkFrequencyPer;
  count: number;
}

/** Aggregate numbers only (never content): how often and how long the observed work ran. */
export interface WorkObservationMetrics {
  count?: number;
  per_week?: number;
  median_duration_ms?: number;
  failure_count?: number;
  window_days?: number;
}

export type WorkObservationOrigin = 'scheduled' | 'on_demand' | 'unknown';

export interface WorkInventoryObservation {
  source: WorkObservationSource;
  ref: string;
  observed_at: string;
  digest?: string;
  metrics?: WorkObservationMetrics;
  /** Who started the observed runs (kyberion_trace): a declared schedule, on demand, or unknown. */
  origin?: WorkObservationOrigin;
}

export interface WorkInventoryPromotion {
  kind: WorkPromotionKind;
  ref: string;
  promoted_at: string;
  decided_by: { kind: 'human'; id: string };
}

export interface WorkInventoryOutcome {
  measured_at: string;
  runs: number;
  minutes_saved_estimate: number;
  failures: number;
  source: string;
}

export interface WorkInventoryEntry {
  schema_version: 'work-inventory.v1';
  entry_id: string;
  title: string;
  scope: WorkInventoryScope;
  trigger: WorkInventoryTrigger;
  frequency?: WorkInventoryFrequency;
  effort_minutes_per_run?: number;
  actors?: string[];
  systems?: string[];
  steps: WorkInventoryStep[];
  observations?: WorkInventoryObservation[];
  status: WorkEntryStatus;
  promotion?: WorkInventoryPromotion;
  outcomes?: WorkInventoryOutcome[];
  created_at: string;
  updated_at: string;
}

export interface WorkInventoryStageDef {
  id: WorkStage;
  description: string;
}

export interface WorkInventoryCandidateBinding {
  actuator: string;
  op?: string;
}

export interface WorkInventoryVerbDef {
  id: WorkVerb;
  description: string;
  default_stage: WorkStage;
  candidate_bindings: WorkInventoryCandidateBinding[];
  /** WI-04: free-text keyword lists the heuristic decomposer matches against a fragment. */
  keywords?: { ja?: string[]; en?: string[] };
}

export interface WorkInventoryMethodDef {
  id: WorkMethod;
  description: string;
}

export interface WorkInventoryEffectDef {
  id: WorkEffect;
  description: string;
  /** Free-text keywords the heuristic decomposer (WI-04) uses to detect this effect. */
  keywords?: { ja?: string[]; en?: string[] };
  /** Detect the effect only on steps with one of these verbs. */
  only_with_verbs?: WorkVerb[];
}

export interface WorkInventoryRuleWhen {
  effects_any?: WorkEffect[];
  verbs?: WorkVerb[];
  stages?: WorkStage[];
  system_has_api?: boolean;
  data_sensitivity_any?: WorkDataSensitivity[];
}

export interface WorkInventoryRule {
  rule_id: string;
  when: WorkInventoryRuleWhen;
  assign: WorkMethod;
  rationale: string;
}

export interface WorkInventoryScoringWeights {
  frequency: number;
  effort: number;
  automatable_ratio: number;
  confidence: number;
  risk_penalty: number;
}

export interface WorkInventoryScoringDefaults {
  weights: WorkInventoryScoringWeights;
  risk_effect_penalty: Record<
    'money' | 'irreversible' | 'approval' | 'external_send' | 'personal_data',
    number
  >;
  method_automatable: Record<WorkMethod, number>;
  observation_source_confidence: Record<WorkObservationSource, number>;
}

export interface WorkInventoryTaxonomy {
  version: string;
  stages: WorkInventoryStageDef[];
  verbs: WorkInventoryVerbDef[];
  methods: WorkInventoryMethodDef[];
  effects: WorkInventoryEffectDef[];
  rules: WorkInventoryRule[];
  review_effects: WorkEffect[];
  /**
   * Effects whose steps are always `human` — a `human_override` may never
   * downgrade them. Absent: derived from the first rule that assigns `human`
   * on `effects_any` (see `forcedHumanEffects`).
   */
  forced_human_effects?: WorkEffect[];
  scoring_defaults: WorkInventoryScoringDefaults;
}

export interface WorkStepClassification {
  method: WorkMethod;
  rule_id: string;
  rationale: string;
  requires_review: boolean;
}

// ---------------------------------------------------------------------------
// Taxonomy catalog
// ---------------------------------------------------------------------------

const taxonomyCatalog = defineCatalog<WorkInventoryTaxonomy>({
  id: 'work-inventory-taxonomy',
  path: pathResolver.rootResolve('knowledge/product/governance/work-inventory-taxonomy.json'),
  schema: pathResolver.rootResolve('knowledge/product/schemas/work-inventory-taxonomy.schema.json'),
});

export function loadWorkInventoryTaxonomy(): WorkInventoryTaxonomy {
  return taxonomyCatalog.load();
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface WorkStepClassifyContext {
  system_has_api?: boolean;
}

function ruleWhenMatches(
  when: WorkInventoryRuleWhen,
  step: {
    verb: WorkVerb;
    stage: WorkStage;
    effects: WorkEffect[];
    data_sensitivity?: WorkDataSensitivity;
  },
  systemHasApi: boolean
): boolean {
  if (when.effects_any && !when.effects_any.some((effect) => step.effects.includes(effect))) {
    return false;
  }
  if (when.verbs && !when.verbs.includes(step.verb)) return false;
  if (when.stages && !when.stages.includes(step.stage)) return false;
  if (
    when.data_sensitivity_any &&
    (!step.data_sensitivity || !when.data_sensitivity_any.includes(step.data_sensitivity))
  ) {
    return false;
  }
  if (when.system_has_api !== undefined && when.system_has_api !== systemHasApi) return false;
  return true;
}

/**
 * First-match-wins classification of a single step against the taxonomy's
 * ordered rule table. Effects that force human judgment (money, irreversible,
 * approval) always win because their rule is first in the taxonomy.
 */
export function classifyWorkStep(
  step: Pick<WorkInventoryStep, 'verb' | 'stage' | 'effects' | 'data_sensitivity'>,
  context: WorkStepClassifyContext = {},
  taxonomy: WorkInventoryTaxonomy = loadWorkInventoryTaxonomy()
): WorkStepClassification {
  const effects = step.effects ?? [];
  const systemHasApi = context.system_has_api === true;
  const matched = taxonomy.rules.find((rule) =>
    ruleWhenMatches(rule.when, { ...step, effects }, systemHasApi)
  );
  if (!matched) {
    throw new Error(
      `work-inventory-taxonomy: no rule matched verb "${step.verb}" (expected a fallback rule with an empty "when")`
    );
  }
  const requiresReview = effects.some((effect) => taxonomy.review_effects.includes(effect));
  return {
    method: matched.assign,
    rule_id: matched.rule_id,
    rationale: matched.rationale,
    requires_review: requiresReview,
  };
}

/**
 * Effects that force a step to `human` regardless of any override: the
 * taxonomy's `forced_human_effects`, else the `effects_any` of the first rule
 * that assigns `human` on effects alone (the `effects-force-human` rule).
 */
export function forcedHumanEffects(
  taxonomy: WorkInventoryTaxonomy = loadWorkInventoryTaxonomy()
): WorkEffect[] {
  if (taxonomy.forced_human_effects) return [...taxonomy.forced_human_effects];
  const rule = taxonomy.rules.find(
    (candidate) => candidate.assign === 'human' && (candidate.when.effects_any?.length ?? 0) > 0
  );
  return [...(rule?.when.effects_any ?? [])];
}

/** The forced-human effects a step carries (empty when an override may stand). */
export function stepForcedHumanEffects(
  step: Pick<WorkInventoryStep, 'effects'>,
  taxonomy: WorkInventoryTaxonomy = loadWorkInventoryTaxonomy()
): WorkEffect[] {
  const forced = new Set(forcedHumanEffects(taxonomy));
  return (step.effects ?? []).filter((effect) => forced.has(effect));
}

function firstCandidateBinding(
  verb: WorkVerb,
  taxonomy: WorkInventoryTaxonomy
): WorkInventoryCandidateBinding | undefined {
  return taxonomy.verbs.find((entry) => entry.id === verb)?.candidate_bindings[0];
}

function fillBinding(
  step: WorkInventoryStep,
  taxonomy: WorkInventoryTaxonomy
): WorkInventoryStepBinding | undefined {
  if (step.binding?.actuator) return step.binding;
  const candidate = firstCandidateBinding(step.verb, taxonomy);
  if (!candidate) return step.binding;
  return {
    ...step.binding,
    actuator: candidate.actuator,
    ...(candidate.op ? { op: candidate.op } : {}),
    inferred: true,
  };
}

/**
 * Re-derives `method` for every step from the taxonomy's rules, preserving
 * `human_override` decisions. When a step carried a `proposal` method that
 * disagrees with the rule's verdict, the rule wins and the rationale records
 * both, per plan §2.2 ("規則と提案が食い違ったら rationale に両方を残す").
 * An override that is not `human` on a step with a forced-human effect
 * (money / irreversible / approval — `forcedHumanEffects`) is rejected: the
 * rule wins and the rationale records the rejected override.
 */
export function applyClassification(
  entry: WorkInventoryEntry,
  options: { apiSystems?: string[] } = {},
  taxonomy: WorkInventoryTaxonomy = loadWorkInventoryTaxonomy()
): WorkInventoryEntry {
  const apiSystems = new Set((options.apiSystems ?? []).map((system) => system.toLowerCase()));
  const steps = entry.steps.map((step) => {
    const systemHasApi = Boolean(step.system && apiSystems.has(step.system.toLowerCase()));
    const classification = classifyWorkStep(step, { system_has_api: systemHasApi }, taxonomy);
    const binding = fillBinding(step, taxonomy);

    const override = step.method?.source === 'human_override' ? step.method : undefined;
    const forced = override ? stepForcedHumanEffects(step, taxonomy) : [];
    if (override && (override.assigned === 'human' || forced.length === 0)) {
      return { ...step, binding, requires_review: classification.requires_review };
    }

    const proposal = step.method?.source === 'proposal' ? step.method : undefined;
    let rationale = `rule ${classification.rule_id}: ${classification.rationale}`;
    if (override) {
      rationale = `${rationale}; rejected human_override to ${override.assigned} (effects ${forced.join(', ')} always stay human): ${override.rationale}`;
    } else if (proposal && proposal.assigned !== classification.method) {
      rationale = `${rationale}; proposal was ${proposal.assigned}: ${proposal.rationale}`;
    }

    return {
      ...step,
      binding,
      requires_review: classification.requires_review,
      method: {
        assigned: classification.method,
        source: 'rule' as const,
        rule_id: classification.rule_id,
        rationale,
      },
    };
  });
  return { ...entry, steps };
}

// ---------------------------------------------------------------------------
// WI-17: backfill `inferred` on legacy default-candidate bindings
// ---------------------------------------------------------------------------

export interface MigrateInferredBindingsResult {
  entry: WorkInventoryEntry;
  /** Number of steps whose `binding.inferred` was set `true` by this call. */
  changed: number;
}

/**
 * `fillBinding` (used by `applyClassification`) has tagged
 * candidate-default bindings `inferred: true` since it was introduced, but
 * entries created before that never got the flag even though their binding
 * is exactly the verb's first taxonomy candidate. `matchSignalsToEntries`
 * treats an untagged binding as a real, declared one (never `inferred`),
 * so an untagged legacy default binding wrongly counts as demand-signal
 * evidence. This backfills the flag — and nothing else: a step is only
 * touched when its `binding` has no `pipeline_id`/`intent_id`, has no
 * `inferred` key at all (an explicit `inferred: false` is left alone — a
 * person confirmed it deliberately), and its `actuator`/`op` are exactly the
 * verb's first candidate binding. Idempotent: a second run changes nothing.
 */
export function migrateInferredBindings(
  entry: WorkInventoryEntry,
  taxonomy: WorkInventoryTaxonomy = loadWorkInventoryTaxonomy()
): MigrateInferredBindingsResult {
  let changed = 0;
  const steps = entry.steps.map((step) => {
    const binding = step.binding;
    if (!binding) return step;
    if (binding.inferred !== undefined) return step;
    if (binding.pipeline_id || binding.intent_id) return step;
    const candidate = firstCandidateBinding(step.verb, taxonomy);
    if (!candidate) return step;
    const opMatches = (candidate.op ?? undefined) === (binding.op ?? undefined);
    if (binding.actuator !== candidate.actuator || !opMatches) return step;
    changed += 1;
    return { ...step, binding: { ...binding, inferred: true } };
  });
  if (changed === 0) return { entry, changed: 0 };
  return { entry: { ...entry, steps }, changed };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const ENTRY_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/work-inventory-entry.schema.json'
);
let entryValidator: ValidateFunction<WorkInventoryEntry> | undefined;

function getEntryValidator(): ValidateFunction<WorkInventoryEntry> {
  entryValidator ||= compileSchema<WorkInventoryEntry>(ENTRY_SCHEMA_PATH);
  return entryValidator;
}

export function validateWorkInventoryEntry(input: unknown): { valid: boolean; errors: string[] } {
  const validate = getEntryValidator();
  if (validate(input)) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Entry id generation
// ---------------------------------------------------------------------------

const ENTRY_ID_PATTERN = /^WI-[A-Za-z0-9_-]{3,80}$/;

/**
 * The storage partition an entry lives in: `tenant:<slug>` or `personal`
 * (the same split `workInventoryRoot` uses). Part of the entry id hash and of
 * the promoted mission id so two scopes never share either.
 */
export function workInventoryScopeKey(scope: WorkInventoryScope): string {
  return scope.tenant_slug ? `tenant:${scope.tenant_slug}` : 'personal';
}

/**
 * `WI-<yyyymmdd>-<ascii slug, ≤40, omitted when empty>-<8 hex>` where the hex
 * is `sha256(title \n scope key \n created_at)`. The slug drops non-ASCII,
 * so the hash — not the slug — is what keeps two titles ("経費精算 Excel" /
 * "売上集計 Excel") apart. Deterministic for fixed inputs and `now`.
 */
function generateWorkInventoryEntryId(
  title: string,
  scope: WorkInventoryScope,
  createdAt: string
): string {
  const datePart = createdAt.slice(0, 10).replaceAll('-', '');
  const slug = slugify(title, { maxLength: 40 }).replace(/^-+|-+$/g, '');
  const digest = createHash('sha256')
    .update(`${title}\n${workInventoryScopeKey(scope)}\n${createdAt}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return slug ? `WI-${datePart}-${slug}-${digest}` : `WI-${datePart}-${digest}`;
}

export interface CreateWorkInventoryEntryInput {
  title: string;
  scope: WorkInventoryScope;
  trigger: WorkInventoryTrigger;
  frequency?: WorkInventoryFrequency;
  effort_minutes_per_run?: number;
  actors?: string[];
  systems?: string[];
  steps?: WorkInventoryStep[];
}

/** Builds a `draft` entry; deterministic `entry_id` given the same inputs and `now`. */
export function createWorkInventoryEntry(
  input: CreateWorkInventoryEntryInput,
  now: Date = new Date()
): WorkInventoryEntry {
  const createdAt = nowIso(now);
  return {
    schema_version: 'work-inventory.v1',
    entry_id: generateWorkInventoryEntryId(input.title, input.scope, createdAt),
    title: input.title,
    scope: input.scope,
    trigger: input.trigger,
    ...(input.frequency ? { frequency: input.frequency } : {}),
    ...(input.effort_minutes_per_run !== undefined
      ? { effort_minutes_per_run: input.effort_minutes_per_run }
      : {}),
    ...(input.actors ? { actors: input.actors } : {}),
    ...(input.systems ? { systems: input.systems } : {}),
    steps: input.steps ?? [],
    status: 'draft',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

// ---------------------------------------------------------------------------
// Storage (WI-01 §2.1: confidential/<tenant>/work-inventory or personal/work-inventory)
// ---------------------------------------------------------------------------

export function workInventoryRoot(
  scope: WorkInventoryScope,
  rootDir: string = pathResolver.rootDir()
): string {
  if (scope.tenant_slug) {
    if (!isValidTenantSlug(scope.tenant_slug)) {
      throw new Error(`invalid tenant slug: ${scope.tenant_slug}`);
    }
    // The tenant root comes from the governed scope chain, not a hand-built path.
    const tenantRoot = resolveKnowledgeScopeSet(
      { tier: 'confidential', tenant_slug: scope.tenant_slug },
      { includeCommon: false }
    ).roots.find((root) => root.startsWith('confidential/'));
    if (!tenantRoot) throw new Error(`no confidential root for tenant: ${scope.tenant_slug}`);
    return path.join(rootDir, 'knowledge', tenantRoot, 'work-inventory');
  }
  return path.join(rootDir, 'knowledge/personal/work-inventory');
}

function workInventoryEntriesDir(scope: WorkInventoryScope, rootDir: string): string {
  return path.join(workInventoryRoot(scope, rootDir), 'entries');
}

function workInventoryEntryPath(
  scope: WorkInventoryScope,
  entryId: string,
  rootDir: string
): string {
  if (!ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error(`invalid work inventory entry id: ${entryId}`);
  }
  const candidate = path.join(workInventoryEntriesDir(scope, rootDir), `${entryId}.json`);
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true, rootDir });
}

export type WorkInventoryStoreErrorCode = 'WORK_INVENTORY_ENTRY_EXISTS';

export class WorkInventoryStoreError extends Error {
  readonly code: WorkInventoryStoreErrorCode;

  constructor(code: WorkInventoryStoreErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'WorkInventoryStoreError';
    this.code = code;
  }
}

export interface SaveWorkInventoryEntryOptions {
  rootDir?: string;
  /**
   * `create` refuses to replace an existing file (`WORK_INVENTORY_ENTRY_EXISTS`)
   * — use it wherever a *new* entry is written. `upsert` (default) updates.
   */
  mode?: 'create' | 'upsert';
}

export function saveWorkInventoryEntry(
  entry: WorkInventoryEntry,
  options: SaveWorkInventoryEntryOptions = {}
): WorkInventoryEntry {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const updated: WorkInventoryEntry = { ...entry, updated_at: nowIso() };
  const check = validateWorkInventoryEntry(updated);
  if (!check.valid) {
    throw new Error(`Invalid work inventory entry ${updated.entry_id}: ${check.errors.join('; ')}`);
  }
  const filePath = workInventoryEntryPath(updated.scope, updated.entry_id, rootDir);
  if (options.mode === 'create' && safeExistsSync(filePath)) {
    throw new WorkInventoryStoreError(
      'WORK_INVENTORY_ENTRY_EXISTS',
      `work inventory entry ${updated.entry_id} already exists; refusing to overwrite it`
    );
  }
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8' });
  return updated;
}

export function loadWorkInventoryEntry(
  scope: WorkInventoryScope,
  entryId: string,
  options: { rootDir?: string } = {}
): WorkInventoryEntry | null {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const filePath = workInventoryEntryPath(scope, entryId, rootDir);
  if (!safeExistsSync(filePath)) return null;
  const raw = parseSafeJsonInput(
    String(safeReadFile(filePath, { encoding: 'utf8' })),
    `work inventory entry ${entryId}`
  );
  const check = validateWorkInventoryEntry(raw);
  if (!check.valid) {
    throw new Error(
      `Invalid work inventory entry ${entryId} at ${filePath}: ${check.errors.join('; ')}`
    );
  }
  return raw as WorkInventoryEntry;
}

export function listWorkInventoryEntries(
  scope: WorkInventoryScope,
  options: { rootDir?: string } = {}
): WorkInventoryEntry[] {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const dir = workInventoryEntriesDir(scope, rootDir);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadWorkInventoryEntry(scope, entry.replace(/\.json$/, ''), { rootDir }))
    .filter((entry): entry is WorkInventoryEntry => Boolean(entry))
    .sort((a, b) => a.entry_id.localeCompare(b.entry_id));
}
