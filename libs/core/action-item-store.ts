/**
 * Action Item Store — persists meeting-derived action items to the
 * mission's evidence directory and supports query / update operations.
 *
 * Schema authority: `schemas/action-item.schema.json`.
 *
 * Storage:
 *   active/missions/{tier}/{mission_id}/evidence/action-items.jsonl
 *   One JSON-encoded ActionItem per line. Append-only writes; status
 *   transitions update by appending a fresh line and recomputing the
 *   logical view at read time. This mirrors how `audit-chain` keeps
 *   storage simple and tamper-evident.
 *
 * Concurrency:
 *   Single-writer assumption (one mission, one orchestrator). Multi-
 *   writer scenarios should switch to a queue, not multi-process locks.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import {
  safeReadFile,
  safeAppendFileSync,
  safeMkdir,
  safeExistsSync,
} from './secure-io.js';

export type ActionItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export type ActionItemAssigneeKind =
  | 'operator_self'
  | 'team_member'
  | 'external'
  | 'unassigned';

export interface ActionItemAssignee {
  kind: ActionItemAssigneeKind;
  label: string;
  person_slug?: string;
  channel_handle?: string;
}

export type ActionItemReminderRelationship = 'primary' | 'cc_manager';

export interface ActionItemReminder {
  sent_at: string;
  channel: string;
  message?: string;
  audit_event_id?: string;
  /**
   * Whether this reminder was sent to the assignee directly (`primary`)
   * or copied to a chain-of-command channel (`cc_manager`). Defaults
   * to `primary` when absent. The reminder cap (`max_reminders`) is
   * applied to the union — a CC line still consumes the cap.
   */
  relationship?: ActionItemReminderRelationship;
}

export interface ActionItemExecution {
  executed_via: 'pipeline' | 'task_plan' | 'agent_delegate' | 'manual';
  execution_ref?: string;
  result_summary?: string;
}

export interface ActionItemMeetingRef {
  platform?: 'zoom' | 'teams' | 'meet' | 'auto';
  url?: string;
  transcript_path?: string;
  occurred_at?: string;
}

export type ActionItemModality =
  | 'declarative'
  | 'conditional'
  | 'hypothetical'
  | 'rhetorical'
  | 'humor';

export type ActionItemReviewState =
  | 'auto_committed'
  | 'pending_speaker_review'
  | 'speaker_confirmed'
  | 'speaker_rejected';

export interface ActionItemProvenance {
  speaker_label?: string;
  transcript_excerpt?: string;
  transcript_offset_lines?: number[];
  extractor?: {
    backend: string;
    model: string;
    extracted_at: string;
  };
}

/**
 * Policy-layer flags grouped on an action item. These are governance
 * concerns separate from the item's identity / content / status:
 *
 *   - `partial_state`         — Ops-3 fail-closed: item came from a
 *                                degraded transcript, hold execution
 *                                until an operator clears it.
 *   - `restricted`            — Compliance-2: the item title/summary
 *                                matched the restricted-action policy.
 *                                Self-execution requires an approval-gate
 *                                pass (KYBERION_RESTRICTED_APPROVED_ITEMS
 *                                or sudo).
 *   - `restriction_rule_id`   — Audit anchor for the restriction match.
 *   - `manager_handle`        — HR-2 chain-of-command CC channel.
 */
export interface ActionItemPolicy {
  partial_state?: boolean;
  restricted?: boolean;
  restriction_rule_id?: string;
  manager_handle?: string;
}

export interface ActionItem {
  item_id: string;
  mission_id: string;
  meeting_ref?: ActionItemMeetingRef;
  title: string;
  summary?: string;
  assignee: ActionItemAssignee;
  due_at?: string;
  status: ActionItemStatus;
  modality?: ActionItemModality;
  review_state?: ActionItemReviewState;
  provenance?: ActionItemProvenance;
  max_reminders?: number;
  /**
   * Governance / policy flags. Grouped here so the top-level item
   * shape stays focused on identity + content + status. The reducer
   * promotes legacy flat-form lines on read for backward compatibility.
   */
  policy?: ActionItemPolicy;
  priority?: 'must' | 'should' | 'could' | 'wont';
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  blocked_reason?: string;
  tenant_slug?: string;
  reminders?: ActionItemReminder[];
  execution?: ActionItemExecution;
}

export interface ActionItemLifecycleSummary {
  mission_id: string;
  total: number;
  by_status: Record<ActionItemStatus, number>;
  by_owner_kind: Record<ActionItemAssigneeKind, number>;
  blocked_items: Array<{
    item_id: string;
    owner_kind: ActionItemAssigneeKind;
    blocked_reason: string;
  }>;
}

const ITEM_ID_RE = /^AI-[A-Z0-9-]{2,40}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function storePathFor(missionId: string): string {
  const evidenceDir = pathResolver.missionEvidenceDir(missionId);
  if (!evidenceDir) {
    // Fall back to a writable evidence dir layout the caller can create.
    return pathResolver.rootResolve(
      `active/missions/confidential/${missionId}/evidence/action-items.jsonl`,
    );
  }
  return path.join(evidenceDir, 'action-items.jsonl');
}

/**
 * Promote legacy flat-form policy fields into the new `policy` shape.
 *
 * Pre-2026-04-27 lines have `partial_state` / `restricted` /
 * `restriction_rule_id` / `manager_handle` at the top level of the
 * record. We migrate them on read so the rest of the codebase only
 * has to reason about `item.policy`. Writers always emit the new
 * shape, so the legacy form is read-only.
 */
function migrateLegacyPolicy(raw: any): ActionItem {
  const item = raw as ActionItem & {
    partial_state?: boolean;
    restricted?: boolean;
    restriction_rule_id?: string;
    manager_handle?: string;
  };
  const legacyPresent =
    item.partial_state !== undefined ||
    item.restricted !== undefined ||
    item.restriction_rule_id !== undefined ||
    item.manager_handle !== undefined;
  if (!legacyPresent && !item.policy) return item as ActionItem;
  const policy: ActionItemPolicy = { ...(item.policy ?? {}) };
  if (item.partial_state !== undefined && policy.partial_state === undefined) {
    policy.partial_state = item.partial_state;
  }
  if (item.restricted !== undefined && policy.restricted === undefined) {
    policy.restricted = item.restricted;
  }
  if (item.restriction_rule_id !== undefined && policy.restriction_rule_id === undefined) {
    policy.restriction_rule_id = item.restriction_rule_id;
  }
  if (item.manager_handle !== undefined && policy.manager_handle === undefined) {
    policy.manager_handle = item.manager_handle;
  }
  const migrated: ActionItem = { ...(item as ActionItem) };
  delete (migrated as any).partial_state;
  delete (migrated as any).restricted;
  delete (migrated as any).restriction_rule_id;
  delete (migrated as any).manager_handle;
  if (Object.keys(policy).length > 0) migrated.policy = policy;
  return migrated;
}

function readAll(missionId: string): ActionItem[] {
  const file = storePathFor(missionId);
  if (!safeExistsSync(file)) return [];
  const text = safeReadFile(file, { encoding: 'utf8' }) as string;
  const events: ActionItem[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(migrateLegacyPolicy(JSON.parse(trimmed)));
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

/**
 * Compute the current logical view: latest record per item_id wins.
 */
function reduceLatest(items: ActionItem[]): Map<string, ActionItem> {
  const out = new Map<string, ActionItem>();
  for (const item of items) {
    out.set(item.item_id, item);
  }
  return out;
}

function appendRecord(missionId: string, record: ActionItem): void {
  const file = storePathFor(missionId);
  safeMkdir(path.dirname(file), { recursive: true });
  safeAppendFileSync(file, JSON.stringify(record) + '\n');
}

function validateBasic(item: ActionItem): void {
  if (!ITEM_ID_RE.test(item.item_id)) {
    throw new Error(`[action-item-store] invalid item_id '${item.item_id}'; expected ^AI-[A-Z0-9-]{4,40}$`);
  }
  if (!item.mission_id) throw new Error('[action-item-store] mission_id is required');
  if (!item.title || item.title.length < 5) {
    throw new Error('[action-item-store] title must be ≥ 5 chars');
  }
  if (!item.assignee || !item.assignee.kind || !item.assignee.label) {
    throw new Error('[action-item-store] assignee.kind and assignee.label are required');
  }
}

/**
 * Record a new action item. Throws if the item_id already exists for
 * this mission (use `updateActionItemStatus` for transitions).
 */
export function recordActionItem(item: Omit<ActionItem, 'created_at' | 'status'> & {
  created_at?: string;
  status?: ActionItemStatus;
}): ActionItem {
  const ts = nowIso();
  const full: ActionItem = {
    ...item,
    created_at: item.created_at ?? ts,
    updated_at: ts,
    status: item.status ?? 'pending',
  };
  validateBasic(full);
  const existing = reduceLatest(readAll(full.mission_id));
  if (existing.has(full.item_id)) {
    throw new Error(
      `[action-item-store] item_id '${full.item_id}' already exists in mission '${full.mission_id}'; use updateActionItemStatus`,
    );
  }
  appendRecord(full.mission_id, full);
  return full;
}

/**
 * Transition an existing item's status. Returns the updated record, or
 * null when the item_id is unknown.
 */
export function updateActionItemStatus(input: {
  mission_id: string;
  item_id: string;
  status: ActionItemStatus;
  execution?: ActionItemExecution;
  completed_at?: string;
  blocked_reason?: string;
}): ActionItem | null {
  const events = readAll(input.mission_id);
  const view = reduceLatest(events);
  const current = view.get(input.item_id);
  if (!current) return null;
  const updated: ActionItem = {
    ...current,
    status: input.status,
    updated_at: nowIso(),
    ...(input.completed_at ? { completed_at: input.completed_at } : {}),
    ...(input.status === 'completed' && !input.completed_at
      ? { completed_at: nowIso() }
      : {}),
    ...(input.status === 'blocked'
      ? { blocked_reason: input.blocked_reason ?? input.execution?.result_summary ?? 'blocked' }
      : {}),
    ...(input.execution ? { execution: { ...current.execution, ...input.execution } } : {}),
  };
  appendRecord(input.mission_id, updated);
  return updated;
}

/**
 * Append a reminder record to an existing item (idempotent on the
 * (item_id, sent_at, channel) tuple).
 */
export function appendReminder(input: {
  mission_id: string;
  item_id: string;
  reminder: ActionItemReminder;
}): ActionItem | null {
  const events = readAll(input.mission_id);
  const view = reduceLatest(events);
  const current = view.get(input.item_id);
  if (!current) return null;
  const reminders = current.reminders ?? [];
  if (
    reminders.some(
      (r) =>
        r.sent_at === input.reminder.sent_at &&
        r.channel === input.reminder.channel,
    )
  ) {
    return current;
  }
  const updated: ActionItem = {
    ...current,
    updated_at: nowIso(),
    reminders: [...reminders, input.reminder],
  };
  appendRecord(input.mission_id, updated);
  return updated;
}

/**
 * Return the current logical view of all action items in a mission.
 */
export function listActionItems(missionId: string): ActionItem[] {
  const view = reduceLatest(readAll(missionId));
  return Array.from(view.values()).sort((a, b) =>
    a.item_id.localeCompare(b.item_id),
  );
}

export function summarizeActionItemLifecycle(missionId: string): ActionItemLifecycleSummary {
  const items = listActionItems(missionId);
  const byStatus: Record<ActionItemStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  };
  const byOwnerKind: Record<ActionItemAssigneeKind, number> = {
    operator_self: 0,
    team_member: 0,
    external: 0,
    unassigned: 0,
  };
  const blockedItems: ActionItemLifecycleSummary['blocked_items'] = [];
  for (const item of items) {
    byStatus[item.status] += 1;
    byOwnerKind[item.assignee.kind] += 1;
    if (item.status === 'blocked') {
      blockedItems.push({
        item_id: item.item_id,
        owner_kind: item.assignee.kind,
        blocked_reason:
          item.blocked_reason ?? item.execution?.result_summary ?? 'blocked',
      });
    }
  }
  return {
    mission_id: missionId,
    total: items.length,
    by_status: byStatus,
    by_owner_kind: byOwnerKind,
    blocked_items: blockedItems,
  };
}

/**
 * Eligibility = "this item is allowed to auto-execute or auto-remind".
 *
 * Implemented as a list of guards rather than a chain of `if` so a
 * future finding can be added by appending one entry. A guard returns
 * `true` for "this guard does not block" and `false` for "this guard
 * blocks execution". An item is eligible iff every guard returns true.
 *
 * Each guard names the finding it backs so the audit trail is legible
 * (Ops-1 modality, Ops-3 partial-state, etc.).
 */
type EligibilityGuard = (item: ActionItem) => boolean;

const GUARDS: ReadonlyArray<{ name: string; check: EligibilityGuard }> = [
  {
    name: 'ops3.partial_state',
    check: (item) => item.policy?.partial_state !== true,
  },
  {
    name: 'ops1.speaker_rejected',
    check: (item) => (item.review_state ?? 'auto_committed') !== 'speaker_rejected',
  },
  {
    name: 'ops1.modality_review',
    check: (item) => {
      const modality = item.modality ?? 'declarative';
      const review = item.review_state ?? 'auto_committed';
      if (modality === 'declarative') {
        return review === 'auto_committed' || review === 'speaker_confirmed';
      }
      // Non-declarative items require explicit speaker confirmation.
      return review === 'speaker_confirmed';
    },
  },
];

function isEligibleForExecution(item: ActionItem): boolean {
  return GUARDS.every((g) => g.check(item));
}

/**
 * Convenience: items assigned to operator_self that are not yet done
 * AND eligible (declarative + speaker-acknowledged where required).
 */
export function listOperatorSelfPending(missionId: string): ActionItem[] {
  return listActionItems(missionId).filter(
    (item) =>
      item.assignee.kind === 'operator_self' &&
      item.status !== 'completed' &&
      item.status !== 'cancelled' &&
      isEligibleForExecution(item),
  );
}

/**
 * Convenience: items assigned to team_member that are not yet done,
 * eligible, AND below the per-item reminder cap (default 5).
 */
export function listOthersPending(missionId: string): ActionItem[] {
  return listActionItems(missionId).filter((item) => {
    if (item.assignee.kind !== 'team_member') return false;
    if (item.status === 'completed' || item.status === 'cancelled') return false;
    if (!isEligibleForExecution(item)) return false;
    const cap = item.max_reminders ?? 5;
    const sent = item.reminders?.length ?? 0;
    return sent < cap;
  });
}

/**
 * Items pending speaker review (modality != declarative). Surfaced by
 * the operator UI so the speaker can confirm or reject them before they
 * become actionable.
 */
export function listPendingSpeakerReview(missionId: string): ActionItem[] {
  return listActionItems(missionId).filter(
    (item) => (item.review_state ?? 'auto_committed') === 'pending_speaker_review',
  );
}

/**
 * Speaker-side confirmation of a pending item. Once confirmed, the item
 * becomes eligible for execute_self / track_pending.
 */
export function confirmActionItemBySpeaker(input: {
  mission_id: string;
  item_id: string;
  decision: 'speaker_confirmed' | 'speaker_rejected';
  note?: string;
}): ActionItem | null {
  const events = readAll(input.mission_id);
  const view = reduceLatest(events);
  const current = view.get(input.item_id);
  if (!current) return null;
  const updated: ActionItem = {
    ...current,
    review_state: input.decision,
    updated_at: nowIso(),
    ...(input.decision === 'speaker_rejected' ? { status: 'cancelled' as ActionItemStatus } : {}),
    ...(input.note ? { summary: `${current.summary ?? ''}\n[speaker_note] ${input.note}`.trim() } : {}),
  };
  appendRecord(input.mission_id, updated);
  return updated;
}

/**
 * Items quarantined as `partial_state=true` (Ops-3). Surfaced for
 * operator review; they are NOT eligible for self-execution or
 * tracking until cleared via `clearPartialState`.
 */
export function listPartialStatePending(missionId: string): ActionItem[] {
  return listActionItems(missionId).filter(
    (item) =>
      item.policy?.partial_state === true &&
      item.status !== 'completed' &&
      item.status !== 'cancelled',
  );
}

/**
 * Operator-side clear of the partial-state quarantine. Returns the
 * updated record, or null when the item is unknown.
 */
export function clearPartialState(input: {
  mission_id: string;
  item_id: string;
  note?: string;
}): ActionItem | null {
  const events = readAll(input.mission_id);
  const view = reduceLatest(events);
  const current = view.get(input.item_id);
  if (!current) return null;
  const updated: ActionItem = {
    ...current,
    policy: { ...(current.policy ?? {}), partial_state: false },
    updated_at: nowIso(),
    ...(input.note
      ? { summary: `${current.summary ?? ''}\n[partial_clear] ${input.note}`.trim() }
      : {}),
  };
  appendRecord(input.mission_id, updated);
  return updated;
}

/**
 * Items flagged `policy.restricted=true` (Compliance-2). Self-execution
 * requires an approval-gate pass — see `restricted-action-kinds-policy.json`.
 */
export function listRestrictedPending(missionId: string): ActionItem[] {
  return listActionItems(missionId).filter(
    (item) =>
      item.policy?.restricted === true &&
      item.status !== 'completed' &&
      item.status !== 'cancelled',
  );
}

/**
 * Generate a deterministic next item_id for a mission. Useful when the
 * caller wants ids to be stable / reproducible during testing.
 */
export function nextActionItemId(missionId: string, hint?: string): string {
  const existing = listActionItems(missionId);
  const n = existing.length + 1;
  const suffix = hint
    ? hint.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    : '';
  return `AI-${missionId.replace(/^MSN-/, '')}-${n}${suffix ? `-${suffix}` : ''}`.slice(0, 40);
}
