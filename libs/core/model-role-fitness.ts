import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from './secure-io.js';
import * as path from 'node:path';
import {
  MODEL_PERFORMANCE_MIN_SAMPLES,
  getModelRolePerformance,
} from './model-performance-index.js';

/**
 * TC-15: can this model actually do this role?
 *
 * Three answers to that question already existed and none of them answered
 * it. `BACKEND_CAPABILITY_PROFILES` is hand-declared per backend mode, not
 * per model and not per role. The provider capability scanner probes whether
 * a CLI runs, not whether its model can review code. The model performance
 * index is the closest, but it is purely observational: a model earns a role
 * score only by first being trusted with real mission work, and until it has
 * `MODEL_PERFORMANCE_MIN_SAMPLES` samples its adjustment is exactly zero. New
 * models and providers arrive continuously, so that cold start is the normal
 * case, not an edge case.
 *
 * This is the missing measurement: a small set of governed probes per team
 * role, scored mechanically. Every assertion is a structural check on the
 * response — does it parse, does it carry the contract's fields, does it name
 * the defective line, is the dependency graph acyclic. No model judges
 * another model here, because a judge inherits exactly the weakness being
 * measured.
 *
 * The result is a cold-start prior only. Once real mission outcomes exist,
 * observation supersedes the probe (see `modelRoleFitnessScoreAdjustment`) —
 * a probe says a model can hold the contract, not that it does good work.
 */
export type FitnessAssertionKind =
  | 'json_array'
  | 'json_object'
  | 'min_items'
  | 'required_fields'
  | 'field_equals_any'
  | 'field_contains'
  | 'acyclic_dependencies';

export interface FitnessAssertion {
  kind: FitnessAssertionKind;
  /**
   * Must pass regardless of the overall score. Contract-shape assertions are
   * scored; the assertion that checks whether the model got the answer RIGHT
   * is required, so a response that keeps the shape and misses the judgement
   * can never reach the bar by weight of structure alone.
   */
  required?: boolean;
  field?: string;
  fields?: string[];
  values?: string[];
  count?: number;
  id_field?: string;
  depends_field?: string;
}

export interface RoleFitnessProbe {
  id: string;
  team_role: string;
  prompt: string;
  rationale?: string;
  assertions: FitnessAssertion[];
}

export interface RoleFitnessProbeCatalog {
  version: string;
  pass_threshold: number;
  probes: RoleFitnessProbe[];
}

const FALLBACK_CATALOG: RoleFitnessProbeCatalog = {
  version: '1.0.0',
  pass_threshold: 0.75,
  probes: [],
};

const probeCatalog = defineCatalog<RoleFitnessProbeCatalog>({
  id: 'model-role-fitness-probes',
  path: () => pathResolver.knowledge('product/governance/model-role-fitness-probes.json'),
  schema: pathResolver.knowledge('product/schemas/model-role-fitness-probes.schema.json'),
  fallback: FALLBACK_CATALOG,
});

export function loadRoleFitnessProbeCatalog(): RoleFitnessProbeCatalog {
  return probeCatalog.load();
}

export function resetRoleFitnessProbeCatalog(): void {
  probeCatalog.reset();
}

export function listRoleFitnessProbes(teamRole?: string): RoleFitnessProbe[] {
  const probes = loadRoleFitnessProbeCatalog().probes;
  return teamRole ? probes.filter((probe) => probe.team_role === teamRole) : probes;
}

export interface FitnessAssertionResult {
  kind: FitnessAssertionKind;
  passed: boolean;
  required?: boolean;
  detail?: string;
}

export interface RoleFitnessEvaluation {
  probe_id: string;
  team_role: string;
  score: number;
  passed: boolean;
  assertions: FitnessAssertionResult[];
  parsed: boolean;
}

function extractJson(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const candidates: Array<[number, number]> = [];
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push([arrayStart, arrayEnd]);
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push([objectStart, objectEnd]);
  candidates.sort((left, right) => left[0] - right[0]);
  for (const [start, end] of candidates) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return undefined;
}

function asItems(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
    );
  }
  if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
  return [];
}

function fieldText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

function isAcyclic(
  items: Array<Record<string, unknown>>,
  idField: string,
  dependsField: string
): { ok: boolean; detail?: string } {
  const ids = new Set(items.map((item) => fieldText(item[idField])).filter(Boolean));
  const edges = new Map<string, string[]>();
  for (const item of items) {
    const id = fieldText(item[idField]);
    if (!id) return { ok: false, detail: `item without ${idField}` };
    const raw = item[dependsField];
    const dependencies = Array.isArray(raw) ? raw.map(fieldText).filter(Boolean) : [];
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) {
        return { ok: false, detail: `${id} depends on unknown ${dependency}` };
      }
    }
    edges.set(id, dependencies);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === 'done') return true;
    if (current === 'visiting') return false;
    state.set(id, 'visiting');
    for (const dependency of edges.get(id) || []) {
      if (!visit(dependency)) return false;
    }
    state.set(id, 'done');
    return true;
  };
  for (const id of edges.keys()) {
    if (!visit(id)) return { ok: false, detail: `cycle through ${id}` };
  }
  return { ok: true };
}

/**
 * Pure scoring: no backend, no filesystem. This is what makes a probe result
 * reproducible and reviewable — the same response always scores the same.
 */
export function evaluateRoleFitnessResponse(
  probe: RoleFitnessProbe,
  raw: string,
  passThreshold = loadRoleFitnessProbeCatalog().pass_threshold
): RoleFitnessEvaluation {
  const parsed = extractJson(raw);
  const items = asItems(parsed);
  const results: FitnessAssertionResult[] = [];

  for (const assertion of probe.assertions) {
    switch (assertion.kind) {
      case 'json_array':
        results.push({ kind: assertion.kind, passed: Array.isArray(parsed) });
        break;
      case 'json_object':
        results.push({
          kind: assertion.kind,
          passed: Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed),
        });
        break;
      case 'min_items':
        results.push({
          kind: assertion.kind,
          passed: items.length >= (assertion.count ?? 1),
          detail: `${items.length} item(s)`,
        });
        break;
      case 'required_fields': {
        const fields = assertion.fields || [];
        const missing =
          items.length === 0
            ? fields
            : fields.filter((field) => items.some((item) => item[field] === undefined));
        results.push({
          kind: assertion.kind,
          passed: items.length > 0 && missing.length === 0,
          ...(missing.length > 0 ? { detail: `missing ${missing.join(', ')}` } : {}),
        });
        break;
      }
      case 'field_equals_any': {
        const expected = new Set((assertion.values || []).map((value) => value.toLowerCase()));
        const passed = items.some((item) =>
          expected.has(
            fieldText(item[assertion.field || ''])
              .trim()
              .toLowerCase()
          )
        );
        results.push({
          kind: assertion.kind,
          passed,
          ...(passed
            ? {}
            : { detail: `no item with ${assertion.field} in ${[...expected].join('|')}` }),
        });
        break;
      }
      case 'field_contains': {
        const needles = (assertion.values || []).map((value) => value.toLowerCase());
        const passed = items.some((item) => {
          const haystack = fieldText(item[assertion.field || '']).toLowerCase();
          return needles.some((needle) => haystack.includes(needle));
        });
        results.push({
          kind: assertion.kind,
          passed,
          ...(passed ? {} : { detail: `no ${assertion.field} containing ${needles.join('|')}` }),
        });
        break;
      }
      case 'acyclic_dependencies': {
        const verdict = isAcyclic(
          items,
          assertion.id_field || 'id',
          assertion.depends_field || 'depends_on'
        );
        results.push({
          kind: assertion.kind,
          passed: items.length > 0 && verdict.ok,
          ...(verdict.detail ? { detail: verdict.detail } : {}),
        });
        break;
      }
    }
  }

  for (const [index, assertion] of probe.assertions.entries()) {
    if (assertion.required && results[index]) results[index]!.required = true;
  }
  const score =
    results.length === 0 ? 0 : results.filter((entry) => entry.passed).length / results.length;
  const requiredSatisfied = results.every((entry) => !entry.required || entry.passed);
  return {
    probe_id: probe.id,
    team_role: probe.team_role,
    score,
    passed: score >= passThreshold && requiredSatisfied,
    assertions: results,
    parsed: parsed !== undefined,
  };
}

export interface ModelRoleFitnessRecord {
  model_id: string;
  provider?: string;
  team_role: string;
  probe_id: string;
  score: number;
  passed: boolean;
  backend: string;
  evaluated_at: string;
  failed_assertions: string[];
}

/**
 * Model catalogs and backend/egress policy use different historical names for
 * the same provider. Keep the normalization at the fitness evidence seam so
 * a probe recorded by `claude-cli` can evidence an `anthropic:*` model, while
 * the rest of the provider policy keeps its existing identifiers.
 */
export function normalizeFitnessProviderId(provider: string | undefined): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  return (
    (
      {
        anthropic: 'claude',
        openai: 'codex',
        xai: 'grok',
        'gemini-api': 'gemini',
      } as Record<string, string>
    )[normalized] || normalized
  );
}

const FITNESS_JOURNAL_PATH = 'observability/retrospectives/model-role-fitness.jsonl';

export function modelRoleFitnessPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(FITNESS_JOURNAL_PATH), {
    allowMissingLeaf: true,
  });
}

export function recordModelRoleFitness(record: ModelRoleFitnessRecord): void {
  const filePath = modelRoleFitnessPath();
  safeMkdir(path.dirname(filePath), { recursive: true });
  appendJsonLine(filePath, record);
}

export function loadModelRoleFitnessRecords(): ModelRoleFitnessRecord[] {
  const filePath = modelRoleFitnessPath();
  if (!safeExistsSync(filePath)) return [];
  return readJsonLines<ModelRoleFitnessRecord>(filePath).filter(
    (record) => Boolean(record?.model_id) && Boolean(record?.team_role)
  );
}

export interface ModelRoleFitness {
  status: 'unproven' | 'passed' | 'failed';
  score: number;
  probes: number;
  evaluated_at?: string;
}

/**
 * The most recent verdict per probe, aggregated. A model counts as fit for a
 * role only when every probe for that role has been run and passed: a role
 * with an unrun probe is `unproven`, not `passed`.
 */
export function resolveModelRoleFitness(modelId: string, teamRole: string): ModelRoleFitness {
  const probes = listRoleFitnessProbes(teamRole);
  if (probes.length === 0) return { status: 'unproven', score: 0, probes: 0 };
  const normalizedModel = modelId.trim().toLowerCase();
  const latest = new Map<string, ModelRoleFitnessRecord>();
  for (const record of loadModelRoleFitnessRecords()) {
    if (record.model_id.trim().toLowerCase() !== normalizedModel) continue;
    if (record.team_role !== teamRole) continue;
    const current = latest.get(record.probe_id);
    if (!current || record.evaluated_at > current.evaluated_at) latest.set(record.probe_id, record);
  }
  if (latest.size === 0) return { status: 'unproven', score: 0, probes: 0 };
  const records = [...latest.values()];
  const score = records.reduce((total, record) => total + record.score, 0) / records.length;
  const evaluatedAt = records
    .map((record) => record.evaluated_at)
    .sort()
    .at(-1);
  const everyProbeRun = probes.every((probe) => latest.has(probe.id));
  const anyFailed = records.some((record) => !record.passed);
  return {
    status: anyFailed ? 'failed' : everyProbeRun ? 'passed' : 'unproven',
    score,
    probes: records.length,
    ...(evaluatedAt ? { evaluated_at: evaluatedAt } : {}),
  };
}

/** Cold-start prior for selection, capped well under a capability match. */
export const MODEL_ROLE_FITNESS_MAX_ADJUSTMENT = 6;

/**
 * TC-16: score a model's measured role fitness — but only while observation
 * is silent.
 *
 * `modelPerformanceScoreAdjustment` returns 0 until a model×role pair has
 * `MODEL_PERFORMANCE_MIN_SAMPLES` real outcomes. That window is exactly where
 * a probe is worth something and exactly where nothing was being said. Once
 * observation speaks, it wins: a probe measures whether a model can hold the
 * contract, not whether it does good work.
 */
export function modelRoleFitnessScoreAdjustment(modelId: string, teamRole: string): number {
  const observed = getModelRolePerformance(modelId, teamRole);
  const evidenceSamples = observed ? observed.samples + observed.feedback_samples : 0;
  if (evidenceSamples >= MODEL_PERFORMANCE_MIN_SAMPLES) return 0;

  const fitness = resolveModelRoleFitness(modelId, teamRole);
  if (fitness.status === 'unproven') return 0;
  // A measured failure is the one case worth acting on hard: the model could
  // not hold this role's contract when asked directly.
  if (fitness.status === 'failed') return -MODEL_ROLE_FITNESS_MAX_ADJUSTMENT;
  return Math.round((fitness.score - 0.5) * 2 * MODEL_ROLE_FITNESS_MAX_ADJUSTMENT);
}
