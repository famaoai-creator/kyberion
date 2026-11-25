/**
 * Chief-of-Staff attention triage over the viewer-scoped Needs-you queue.
 *
 * Pure and display-only: never reads stores, never alters authorization scope,
 * and never invents decisions. Operates solely on already-scoped `NeedsYouItem[]`
 * with zero Node-only imports so both CLI and browser surfaces can share it.
 */

import type { DecisionBriefRisk } from './decision-brief.js';
import type { NeedsYouItem, NeedsYouReason } from './needs-you.js';

export type AttentionBucket = 'now' | 'today' | 'batch';

export type AttentionReasonKey =
  | 'ia_inbox_triage_overdue'
  | 'ia_inbox_triage_deadline_soon'
  | 'ia_inbox_triage_high_risk'
  | 'ia_inbox_triage_blocking'
  | 'ia_inbox_triage_grouped'
  | 'ia_inbox_triage_aging';

export interface AttentionTriagedItem {
  item: NeedsYouItem;
  score: number;
  bucket: AttentionBucket;
  estimated_minutes: number;
  reasons: AttentionReasonKey[];
}

export interface AttentionTriagePlan {
  focus: AttentionTriagedItem[];
  now_items: AttentionTriagedItem[];
  today_items: AttentionTriagedItem[];
  batch_items: AttentionTriagedItem[];
  all_items: AttentionTriagedItem[];
  total_items: number;
  total_underlying_records: number;
  focus_clears_records: number;
  estimated_total_minutes: number;
  estimated_focus_minutes: number;
}

export interface TriageNeedsYouOptions {
  now?: number;
  focusLimit?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_FOCUS_LIMIT = 3;

const REASON_WEIGHT: Record<NeedsYouReason, number> = {
  approval: 15,
  decision: 15,
  clarification: 15,
  failure: 12,
  review: 8,
  knowledge: 3,
};

const REASON_MINUTES: Record<NeedsYouReason, number> = {
  approval: 2,
  decision: 3,
  clarification: 3,
  failure: 4,
  review: 5,
  knowledge: 2,
};

function parseMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scoreItem(item: NeedsYouItem, now: number): AttentionTriagedItem {
  let raw = REASON_WEIGHT[item.reason];
  const reasons: AttentionReasonKey[] = [];

  if (item.overdue) {
    raw += 40;
    reasons.push('ia_inbox_triage_overdue');
  }

  const deadlineMs = parseMs(item.deadline);
  if (!item.overdue && Number.isFinite(deadlineMs)) {
    const remainingMs = deadlineMs - now;
    if (remainingMs <= 4 * HOUR_MS) {
      raw += 30;
      reasons.push('ia_inbox_triage_deadline_soon');
    } else if (remainingMs <= DAY_MS) {
      raw += 15;
      reasons.push('ia_inbox_triage_deadline_soon');
    }
  }

  const risk: DecisionBriefRisk | undefined = item.approval?.brief?.risk;
  if (risk === 'critical' || risk === 'high') {
    raw += 20;
    reasons.push('ia_inbox_triage_high_risk');
  } else if (risk === 'medium') {
    raw += 10;
  }

  if (
    item.reason === 'approval' ||
    item.reason === 'decision' ||
    item.reason === 'clarification' ||
    item.reason === 'failure'
  ) {
    reasons.push('ia_inbox_triage_blocking');
  }

  const groupSize = Math.max(1, item.group_size || 1);
  if (groupSize > 1) {
    raw += Math.min(12, (groupSize - 1) * 4);
    reasons.push('ia_inbox_triage_grouped');
  }

  const waitingMs = parseMs(item.waiting_since);
  if (Number.isFinite(waitingMs) && now > waitingMs) {
    const waitHours = (now - waitingMs) / HOUR_MS;
    if (waitHours >= 24) {
      raw += Math.min(10, Math.floor(waitHours / 24) * 3);
      if (waitHours >= 48 && !item.overdue) {
        reasons.push('ia_inbox_triage_aging');
      }
    }
  }

  const score = Math.min(100, Math.max(1, raw));
  const bucket: AttentionBucket =
    item.overdue || score >= 60 || risk === 'critical' || risk === 'high'
      ? 'now'
      : score >= 22
        ? 'today'
        : 'batch';

  const estimated_minutes = REASON_MINUTES[item.reason] + Math.min(3, groupSize - 1);

  return {
    item,
    score,
    bucket,
    estimated_minutes,
    reasons,
  };
}

function compareTriaged(a: AttentionTriagedItem, b: AttentionTriagedItem): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.item.overdue !== b.item.overdue) return a.item.overdue ? -1 : 1;
  const aDeadline = parseMs(a.item.deadline);
  const bDeadline = parseMs(b.item.deadline);
  if (Number.isFinite(aDeadline) !== Number.isFinite(bDeadline)) {
    return Number.isFinite(aDeadline) ? -1 : 1;
  }
  if (Number.isFinite(aDeadline) && Number.isFinite(bDeadline) && aDeadline !== bDeadline) {
    return aDeadline - bDeadline;
  }
  const waitOrder = compareStrings(a.item.waiting_since ?? '', b.item.waiting_since ?? '');
  if (waitOrder !== 0) return waitOrder;
  return compareStrings(a.item.id, b.item.id);
}

/**
 * Prioritize viewer-admitted `NeedsYouItem[]` into `now` / `today` / `batch`
 * buckets and select the top `focusLimit` (default 3) items for Focus Mode.
 */
export function triageNeedsYouAttention(
  items: readonly NeedsYouItem[],
  options: TriageNeedsYouOptions = {}
): AttentionTriagePlan {
  const now = options.now ?? Date.now();
  const focusLimit = Math.max(0, Math.floor(options.focusLimit ?? DEFAULT_FOCUS_LIMIT));
  const scored = items.map((item) => scoreItem(item, now)).sort(compareTriaged);

  const now_items = scored.filter((entry) => entry.bucket === 'now');
  const today_items = scored.filter((entry) => entry.bucket === 'today');
  const batch_items = scored.filter((entry) => entry.bucket === 'batch');
  const focus = scored.slice(0, focusLimit);

  const sumRecords = (list: readonly AttentionTriagedItem[]) =>
    list.reduce((acc, entry) => acc + Math.max(1, entry.item.group_size || 1), 0);
  const sumMinutes = (list: readonly AttentionTriagedItem[]) =>
    list.reduce((acc, entry) => acc + entry.estimated_minutes, 0);

  return {
    focus,
    now_items,
    today_items,
    batch_items,
    all_items: scored,
    total_items: scored.length,
    total_underlying_records: sumRecords(scored),
    focus_clears_records: sumRecords(focus),
    estimated_total_minutes: sumMinutes(scored),
    estimated_focus_minutes: sumMinutes(focus),
  };
}
