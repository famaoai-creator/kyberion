/** Offline snapshot boundary. Readers and exact case/scope bindings belong to the caller. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { activeDecided } from '../decision-ledger/conformance.js';
import {
  canonicalJson,
  CASE_ID_PATTERN,
  DECISION_AUTHORITIES,
  DECISION_ID_PATTERN,
  DECISION_KEY_PATTERN,
  DECISION_LEVELS,
  DECISION_ORIGINS,
  DECISION_STATES,
  type DecisionRecord,
} from '../decision-ledger/model.js';
import type { ScopeContext } from '../scope-context-validation.js';
import {
  decisionEvidenceRefSchema,
  judgmentScopeSchema,
  latencyGoalConstraintsSchema,
  type DecisionEvidenceRef,
  type JudgmentUnavailableReason,
  type LatencyGoalConstraints,
} from './judgment-contract.js';

const text = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value.trim().length > 0);
const basisText = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim() === value && value.length > 0);
const basisSchema = z
  .object({
    ref: basisText,
    version: basisText,
    note: z.string().optional(),
    approved: z.string().optional(),
  })
  .strict();
const recordSchema = z
  .object({
    id: z.string().regex(DECISION_ID_PATTERN),
    case_id: z.string().regex(CASE_ID_PATTERN),
    item: text,
    key: z.string().regex(DECISION_KEY_PATTERN),
    level: z.enum(DECISION_LEVELS),
    state: z.enum(DECISION_STATES),
    value: z.unknown(),
    options: z.array(z.unknown()).optional(),
    authority: z.enum(DECISION_AUTHORITIES).optional(),
    basis: z.array(basisSchema).max(10),
    bound_to: z.array(text).max(10).optional(),
    decided_by: z
      .object({
        kind: z.literal('human'),
        id: z.string().regex(/^user:\S+$/u),
        display_name: text.optional(),
        role: z.enum(['owner', 'approver', 'viewer']).optional(),
        on_behalf_of: z
          .object({
            actor_id: z.string().regex(/^customer:[a-z][a-z0-9-]{0,60}$/u),
            confirm_target: text.optional(),
            evidence: text.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    decided_at: text.optional(),
    proposed_by: z
      .object({
        kind: z.enum(['human', 'agent', 'service']),
        id: text,
        display_name: text.optional(),
        on_behalf_of: text.optional(),
      })
      .strict()
      .optional(),
    proposed_at: text.optional(),
    origin: z.enum(DECISION_ORIGINS),
    status: z.enum(['active', 'superseded']),
    supersedes: z.string().regex(DECISION_ID_PATTERN).optional(),
    pending_reason: text.optional(),
    note: text.optional(),
    source_turn: text.optional(),
  })
  .strict();

/** Reject lossy JSON encodings (undefined, NaN, class instances, cycles, sparse arrays). */
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new Error('JSON nesting exceeds snapshot bound');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value) throw new Error('Snapshot requires finite JSON');
  if (ancestors.has(value)) throw new Error('Snapshot requires acyclic JSON');
  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) {
    throw new Error('Snapshot requires plain JSON objects');
  }
  for (const property of Reflect.ownKeys(value)) {
    if (typeof property !== 'string' || property === '__proto__') {
      throw new Error('Snapshot contains a lossy JSON property');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('Snapshot requires data properties');
    }
    if (Array.isArray(value) && property === 'length') continue;
    const index = Number(property);
    if (
      !descriptor.enumerable ||
      (Array.isArray(value) &&
        (!Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== property))
    ) {
      throw new Error('Snapshot contains a lossy JSON property');
    }
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error('Snapshot requires dense JSON arrays');
      assertJson(value[index], ancestors, depth + 1);
    }
  } else {
    for (const entry of Object.values(value)) assertJson(entry, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

/** Uses the existing decision-ledger canonical JSON convention; contains no I/O. */
export function judgmentCanonicalHash(value: unknown): string {
  assertJson(value);
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export interface TrustedJudgmentCaseBinding {
  case_id: string;
  /** Exact full requested scope, including mission/task/session when present. */
  scope: ScopeContext;
}

export interface TrustedLatencyGoalBinding {
  case_id: string;
  decision_id: string;
  decision_version_hash: string;
  /** Structured trusted adapter facts, never inferred from arbitrary decision.value text. */
  constraints: Omit<LatencyGoalConstraints, 'decision_source_key'>;
}

export interface JudgmentPrecedentDeps {
  resolveCaseBinding(tenantSlug: string, caseId: string): TrustedJudgmentCaseBinding | undefined;
  readLedger(location: { tenantSlug: string; caseId: string }): readonly DecisionRecord[];
  resolveGoals(decision: {
    case_id: string;
    decision_id: string;
    decision_version_hash: string;
    source_key: string;
  }): readonly TrustedLatencyGoalBinding[];
}

export interface JudgmentPrecedentSnapshot {
  scope: ScopeContext;
  scope_hash: string;
  snapshot_hash: string;
  /** Server-only source data. Model summaries must use the bounded structured goals. */
  decisions: Array<{ source_key: string; record: DecisionRecord }>;
  evidence_refs: DecisionEvidenceRef[];
  goals: LatencyGoalConstraints[];
}

export type JudgmentPrecedentResult =
  | { status: 'ready'; snapshot: JudgmentPrecedentSnapshot }
  | { status: 'unavailable'; reason: JudgmentUnavailableReason; detail: string };

const cases = z
  .array(z.string().regex(CASE_ID_PATTERN))
  .min(1)
  .max(10)
  .refine((items) => new Set(items).size === items.length, 'Case identifiers must be unique');
const requestSchema = z
  .object({
    scope: judgmentScopeSchema,
    selected_case_ids: cases,
    allowed_case_ids: cases,
  })
  .strict();
const goalBindingSchema = z
  .object({
    case_id: z.string().regex(CASE_ID_PATTERN),
    decision_id: z.string().regex(DECISION_ID_PATTERN),
    decision_version_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    constraints: latencyGoalConstraintsSchema.omit({ decision_source_key: true }),
  })
  .strict();

const unavailable = (
  reason: JudgmentUnavailableReason,
  detail: string
): JudgmentPrecedentResult => ({
  status: 'unavailable',
  reason,
  detail,
});
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Only injected fixture ports are provided here. No production ledger reader, role assumption,
 * scope widening, or storage write is performed. Recreate this snapshot to check its current hash.
 */
export function createJudgmentPrecedentSnapshot(
  input: {
    scope: ScopeContext;
    selected_case_ids: readonly string[];
    allowed_case_ids: readonly string[];
  },
  deps: JudgmentPrecedentDeps
): JudgmentPrecedentResult {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return unavailable('invalid_schema', 'Invalid snapshot request');
  const { scope, selected_case_ids: selected, allowed_case_ids: allowed } = parsed.data;
  if (!scope.tenant_slug)
    return unavailable('scope_mismatch', 'An explicit tenant scope is required');
  const scopeHash = judgmentCanonicalHash(scope);
  // Complete authorization/mapping checks for every selected case before the first ledger read.
  for (const caseId of selected) {
    if (!allowed.includes(caseId))
      return unavailable('scope_mismatch', 'Case is outside the allowed set');
    try {
      const binding = deps.resolveCaseBinding(scope.tenant_slug, caseId);
      if (!binding || binding.case_id !== caseId)
        return unavailable('scope_mismatch', 'Case scope is not established');
      const mapped = judgmentScopeSchema.safeParse(binding.scope);
      if (!mapped.success || judgmentCanonicalHash(mapped.data) !== scopeHash) {
        return unavailable(
          'scope_mismatch',
          'Case scope does not match the complete requested scope'
        );
      }
    } catch {
      return unavailable('scope_mismatch', 'Case scope could not be verified');
    }
  }

  const decisions: JudgmentPrecedentSnapshot['decisions'] = [];
  const evidenceRefs: DecisionEvidenceRef[] = [];
  const goals: LatencyGoalConstraints[] = [];
  for (const caseId of [...selected].sort(compare)) {
    let records: DecisionRecord[];
    try {
      const raw = deps.readLedger({ tenantSlug: scope.tenant_slug, caseId });
      assertJson(raw);
      // Bound the trusted port's response before examining its records.
      if (
        !Array.isArray(raw) ||
        raw.length > 1000 ||
        Buffer.byteLength(canonicalJson(raw), 'utf8') > 256 * 1024
      ) {
        return unavailable(
          'missing_evidence',
          'Ledger snapshot exceeds the bounded adapter contract'
        );
      }
      records = raw.map(
        (record) => recordSchema.parse(JSON.parse(canonicalJson(record))) as DecisionRecord
      );
    } catch {
      return unavailable('missing_evidence', 'Decision evidence could not be read and validated');
    }
    if (records.some((record) => record.case_id !== caseId)) {
      return unavailable(
        'scope_mismatch',
        'Decision evidence does not belong to the selected case'
      );
    }
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      return unavailable(
        'conflicting_precedents',
        'A case contains duplicate decision identifiers'
      );
    }
    const active = activeDecided(records);
    const itemKeys = new Set<string>();
    for (const record of active) {
      const itemKey = canonicalJson([record.item, record.key]);
      if (itemKeys.has(itemKey))
        return unavailable(
          'conflicting_precedents',
          'A case contains multiple active decisions for an item and key'
        );
      itemKeys.add(itemKey);
      if (
        !record.decided_by ||
        record.basis.length === 0 ||
        (record.decided_by.on_behalf_of && !record.decided_by.on_behalf_of.evidence)
      ) {
        return unavailable(
          'missing_evidence',
          'A decided precedent lacks human provenance or basis'
        );
      }
      // Basis and bound_to are unordered sets; all optional source metadata stays hash-bound.
      record.basis.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
      if (record.bound_to) record.bound_to.sort(compare);
      const versionHash = judgmentCanonicalHash(record);
      const sourceKey = 'src-' + judgmentCanonicalHash([caseId, record.id]);
      const ref = decisionEvidenceRefSchema.safeParse({
        source_key: sourceKey,
        case_id: caseId,
        decision_id: record.id,
        decision_version_hash: versionHash,
        basis: record.basis.map(({ ref: basisRef, version }) => ({ ref: basisRef, version })),
      });
      if (!ref.success)
        return unavailable(
          'missing_evidence',
          'Decision reference exceeds the bounded adapter contract'
        );
      decisions.push({ source_key: sourceKey, record });
      evidenceRefs.push(ref.data);
      try {
        const resolved = deps.resolveGoals({
          case_id: caseId,
          decision_id: record.id,
          decision_version_hash: versionHash,
          source_key: sourceKey,
        });
        if (!Array.isArray(resolved) || resolved.length > 10)
          return unavailable(
            'missing_evidence',
            'Goal evidence exceeds the bounded adapter contract'
          );
        for (const rawGoal of resolved) {
          const goal = goalBindingSchema.parse(rawGoal);
          if (
            goal.case_id !== caseId ||
            goal.decision_id !== record.id ||
            goal.decision_version_hash !== versionHash
          ) {
            return unavailable(
              'missing_evidence',
              'Goal facts are not pinned to the current decision'
            );
          }
          goals.push(
            latencyGoalConstraintsSchema.parse({
              ...goal.constraints,
              decision_source_key: sourceKey,
            })
          );
        }
      } catch {
        return unavailable('missing_evidence', 'Structured goal evidence could not be verified');
      }
    }
  }
  if (decisions.length === 0)
    return unavailable('stale_precedent', 'No active decided precedent is available');
  if (decisions.length > 10 || goals.length === 0 || goals.length > 10) {
    return unavailable(
      'missing_evidence',
      'The bounded snapshot requires one to ten goals and precedents'
    );
  }
  if (new Set(goals.map((goal) => goal.goal_key)).size !== goals.length) {
    return unavailable('conflicting_precedents', 'Goal identifiers must be unambiguous');
  }
  const constraintsByTarget = new Map<string, string>();
  for (const { goal_key: _goalKey, decision_source_key: _sourceKey, ...constraints } of goals) {
    const target = canonicalJson([constraints.service_key, constraints.load_profile_hash]);
    const value = canonicalJson(constraints);
    const previous = constraintsByTarget.get(target);
    if (previous !== undefined && previous !== value) {
      return unavailable(
        'conflicting_precedents',
        'Active goal constraints conflict for the same service and load profile'
      );
    }
    constraintsByTarget.set(target, value);
  }
  decisions.sort((a, b) => compare(a.source_key, b.source_key));
  evidenceRefs.sort((a, b) => compare(a.source_key, b.source_key));
  goals.sort((a, b) => compare(a.goal_key, b.goal_key));
  const content = { scope, decisions, evidence_refs: evidenceRefs, goals };
  return {
    status: 'ready',
    snapshot: { ...content, scope_hash: scopeHash, snapshot_hash: judgmentCanonicalHash(content) },
  };
}
