/**
 * Dot state paths and row contracts for the resident-dot organization loop.
 *
 * Domain root `active/shared/runtime/dot/`. Untenanted dots write straight
 * under it; tenant dots are placed under the physical tenant namespace so
 * tenant prose (memory, follow-up reasons, event bodies, work results) never
 * lands in system-floor files. Existing flat ledgers (`dot-*.jsonl`) stay put.
 */

import { physicalScopedPath } from '../physical-namespace.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDecisionLevel, DotProposal } from './dot-proposals.js';

export const DOT_STATE_ROOT = 'active/shared/runtime/dot';

/** Repo-relative path under the dot state domain for this charter's scope. */
export function dotStatePath(charter: DotCharter, ...parts: string[]): string {
  const { tenant_slug, organization_id } = charter.scope;
  if (!tenant_slug) return [DOT_STATE_ROOT, ...parts].join('/');
  return physicalScopedPath(DOT_STATE_ROOT, { tenant_slug, organization_id }, ...parts);
}

export const DOT_WORK_RESULTS_FILE = 'work-results.jsonl';
export const DOT_KR_LEDGER_FILE = 'kr-ledger.jsonl';
export const DOT_ORG_KR_LEDGER_FILE = 'org-kr-ledger.jsonl';
export const DOT_OUTCOMES_FILE = 'outcomes.jsonl';
export const DOT_OUTCOME_PENDING_FILE = 'outcome-pending.jsonl';
export const DOT_FOLLOWUPS_FILE = 'followups.jsonl';
export const DOT_EVENTS_FILE = 'events.jsonl';
export const DOT_MEMORY_DIR = 'memory';
export const DOT_MEMORY_DISTILL_FILE = 'memory-distill.jsonl';
export const DOT_AUTONOMY_DIR = 'autonomy';
export const DOT_AUTONOMY_SHADOW_FILE = 'autonomy-shadow.jsonl';
export const DOT_ARBITRATION_FILE = 'arbitration.jsonl';

export const dotMemoryPath = (charter: DotCharter): string =>
  dotStatePath(charter, DOT_MEMORY_DIR, `${charter.dot_id}.json`);
export const dotAutonomyStatePath = (charter: DotCharter): string =>
  dotStatePath(charter, DOT_AUTONOMY_DIR, `${charter.dot_id}.json`);

/** DL-01: one executed (or refused) delegated work item. */
export interface DotWorkResultRow {
  dot_id: string;
  work_item_id: string;
  action_ref: string;
  attempt_id?: string;
  mode: 'goal_turn' | 'delegated' | 'pipeline' | 'escalated';
  status: 'done' | 'blocked' | 'failed' | 'skipped';
  /** At most 600 chars. */
  summary: string;
  started_at: string;
  completed_at: string;
  tokens_used?: number;
  /** Persisted before releasing work so report recovery survives a missing WorkItem. */
  report_to_dot_id?: string;
  /** Durable inbox receipt observed; suppresses re-delivery after inbox retention. */
  report_enqueued_at?: string;
  kr_snapshot?: Record<string, number>;
  /** Latest health (1 healthy / 0) per signal, captured at claim time — the "before" of a signal effect. */
  signal_snapshot?: Record<string, 0 | 1>;
}

/** DL-03: one key-result measurement. */
export interface KrMeasurementRow {
  scope: 'dot' | 'org';
  dot_id?: string;
  organization_id?: string;
  objective_id?: string;
  kr_id: string;
  value: number;
  progress: number;
  measured_at: string;
}

/** DL-04: verdict on whether a completed action moved its KR/signal. */
export interface DotOutcomeRow {
  dot_id: string;
  action_ref: string;
  work_item_id: string;
  ref: { kr_id?: string; signal?: string };
  before?: number;
  after?: number;
  verdict: 'improved' | 'no_change' | 'regressed' | 'unmeasurable';
  due_at: string;
  measured_at: string;
}

/** DL-05: per-dot working memory document. */
export interface DotMemoryDoc {
  dot_id: string;
  version: 1;
  updated_at: string;
  /** Durable ID high-water marks, retained when entries are removed or evicted. */
  last_ids?: { n: number; i: number; h: number };
  notes: Array<{ id: string; text: string; at: string }>;
  open_items: Array<{
    id: string;
    text: string;
    status: 'open' | 'closed';
    due?: string;
    at: string;
  }>;
  hypotheses: Array<{
    id: string;
    text: string;
    confidence: number;
    status: 'open' | 'confirmed' | 'refuted';
    at: string;
  }>;
}

/** DL-09: a self-scheduled follow-up wake. */
export interface DotFollowupRow {
  followup_id: string;
  dot_id: string;
  due_at: string;
  reason: string;
  created_at: string;
  /** A committed successor consumes this parent independently of wake-ledger delivery. */
  replaces_followup_id?: string;
}

/** DL-08: a normalized inbound event, as stored in `events.jsonl`. */
export interface DotInboundEvent {
  event_id: string;
  source: string;
  type: string;
  delivery_id: string;
  /** Only ever set from intake policy, never from the payload. */
  tenant_slug?: string;
  received_at: string;
  summary: string;
  payload_digest: string;
  /** At most 16 KB serialized. */
  payload: unknown;
}

/** DL-10: autonomy ladder level. */
export type DotAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export const DOT_AUTONOMY_LEVELS: readonly DotAutonomyLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface DotAutonomyState {
  level: DotAutonomyLevel;
  since: string;
  history: Array<{ level: DotAutonomyLevel; at: string; reason: string }>;
}

/**
 * DL-11: one arbitration decision between two dots' proposals. Pre-gate rows
 * know the newcomer only by `proposal_hash` (its action_ref is assigned after
 * the check); settlement rows (`superseded` / `declined`) carry `action_ref`.
 */
export interface DotArbitrationRow {
  at: string;
  dot_id: string;
  proposal_hash: string;
  action_ref?: string;
  conflicts_with: { dot_id: string; action_ref: string };
  target?: string;
  intent?: DotProposal['intent'];
  resolution:
    'proceed' | 'defer_to_owner' | 'defer_to_priority' | 'escalated' | 'superseded' | 'declined';
  floor?: DotDecisionLevel;
  reason: string;
}
