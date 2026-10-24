/**
 * Customer decision hearing (CD-01, plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md).
 *
 * The "request and display" layer that sits ON the SSOD decision ledger
 * (`libs/core/decision-ledger/`). The decision values themselves live in the
 * ledger; this module adds:
 *
 *   - the decision agenda (調整セット): what we ask the customer, with options,
 *     their impact, the layer order, and our approved provisional decision;
 *   - the decision receipt (決定記録): who answered which approved revision;
 *   - the decision switch (切り替わり): the effective decision changed;
 *   - the consumed-decision lock: what a task used, checked at task boundaries.
 *
 * Nothing in this file touches disk.
 */
export type AgendaEntryKind = 'choice' | 'approval' | 'ranking' | 'hearing';
export const AGENDA_ENTRY_KINDS: readonly AgendaEntryKind[] = [
  'choice',
  'approval',
  'ranking',
  'hearing',
];

export type DecisionLayerName = 'customer' | 'ours' | 'org_default';
/** Default layer order: customer decision > our decision > organization default. */
export const DEFAULT_DECISION_LAYERS: readonly DecisionLayerName[] = [
  'customer',
  'ours',
  'org_default',
];

export interface AgendaOptionImpact {
  cost?: string;
  schedule?: string;
  scope?: string;
  rework?: string;
}

export interface AgendaOption {
  value: unknown;
  label: string;
  impact?: AgendaOptionImpact;
}

/** Image media types an agenda entry may attach (CD-10 bolt review). */
export type AgendaAttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export const AGENDA_ATTACHMENT_MEDIA_TYPES: readonly AgendaAttachmentMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/**
 * An image shown with an entry (a screenshot of the bolt's result). The bytes
 * live in the case (`attachments/<id>.<ext>`); `id` is their sha256, so the
 * content hash of the agenda binds the exact image the customer saw.
 */
export interface AgendaAttachment {
  /** sha256 hex of the bytes. */
  id: string;
  name: string;
  media_type: AgendaAttachmentMediaType;
  bytes: number;
}

/** An external link shown with an entry (a public preview URL; https only). */
export interface AgendaLink {
  label: string;
  url: string;
}

export interface AgendaEntry {
  entry_id: string;
  item: string;
  key: string;
  kind: AgendaEntryKind;
  question: string;
  background?: string;
  options?: AgendaOption[];
  layers?: DecisionLayerName[];
  /** `decision_id` is pinned at approval; it is excluded from the content hash. */
  our_decision?: { value: unknown; rationale?: string; decision_id?: string };
  org_default?: { value: unknown; source: string };
  requires_customer: boolean;
  override_until?: { kind: 'date'; at: string } | { kind: 'milestone'; milestone: string };
  /** CD-10: images shown with the entry. In the content hash. */
  attachments?: AgendaAttachment[];
  /** CD-10: external links shown with the entry. In the content hash. */
  links?: AgendaLink[];
}

export type AgendaStatus =
  'draft' | 'pending_approval' | 'approved' | 'sent' | 'closed' | 'withdrawn';
export const AGENDA_STATUSES: readonly AgendaStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'closed',
  'withdrawn',
];

export interface DecisionAgenda {
  version: '1.0.0';
  agenda_id: string;
  tenant_slug: string;
  case_id: string;
  customer: string;
  title: string;
  /** Who the request is from, as the customer sees it. In the content hash when present. */
  from?: string;
  phase: string;
  revision: number;
  locale: 'ja' | 'en';
  deal_id?: string;
  project_id?: string;
  /**
   * CD-11: the date the customer is asked to answer by (`YYYY-MM-DD`, a UTC
   * calendar date). Shown to the customer, so in the content hash when set.
   * Reminders go out the day before and on the day.
   */
  respond_by?: string;
  entries: AgendaEntry[];
  status: AgendaStatus;
  approval?: {
    content_hash: string;
    request_id?: string;
    approved_at: string;
    approved_by: string;
  };
  /**
   * Our decisions in force: the pins of the last approval. Editing the agenda
   * removes `approval` but keeps this, so the approved ledger records stay in
   * force (the unapproved edit itself is not) until the edit is re-approved.
   */
  in_force?: {
    content_hash: string;
    approved_at: string;
    pinned_ids: string[];
  };
  milestones_passed?: string[];
  /**
   * CD-10: the mission (bolt) this agenda reviews. Set by
   * `customer-decision bolt-review`; outside the content hash (it is not
   * shown to the customer). The next mission of the case passes the
   * `bolt-after:<id>` milestone when it starts.
   */
  bolt_mission_id?: string;
  /**
   * CD-10: where the customer's bolt-review answers went (a backlog WorkItem
   * for `request_changes`, an operator notification for `reject`). Ids only,
   * outside the content hash; appended by the facade after respond / status.
   */
  bolt_routing?: BoltReviewRouting[];
  /**
   * CD-08 / 決定の層 row 1: the operator's confirmation of a customer decision
   * on a `requires_customer` entry (money / contract). Until the decision id
   * the entry resolves to is listed here, that customer decision is
   * `provisional`. Kept on the agenda, outside the content hash
   * (`hash.ts` hashes title/phase/locale/customer/entries only), so a
   * confirmation never invalidates the approval or the customer's pinned
   * version; it names one ledger decision id, so a later customer decision
   * needs its own confirmation. Append-only through `customer-decision confirm`.
   */
  operator_confirmations?: OperatorConfirmation[];
  /**
   * CD-11: customer reminders sent or held for approval (one record per
   * agenda × actor × kind × target date). Ids, dates and statuses only,
   * outside the content hash (like `bolt_routing`); written by the facade's
   * reminder sweep.
   */
  reminders?: AgendaReminderRecord[];
  /**
   * CD-11: answers handed to the operator (off-option answers, comments,
   * general questions), one record per receipt. Ids and counts only, outside
   * the content hash; the customer's text stays in the receipt.
   */
  handoffs?: AgendaHandoffRecord[];
  created_at: string;
  updated_at: string;
}

/** CD-11 reminder kinds: answer by `respond_by` (D-1, D0); an override window closing (D-2). */
export type AgendaReminderKind = 'before_due' | 'due' | 'override_closing';
export const AGENDA_REMINDER_KINDS: readonly AgendaReminderKind[] = [
  'before_due',
  'due',
  'override_closing',
];

/**
 * What became of one reminder: `sent` (delivered through the bound channel),
 * `approval_pending` (held at the outbound approval gate; the next sweep
 * retries with the same correlation id), `manual` (no usable bound channel,
 * or a title the fixed template refuses: an operator inbox task to remind by
 * hand), `denied` (the gate refused it, or the approval was rejected or lapsed).
 * A `delivery_failed` attempt is not recorded, so the next sweep retries.
 */
export type AgendaReminderStatus = 'sent' | 'approval_pending' | 'manual' | 'denied';

export interface AgendaReminderRecord {
  /** `rmd-<hex16>` over agenda × actor × kind × target date. */
  reminder_id: string;
  kind: AgendaReminderKind;
  actor_id: string;
  /** The date the reminder is about (`respond_by`, or the override deadline), `YYYY-MM-DD` UTC. */
  target_date: string;
  status: AgendaReminderStatus;
  /** `manual`: why no channel was used. */
  reason?: 'no_channel' | 'binding_missing' | 'surface_unsupported' | 'template_refused';
  approval_request_id?: string;
  inbox_entry_id?: string;
  at: string;
}

export interface AgendaHandoffRecord {
  receipt_id: string;
  /** Answers outside the offered options (comment-only free text). */
  off_option: number;
  /** Answers that carry a comment. */
  comments: number;
  /** 1 when the receipt carries a general question. */
  general_question: number;
  inbox_entry_id: string;
  /** Set once the operator notification was accepted (a `retryable` push leaves it unset). */
  notified_at?: string;
  at: string;
}

export interface OperatorConfirmation {
  entry_id: string;
  /** The customer decision (ledger id) the operator confirmed. */
  decision_id: string;
  /** `user:<member>` */
  by: string;
  at: string;
  /** The approval request (`customer_decision:operator_confirm`) that authorized it. */
  request_id?: string;
}

export interface BoltReviewRouting {
  entry_id: string;
  /** The ledger decision id, or the receipt id of a change request (no ledger write). */
  ref: string;
  outcome: 'request_changes' | 'reject';
  /** `request_changes`: the backlog WorkItem filed. */
  work_item_id?: string;
  /** `reject`: when the operator was notified. */
  notified_at?: string;
  /** `reject`: the inbox entry added. */
  inbox_entry_id?: string;
  at: string;
}

export type EffectiveDecisionStatus =
  'confirmed' | 'provisional' | 'awaiting_customer' | 'undecided';

export interface EffectiveDecision {
  entry_id: string;
  item: string;
  key: string;
  layer: DecisionLayerName | 'none';
  value?: unknown;
  decision_id?: string;
  status: EffectiveDecisionStatus;
  decided_by?: string;
  at?: string;
  overridable: boolean;
  /**
   * A customer decision on a `requires_customer` entry the operator has not
   * confirmed yet (status `provisional`, layer `customer`).
   */
  awaiting_operator_confirmation?: boolean;
}

export type ReceiptAnswerChoice =
  'option' | 'keep' | 'free_text' | 'approve' | 'request_changes' | 'reject';

/**
 * What a receipt answer did: `decided` (a ledger record was appended),
 * `unchanged` (the customer had already decided this value), `change_request`
 * (override window closed and the value differs; no ledger write), `opinion`
 * (contributor or comment-only answer; receipt only).
 */
export type ReceiptAnswerOutcome = 'decided' | 'unchanged' | 'change_request' | 'opinion';

export interface DecisionReceipt {
  version: '1.0.0';
  receipt_id: string;
  tenant_slug: string;
  case_id: string;
  agenda_id: string;
  agenda_revision: number;
  content_hash: string;
  invite_id: string;
  participant: { name: string; role: 'decider' | 'contributor'; actor_id: string };
  answers: Array<{
    entry_id: string;
    choice: ReceiptAnswerChoice;
    value?: unknown;
    comment?: string;
    /** Absent on receipts written before outcomes were recorded. */
    outcome?: ReceiptAnswerOutcome;
  }>;
  /**
   * CD-11: a question about the agenda as a whole (outside its entries),
   * handed to the operator like a comment.
   */
  general_question?: string;
  identity_assurance: 'invite_link';
  submitted_at: string;
  decision_ids: string[];
}

export interface DecisionSwitch {
  version: '1.0.0';
  switch_id: string;
  case_id: string;
  agenda_id: string;
  entry_id: string;
  item: string;
  key: string;
  kind: 'value_changed' | 'confirmed';
  from: { layer: DecisionLayerName | 'none'; value?: unknown; decision_id?: string };
  to: { layer: DecisionLayerName | 'none'; value?: unknown; decision_id?: string };
  at: string;
  cause_receipt_id?: string;
}

/**
 * The layer a consumed decision came from. `task_proposal` is a decision the
 * task itself proposed while the customer has not decided yet (CD-09
 * "実装中の判断を顧客に回す"): the entry carries a {@link TaskDecisionProposal}
 * and, once collected into an agenda, that agenda entry's ids.
 */
export type ConsumedDecisionLayer = DecisionLayerName | 'none' | 'task_proposal';

/**
 * A customer-judgment question a task raised (CD-09), kept on the task's own
 * consumer lock. The proposal value is the entry's `value` (absent when
 * `requires_customer`: the task waits for the customer instead).
 */
export interface TaskDecisionProposal {
  /** `tp-<hex16>`, derived from the consumer, item and key; doubles as the agenda entry id. */
  proposal_id: string;
  question: string;
  requires_customer: boolean;
  options?: Array<{ value: unknown; label: string }>;
  rationale?: string;
  topic?: string;
  proposed_at: string;
  /** When the proposal was linked to an agenda entry (the entry's `agenda_id` / `entry_id`). */
  collected_at?: string;
  /** `requires_customer`: the confirmed customer decision that released the hold. */
  resolved?: { decision_id: string; at: string };
}

/** What a task consumed at its start (same shape idea as the SSOD `DecisionLock`). */
export interface ConsumedDecisionLock {
  case_id: string;
  consumer: string;
  locked_at: string;
  decisions: Array<{
    /** The agenda entry the decision was resolved from (absent on hand-built locks). */
    agenda_id?: string;
    entry_id?: string;
    item: string;
    key: string;
    decision_id?: string;
    value?: unknown;
    layer: ConsumedDecisionLayer;
    /** Present exactly on `task_proposal` entries. */
    proposal?: TaskDecisionProposal;
  }>;
}

// ---------------------------------------------------------------------------
// Grammar and layout — the single place these values are written down
// ---------------------------------------------------------------------------

export const AGENDA_ID_PATTERN = /^agd-[A-Za-z0-9][A-Za-z0-9_-]{3,80}$/u;
export const RECEIPT_ID_PATTERN = /^rcp-[A-Za-z0-9][A-Za-z0-9_-]{3,80}$/u;
export const SWITCH_ID_PATTERN = /^sw-[A-Za-z0-9][A-Za-z0-9_-]{3,80}$/u;
/** CD-11 `respond_by`: a calendar date (UTC), `YYYY-MM-DD`. */
export const RESPOND_BY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
/** Entry ids are local to one agenda. */
export const AGENDA_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u;
/**
 * A decision consumer (CD-09): one mission task, `mission-<MISSION_ID>.<task>`.
 * Safe as a file name (no separators, never `.` / `..`); see `missionTaskConsumerId`.
 */
export const CONSUMER_ID_PATTERN =
  /^mission-[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u;

/** Sub-paths under the SSOD case directory (`knowledge/confidential/<tenant>/decisions/<case>/`). */
export const CUSTOMER_DECISION_LAYOUT = {
  agendasDir: 'agendas',
  receiptsDir: 'receipts',
  /** One MO-11 brief input per agenda: `brief-input/<agenda_id>.json`. */
  briefInputDir: 'brief-input',
  /** Write-ahead records of `respond` runs in flight: `respond-journal/<receipt_id>.json`. */
  respondJournalDir: 'respond-journal',
  /** CD-09: what each task consumed at its start: `consumers/<consumer>.json`. */
  consumersDir: 'consumers',
  /** CD-10: images shown with agenda entries: `attachments/<sha256>.<ext>`. */
  attachmentsDir: 'attachments',
  files: {
    switches: 'switches.jsonl',
  },
} as const;

export function isAgendaId(value: unknown): value is string {
  return typeof value === 'string' && AGENDA_ID_PATTERN.test(value);
}

export function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_ID_PATTERN.test(value);
}

export function isConsumerId(value: unknown): value is string {
  return typeof value === 'string' && CONSUMER_ID_PATTERN.test(value);
}

export function isSwitchId(value: unknown): value is string {
  return typeof value === 'string' && SWITCH_ID_PATTERN.test(value);
}

/**
 * The layer order an agenda entry may declare: the customer layer always
 * comes first (the customer's decision is the top layer, plan 決定の層), so an
 * explicit `layers` must start with `customer`. Returns the problem, or null.
 */
export function entryLayersProblem(
  entry: Pick<AgendaEntry, 'layers'>
): 'layers_missing_customer' | 'layers_customer_not_first' | null {
  if (!entry.layers || entry.layers.length === 0) return null;
  if (!entry.layers.includes('customer')) return 'layers_missing_customer';
  if (entry.layers[0] !== 'customer') return 'layers_customer_not_first';
  return null;
}

/** The layer order an entry uses (its own, or the default customer > ours > org_default). */
export function entryLayers(entry: Pick<AgendaEntry, 'layers'>): readonly DecisionLayerName[] {
  return entry.layers && entry.layers.length > 0 ? entry.layers : DEFAULT_DECISION_LAYERS;
}
