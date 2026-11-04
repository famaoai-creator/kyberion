/**
 * Needs-you queue — the single definition of "what is waiting for a person".
 *
 * Every surface that shows a count of things to decide reads it from here
 * (contract MSN-SHELL-IA-20261105 §2). Before this module the approval store
 * was read four ways and the screens disagreed (6 / 7 / 43 / 2 / 0 at the same
 * moment), because each one counted something different.
 *
 * ## Count definition (the only one)
 *
 * An item is **open** when all of these hold:
 *   1. it is pending — an approval with status pending whose brief state is
 *      `pending`, a deliverable entry still `unread` / `read`, a memory
 *      candidate still `queued`, a stalled mission still in the hygiene report,
 *      or an exception notification still in an attention status;
 *   2. it is not expired — an approval past its expiry (brief state
 *      `expired`) is gone from the queue; the approval store expires it;
 *   3. it is inside the viewer's server-side scope — the readers admit only
 *      what the viewer may see, and this builder re-checks every item that
 *      names a tenant / organization / project against the viewer, then
 *      applies the client's narrowing (`tenant`, `organization_id`,
 *      `project_id`), which can only remove items;
 *   4. it is deduplicated by decision group — identical approvals (same
 *      `DecisionBrief.groupKey`) fold into one item that keeps the others
 *      decidable inside it and carries the group's true size.
 *
 * `total` = the number of open items after (1)–(4), i.e. folded groups count
 * once. `group_size` on each item says how many records it stands for, so a
 * surface can still say "同じ依頼が 3 件" (review follow-up U4).
 *
 * **Overdue** = the item's deadline has passed, or it has no deadline and has
 * waited longer than {@link NEEDS_YOU_OVERDUE_AFTER_MS} (3 days).
 *
 * Pure apart from {@link readNeedsYouSources}, the default store reader used
 * by MCP; the unified shell passes its own reader (personal approvals,
 * publication previews) through the same builder.
 */

import type { CeoApprovalItem, CeoExceptionItem, CeoOutcomeItem } from '../ceo-surface-summary.js';
import { compareDecisionUrgency, groupByDecision } from './decision-brief.js';
import type { DisplayText } from './display-humanize.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';

export const NEEDS_YOU_REASONS = [
  'approval',
  'decision',
  'review',
  'knowledge',
  'clarification',
  'failure',
] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

/** The actions a card may offer; each item lists only those that apply. */
export type NeedsYouAction = 'approve' | 'reject' | 'request_changes' | 'later' | 'open';

/** An item without a deadline becomes overdue after waiting this long. */
export const NEEDS_YOU_OVERDUE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Deliverable inbox kinds that are customer-decision hand-offs (CD-11), not reviews. */
const DECISION_INBOX_KINDS = new Set([
  'customer_decision_handoff',
  'customer_decision_manual_reminder',
]);
const OPEN_INBOX_STATUSES = new Set(['unread', 'read']);
const AGENT_REQUESTER_KEYS = new Set([
  'ux_a_actor_agent',
  'ux_a_actor_dot',
  'ux_a_actor_pipeline',
  'ux_a_actor_automation',
]);

export interface NeedsYouKnowledgeInput {
  id: string;
  candidateKey?: string;
  learningReviewUrl?: string;
  kind: string;
  summary: string;
  source: string;
  source_type?: string;
  sensitivity_tier: string;
  occurrences: number;
  queued_at: string;
  status?: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}

export interface NeedsYouClarificationInput {
  mission_id: string;
  title: string;
  reason: string;
  tier?: string;
  tenant_slug?: string;
  organization_id?: string;
  age_days: number | null;
  waiting_since?: string;
}

export type NeedsYouOutcomeInput = CeoOutcomeItem;
export type NeedsYouFailureInput = CeoExceptionItem & { tenant_slug?: string };

/** What the readers return, already admitted for the viewer. */
export interface NeedsYouSourceData {
  approvals: readonly CeoApprovalItem[];
  outcomes: readonly NeedsYouOutcomeInput[];
  knowledge: readonly NeedsYouKnowledgeInput[];
  clarifications: readonly NeedsYouClarificationInput[];
  failures: readonly NeedsYouFailureInput[];
}

export interface NeedsYouItem {
  /** Stable, reason-prefixed id (`approval:<channel>/<id>`, `review:<entry>` …). */
  id: string;
  reason: NeedsYouReason;
  /** One-sentence ask. */
  title: DisplayText;
  /** Who asks; `agent` is true when the asker is an agent or automation. */
  requester: { label: DisplayText; agent: boolean };
  mission_id?: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  waiting_since?: string;
  deadline?: string;
  overdue: boolean;
  actions: NeedsYouAction[];
  /** How many records this item stands for (1 unless identical approvals were folded). */
  group_size: number;
  /** The folded identical approvals, each still decidable on its own. */
  group?: NeedsYouItem[];
  /** The source record for the kind's governed write endpoint and card body. */
  approval?: CeoApprovalItem;
  outcome?: NeedsYouOutcomeInput;
  knowledge?: NeedsYouKnowledgeInput;
  clarification?: NeedsYouClarificationInput;
  failure?: NeedsYouFailureInput;
}

export type NeedsYouByReason = Record<NeedsYouReason, number>;

export interface NeedsYouSummary {
  ok: true;
  total: number;
  overdue: number;
  oldestWaitingSince?: string;
  byReason: NeedsYouByReason;
}

/** Client narrowing. It can only remove items; it never widens the viewer. */
export interface NeedsYouNarrowing {
  tenant?: string;
  organization_id?: string;
  project_id?: string;
}

export type NeedsYouViewerScope = Pick<
  SurfaceAuthorizationContext,
  'tenantSlugs' | 'organizationIds' | 'projectIds'
>;

function ms(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isOverdue(deadline: string | undefined, waitingSince: string | undefined, now: number) {
  const due = ms(deadline);
  if (Number.isFinite(due)) return due < now;
  const since = ms(waitingSince);
  return Number.isFinite(since) && now - since > NEEDS_YOU_OVERDUE_AFTER_MS;
}

function text(value: string | undefined, fallbackKey: string): DisplayText {
  const trimmed = String(value ?? '').trim();
  return trimmed ? { text: trimmed } : { key: fallbackKey };
}

const AGENT: NeedsYouItem['requester'] = {
  label: { key: 'ia_inbox_requester_agent' },
  agent: true,
};

function approvalOpen(item: CeoApprovalItem, now: number): boolean {
  if (item.brief) return item.brief.state === 'pending';
  const expires = ms(item.expires_at);
  return !(Number.isFinite(expires) && expires <= now);
}

function fromApproval(item: CeoApprovalItem, now: number): NeedsYouItem {
  const requesterLabel = item.brief?.requester ?? { key: 'ux_a_actor_automation' };
  const deadline = item.brief?.deadline ?? item.expires_at;
  return {
    id: `approval:${item.storage_channel}/${item.id}`,
    reason: 'approval',
    title: item.brief?.ask ?? text(item.title, 'ux_a_generic_ask_unnamed'),
    requester: {
      label: requesterLabel,
      agent: 'key' in requesterLabel && AGENT_REQUESTER_KEYS.has(requesterLabel.key),
    },
    ...(item.mission_id ? { mission_id: item.mission_id } : {}),
    ...(item.tenant_slug ? { tenant_slug: item.tenant_slug } : {}),
    ...(item.organization_id ? { organization_id: item.organization_id } : {}),
    ...(item.requested_at ? { waiting_since: item.requested_at } : {}),
    ...(deadline ? { deadline } : {}),
    overdue: isOverdue(deadline, item.requested_at, now),
    actions: ['approve', 'reject', 'later'],
    group_size: 1,
    approval: item,
  };
}

function fromOutcome(item: NeedsYouOutcomeInput, now: number): NeedsYouItem {
  const decision = DECISION_INBOX_KINDS.has(String(item.kind ?? ''));
  return {
    id: `${decision ? 'decision' : 'review'}:${item.entry_id}`,
    reason: decision ? 'decision' : 'review',
    title: text(item.title, decision ? 'ia_inbox_decision_title' : 'ia_inbox_review_title'),
    requester: decision ? { label: { key: 'ia_inbox_requester_customer' }, agent: false } : AGENT,
    ...(item.mission_id ? { mission_id: item.mission_id } : {}),
    ...(item.tenant_slug ? { tenant_slug: item.tenant_slug } : {}),
    ...(item.updated_at ? { waiting_since: item.updated_at } : {}),
    overdue: isOverdue(undefined, item.updated_at, now),
    actions: decision
      ? ['open', 'later']
      : [
          'approve',
          'request_changes',
          'reject',
          ...(item.artifact_paths.length ? ['open' as const] : []),
          'later',
        ],
    group_size: 1,
    outcome: item,
  };
}

function fromKnowledge(item: NeedsYouKnowledgeInput, now: number): NeedsYouItem {
  return {
    id: `knowledge:${item.candidateKey ?? item.id}`,
    reason: 'knowledge',
    title: { key: 'ia_inbox_knowledge_title' },
    requester: AGENT,
    ...(item.tenant_slug ? { tenant_slug: item.tenant_slug } : {}),
    ...(item.organization_id ? { organization_id: item.organization_id } : {}),
    ...(item.project_id ? { project_id: item.project_id } : {}),
    ...(item.queued_at ? { waiting_since: item.queued_at } : {}),
    overdue: isOverdue(undefined, item.queued_at, now),
    // A scoped SOP is curated in the knowledge library, not decided here.
    actions: item.learningReviewUrl ? ['open', 'later'] : ['approve', 'reject', 'later'],
    group_size: 1,
    knowledge: item,
  };
}

function fromClarification(item: NeedsYouClarificationInput, now: number): NeedsYouItem {
  return {
    id: `clarification:${item.mission_id}`,
    reason: 'clarification',
    title: text(item.title, 'ia_inbox_clarification_title'),
    requester: AGENT,
    mission_id: item.mission_id,
    ...(item.tenant_slug ? { tenant_slug: item.tenant_slug } : {}),
    ...(item.organization_id ? { organization_id: item.organization_id } : {}),
    ...(item.waiting_since ? { waiting_since: item.waiting_since } : {}),
    overdue: isOverdue(undefined, item.waiting_since, now),
    actions: ['approve', 'reject', 'later'],
    group_size: 1,
    clarification: item,
  };
}

function fromFailure(item: NeedsYouFailureInput, now: number): NeedsYouItem {
  return {
    id: `failure:${item.id}`,
    reason: 'failure',
    title: text(item.title, 'ia_inbox_failure_title'),
    requester: AGENT,
    ...(item.tenant_slug ? { tenant_slug: item.tenant_slug } : {}),
    ...(item.created_at ? { waiting_since: item.created_at } : {}),
    overdue: isOverdue(undefined, item.created_at, now),
    actions: ['later'],
    group_size: 1,
    failure: item,
  };
}

function within(allowed: readonly string[] | 'all', value: string | undefined): boolean {
  return allowed === 'all' || !value || allowed.includes(value);
}

/**
 * Viewer re-check plus client narrowing. An item that names a tenant /
 * organization / project outside the viewer is dropped (defense in depth: the
 * readers already admit by scope). A narrowing value keeps only items that
 * name exactly that value; a narrowing value outside the viewer matches
 * nothing, so the client can never widen the result.
 */
export function narrowNeedsYouItem(
  item: Pick<NeedsYouItem, 'tenant_slug' | 'organization_id' | 'project_id'>,
  viewer: NeedsYouViewerScope,
  narrowing: NeedsYouNarrowing = {}
): boolean {
  if (!within(viewer.tenantSlugs, item.tenant_slug)) return false;
  if (!within(viewer.organizationIds, item.organization_id)) return false;
  if (!within(viewer.projectIds, item.project_id)) return false;
  if (narrowing.tenant) {
    if (!within(viewer.tenantSlugs, narrowing.tenant)) return false;
    if (item.tenant_slug !== narrowing.tenant) return false;
  }
  if (narrowing.organization_id) {
    if (!within(viewer.organizationIds, narrowing.organization_id)) return false;
    if (item.organization_id !== narrowing.organization_id) return false;
  }
  if (narrowing.project_id) {
    if (!within(viewer.projectIds, narrowing.project_id)) return false;
    if (item.project_id !== narrowing.project_id) return false;
  }
  return true;
}

const REASON_RANK: Record<NeedsYouReason, number> = {
  approval: 0,
  decision: 1,
  clarification: 2,
  knowledge: 3,
  review: 4,
  failure: 5,
};

/** Overdue first, then reason urgency, then oldest wait first. */
function compareItems(a: NeedsYouItem, b: NeedsYouItem): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const byReason = REASON_RANK[a.reason] - REASON_RANK[b.reason];
  if (byReason) return byReason;
  return String(a.waiting_since ?? '').localeCompare(String(b.waiting_since ?? ''));
}

/** The open, deduplicated, scope-narrowed queue in urgency order. */
export function buildNeedsYouQueue(
  data: NeedsYouSourceData,
  options: { viewer: NeedsYouViewerScope; narrowing?: NeedsYouNarrowing; now?: number }
): NeedsYouItem[] {
  const now = options.now ?? Date.now();
  const keep = (item: NeedsYouItem) => narrowNeedsYouItem(item, options.viewer, options.narrowing);

  const approvals = [...data.approvals]
    .filter((item) => approvalOpen(item, now))
    .sort(compareDecisionUrgency)
    .map((item) => fromApproval(item, now))
    .filter(keep);
  const folded = groupByDecision(
    approvals.map((item) => ({ item, brief: item.approval?.brief }))
  ).map(({ lead, others }) =>
    others.length
      ? {
          ...lead.item,
          overdue: lead.item.overdue || others.some(({ item }) => item.overdue),
          group_size: others.length + 1,
          group: others.map(({ item }) => item),
        }
      : lead.item
  );

  const rest = [
    ...data.outcomes
      .filter((item) => OPEN_INBOX_STATUSES.has(String(item.status)))
      .map((item) => fromOutcome(item, now)),
    ...data.knowledge
      .filter((item) => !item.status || item.status === 'queued')
      .map((item) => fromKnowledge(item, now)),
    ...data.clarifications.map((item) => fromClarification(item, now)),
    ...data.failures.map((item) => fromFailure(item, now)),
  ].filter(keep);

  const seen = new Set<string>();
  return [...folded, ...rest]
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .sort(compareItems);
}

export function emptyNeedsYouByReason(): NeedsYouByReason {
  return Object.fromEntries(NEEDS_YOU_REASONS.map((reason) => [reason, 0])) as NeedsYouByReason;
}

/** The summary every count on every surface comes from. */
export function summarizeNeedsYou(items: readonly NeedsYouItem[]): NeedsYouSummary {
  const byReason = emptyNeedsYouByReason();
  let overdue = 0;
  let oldest: string | undefined;
  for (const item of items) {
    byReason[item.reason] += 1;
    if (item.overdue) overdue += 1;
    const waits = [item.waiting_since, ...(item.group ?? []).map((other) => other.waiting_since)];
    for (const since of waits) {
      if (since && Number.isFinite(ms(since)) && (!oldest || ms(since) < ms(oldest)))
        oldest = since;
    }
  }
  return {
    ok: true,
    total: items.length,
    overdue,
    ...(oldest ? { oldestWaitingSince: oldest } : {}),
    byReason,
  };
}

export interface NeedsYouPageQuery {
  reason?: NeedsYouReason;
  overdue?: boolean;
  cursor?: string;
  limit?: number;
}

export interface NeedsYouPage {
  ok: true;
  items: NeedsYouItem[];
  /** Open items matching the reason / overdue filters (before paging). */
  total: number;
  nextCursor?: string;
}

export const NEEDS_YOU_DEFAULT_LIMIT = 50;

/** Filters (reason, overdue) then pages with an opaque offset cursor. */
export function pageNeedsYou(
  items: readonly NeedsYouItem[],
  query: NeedsYouPageQuery = {}
): NeedsYouPage {
  const filtered = items.filter(
    (item) => (!query.reason || item.reason === query.reason) && (!query.overdue || item.overdue)
  );
  const offset = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10) || 0) : 0;
  const limit = query.limit ?? NEEDS_YOU_DEFAULT_LIMIT;
  const page = filtered.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    ok: true,
    items: page,
    total: filtered.length,
    ...(next < filtered.length ? { nextCursor: String(next) } : {}),
  };
}
