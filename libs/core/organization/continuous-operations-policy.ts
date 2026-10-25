/** Deterministic observation-to-proposal policy. External observations never supply actions. */
import { isReservedScopeName, isValidTenantSlug } from '../entity-scope.js';
import {
  parseContinuousWorkPlan,
  CONTINUOUS_MANAGED_WORK_PIPELINE,
  type ContinuousWorkPlan,
} from './continuous-work-plan.js';
import {
  DEFAULT_DOT_ACTION_ID,
  type DotProposal,
  type DotExpectedEffect,
} from '../dot/dot-proposals.js';

export interface ContinuousOperationsScope {
  tier: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
  organization_id: string;
  project_id?: string;
}
interface ContinuousOperationsSourceBase {
  source_id: string;
  max_age_seconds: number;
}
export type ContinuousOperationsSource = ContinuousOperationsSourceBase &
  (
    | { kind?: 'snapshot'; path: string }
    | { kind: 'organization_metrics' }
    | { kind: 'pipeline'; path: string; pipeline_ref: string }
  );
export interface ContinuousOperationsRule {
  rule_id: string;
  source_id: string;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  objective_ref: string;
  title: string;
  objective: string;
  pipeline_ref: string;
  priority?: DotProposal['priority'];
  requested_decision?: DotProposal['requested_decision'];
  expected_effect?: DotExpectedEffect;
  work_plan?: ContinuousWorkPlan;
}
export interface ContinuousOperationsConfig {
  version: '1';
  loop_id: string;
  dot_id: string;
  scope: ContinuousOperationsScope;
  sources: ContinuousOperationsSource[];
  rules: ContinuousOperationsRule[];
  max_proposals_per_run: number;
  cooldown_seconds: number;
  enabled: boolean;
  schedule?: { every_seconds: number };
}
export interface ContinuousObservation {
  metric: string;
  value: number;
  observed_at: string;
  evidence_ref: string;
}
export interface ContinuousSourceSnapshot {
  source_id: string;
  observations: ContinuousObservation[];
}
export interface ContinuousOperationsCandidate {
  rule_id: string;
  source_id: string;
  objective_ref: string;
  evidence_refs: string[];
  value: number;
  observed_at: string;
  proposal: DotProposal;
}

function fail(message: string): never {
  throw new Error(`Continuous operations: ${message}`);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail('unknown field');
  return result;
}
function text(value: unknown, max = 4000): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail('invalid text');
  return value;
}
function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result) || result === '.' || result === '..')
    fail('invalid identifier');
  return result;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected finite number');
  return value;
}
function positive(value: unknown): number {
  const n = number(value);
  if (n <= 0 || n > 31_536_000) fail('invalid duration');
  return n;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) fail('invalid choice');
  return value as T;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid collection');
  return value;
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) fail('duplicate identifier');
}
function path(value: unknown): string {
  const result = text(value, 1024);
  if (
    !/^[A-Za-z0-9_./-]+$/.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('invalid relative path');
  return result;
}
function pipelinePath(value: unknown): string {
  const result = path(value);
  if (!result.startsWith('pipelines/') || !result.endsWith('.json'))
    fail('invalid pipeline reference');
  return result;
}
export function parseContinuousOperationsConfig(value: unknown): ContinuousOperationsConfig {
  const r = record(value, [
    'version',
    'loop_id',
    'dot_id',
    'scope',
    'sources',
    'rules',
    'max_proposals_per_run',
    'cooldown_seconds',
    'enabled',
    'schedule',
  ]);
  const s = record(r.scope, ['tier', 'tenant_slug', 'organization_id', 'project_id']);
  const scope: ContinuousOperationsScope = {
    tier: choice(s.tier, ['public', 'confidential', 'personal']),
    organization_id: id(s.organization_id),
  };
  if (s.tenant_slug !== undefined) {
    const tenant = id(s.tenant_slug);
    if (!isValidTenantSlug(tenant) || isReservedScopeName(tenant)) fail('invalid tenant');
    scope.tenant_slug = tenant;
  }
  if (scope.tier === 'confidential' && !scope.tenant_slug)
    fail('confidential scope requires tenant');
  if (s.project_id !== undefined) scope.project_id = id(s.project_id);
  const sources: ContinuousOperationsSource[] = rows(r.sources, 100).map(
    (value): ContinuousOperationsSource => {
      const source = record(value, [
        'source_id',
        'kind',
        'path',
        'pipeline_ref',
        'max_age_seconds',
      ]);
      const kind =
        source.kind === undefined
          ? undefined
          : choice(source.kind, ['snapshot', 'organization_metrics', 'pipeline']);
      const base = {
        source_id: id(source.source_id),
        max_age_seconds: positive(source.max_age_seconds),
      };
      if (kind === 'organization_metrics') {
        if (source.path !== undefined || source.pipeline_ref !== undefined)
          fail('organization metrics cannot define a path or pipeline');
        return { ...base, kind };
      }
      const p = path(source.path);
      const partition = scope.tenant_slug ?? 'shared';
      const knowledgePrefix = `knowledge/${scope.tier}/${scope.tier === 'confidential' ? `${partition}/` : ''}`;
      if (
        !p.startsWith(`active/shared/runtime/${scope.tier}/${partition}/`) &&
        !p.startsWith(knowledgePrefix)
      )
        fail('source outside configured scope');
      if (kind === 'pipeline')
        return { ...base, kind, path: p, pipeline_ref: pipelinePath(source.pipeline_ref) };
      if (source.pipeline_ref !== undefined) fail('snapshot cannot define a pipeline');
      return { ...base, ...(kind ? { kind } : {}), path: p };
    }
  );
  if (!sources.length) fail('sources required');
  unique(sources.map((source) => source.source_id));
  const rules = rows(r.rules, 1000).map((value) => {
    const rule = record(value, [
      'rule_id',
      'source_id',
      'metric',
      'operator',
      'threshold',
      'objective_ref',
      'title',
      'objective',
      'pipeline_ref',
      'priority',
      'requested_decision',
      'expected_effect',
      'work_plan',
    ]);
    const pipeline = pipelinePath(rule.pipeline_ref);
    const result: ContinuousOperationsRule = {
      rule_id: id(rule.rule_id),
      source_id: id(rule.source_id),
      metric: id(rule.metric),
      operator: choice(rule.operator, ['gt', 'gte', 'lt', 'lte']),
      threshold: number(rule.threshold),
      objective_ref: text(rule.objective_ref, 512),
      title: text(rule.title, 256),
      objective: text(rule.objective),
      pipeline_ref: pipeline,
    };
    if (!sources.some((source) => source.source_id === result.source_id))
      fail('unknown rule source');
    if (rule.priority !== undefined)
      result.priority = choice(rule.priority, ['low', 'normal', 'high', 'urgent']);
    if (rule.requested_decision !== undefined)
      result.requested_decision = choice(rule.requested_decision, ['auto', 'notify', 'approve']);
    if (rule.work_plan !== undefined) {
      result.work_plan = parseContinuousWorkPlan(rule.work_plan);
      if (result.work_plan.kind !== 'project' && !scope.project_id)
        fail('managed mission work requires project scope');
      if (pipeline !== CONTINUOUS_MANAGED_WORK_PIPELINE)
        fail('managed work requires its governed pipeline');
      // The rendered card text is capped inside managedObjective, so the size
      // gate applies to the operator-written objective itself: a huge objective
      // would be silently truncated on the card otherwise.
      if (result.objective.length > 2000)
        fail('managed work approval summary exceeds 2000 characters');
    } else if (pipeline === CONTINUOUS_MANAGED_WORK_PIPELINE)
      fail('managed work pipeline requires a work plan');
    if (rule.expected_effect !== undefined) {
      const effect = record(rule.expected_effect, ['kr_id', 'signal', 'direction']);
      result.expected_effect = {
        direction: choice(effect.direction, ['increase', 'decrease', 'maintain']),
      };
      if (effect.kr_id !== undefined) result.expected_effect.kr_id = id(effect.kr_id);
      if (effect.signal !== undefined) result.expected_effect.signal = text(effect.signal, 512);
    }
    return result;
  });
  unique(rules.map((rule) => rule.rule_id));
  const max = number(r.max_proposals_per_run);
  if (!Number.isInteger(max) || max < 1 || max > 10) fail('invalid proposal limit');
  if (typeof r.enabled !== 'boolean') fail('enabled must be boolean');
  const schedule = r.schedule === undefined ? undefined : record(r.schedule, ['every_seconds']);
  return {
    version: choice(r.version, ['1']),
    loop_id: id(r.loop_id),
    dot_id: id(r.dot_id),
    scope,
    sources,
    rules,
    max_proposals_per_run: max,
    cooldown_seconds: positive(r.cooldown_seconds),
    enabled: r.enabled,
    ...(schedule ? { schedule: { every_seconds: positive(schedule.every_seconds) } } : {}),
  };
}

export function parseContinuousObservations(value: unknown): ContinuousObservation[] {
  const result = rows(value, 1000).map((value) => {
    const r = record(value, ['metric', 'value', 'observed_at', 'evidence_ref']);
    const observedAt = text(r.observed_at, 32);
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(observedAt) ||
      !Number.isFinite(Date.parse(observedAt)) ||
      new Date(observedAt).toISOString() !==
        observedAt.replace(/Z$/, observedAt.includes('.') ? 'Z' : '.000Z')
    )
      fail('invalid observation time');
    return {
      metric: id(r.metric),
      value: number(r.value),
      observed_at: observedAt,
      evidence_ref: text(r.evidence_ref, 1024),
    };
  });
  unique(result.map((row) => row.metric));
  return result;
}
/**
 * Decision-card text for a managed plan. The full plan JSON used to be inlined
 * here, which blew past the 1000-character approval-card limit for any
 * non-trivial plan while config validation allowed 4000 — the card, not the
 * plan, is what the human reads; the plan itself stays bound by the admission
 * semantic hash. Emit a compact mission index instead and hard-cap the result
 * so a card can always be rendered.
 */
function managedObjective(objective: string, plan: ContinuousWorkPlan): string {
  const index = plan.missions
    .map((m) => `${m.key}: ${m.title}`)
    .join('; ')
    .slice(0, 600);
  const text = `${objective}\nManaged work plan (${plan.kind}, ${plan.missions.length} mission(s)): ${index}${plan.missions.map((m) => `${m.key}: ${m.title}`).join('; ').length > 600 ? '…' : ''}`;
  return text.length > 950 ? `${text.slice(0, 947)}…` : text;
}

export function evaluateContinuousOperations(
  config: ContinuousOperationsConfig,
  snapshots: ContinuousSourceSnapshot[],
  now: Date
): ContinuousOperationsCandidate[] {
  config = parseContinuousOperationsConfig(config);
  if (!Number.isFinite(now.getTime())) fail('invalid clock');
  if (!Array.isArray(snapshots) || snapshots.length !== config.sources.length)
    fail('incomplete sources');
  unique(snapshots.map((snapshot) => snapshot.source_id));
  const observations = new Map<string, ContinuousObservation[]>();
  for (const snapshot of snapshots) {
    const source = config.sources.find((source) => source.source_id === snapshot.source_id);
    if (!source) fail('unknown snapshot source');
    const parsed = parseContinuousObservations(snapshot.observations);
    for (const row of parsed) {
      const age = now.getTime() - Date.parse(row.observed_at);
      if (age < 0 || age > source.max_age_seconds * 1000) fail('stale or future observation');
    }
    observations.set(source.source_id, parsed);
  }
  if (!config.enabled) return [];
  const candidates: ContinuousOperationsCandidate[] = [];
  for (const rule of config.rules) {
    const row = observations.get(rule.source_id)?.find((row) => row.metric === rule.metric);
    if (!row) fail(`missing metric ${rule.source_id}/${rule.metric}`);
    const match =
      rule.operator === 'gt'
        ? row.value > rule.threshold
        : rule.operator === 'gte'
          ? row.value >= rule.threshold
          : rule.operator === 'lt'
            ? row.value < rule.threshold
            : row.value <= rule.threshold;
    if (!match) continue;
    const proposal: DotProposal = {
      action_id: DEFAULT_DOT_ACTION_ID,
      title: rule.title,
      objective: rule.objective,
      work_shape: 'pipeline',
      pipeline_ref: rule.pipeline_ref,
      rationale: `Continuous operations ${config.loop_id}: ${rule.source_id}/${rule.metric} matched rule ${rule.rule_id}.`,
    };
    if (rule.priority !== undefined) proposal.priority = rule.priority;
    if (rule.requested_decision !== undefined)
      proposal.requested_decision = rule.requested_decision;
    if (rule.work_plan) {
      proposal.continuous_work = rule.work_plan;
      proposal.requested_decision = 'approve';
      proposal.objective = managedObjective(rule.objective, rule.work_plan);
    }
    if (rule.expected_effect !== undefined) proposal.expected_effect = { ...rule.expected_effect };
    candidates.push({
      rule_id: rule.rule_id,
      source_id: rule.source_id,
      objective_ref: rule.objective_ref,
      evidence_refs: [row.evidence_ref],
      value: row.value,
      observed_at: row.observed_at,
      proposal,
    });
  }
  // Admission limits apply after inventory reconciliation and deduplication.
  return candidates;
}
