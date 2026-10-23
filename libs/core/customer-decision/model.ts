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
  phase: string;
  revision: number;
  locale: 'ja' | 'en';
  deal_id?: string;
  project_id?: string;
  entries: AgendaEntry[];
  status: AgendaStatus;
  approval?: {
    content_hash: string;
    request_id?: string;
    approved_at: string;
    approved_by: string;
  };
  milestones_passed?: string[];
  created_at: string;
  updated_at: string;
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
}

export type ReceiptAnswerChoice = 'option' | 'keep' | 'free_text' | 'approve' | 'request_changes';

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
  }>;
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

/** What a task consumed at its start (same shape idea as the SSOD `DecisionLock`). */
export interface ConsumedDecisionLock {
  case_id: string;
  consumer: string;
  locked_at: string;
  decisions: Array<{
    item: string;
    key: string;
    decision_id?: string;
    value?: unknown;
    layer: DecisionLayerName | 'none';
  }>;
}

// ---------------------------------------------------------------------------
// Grammar and layout — the single place these values are written down
// ---------------------------------------------------------------------------

export const AGENDA_ID_PATTERN = /^agd-[A-Za-z0-9][A-Za-z0-9_-]{3,80}$/u;
export const RECEIPT_ID_PATTERN = /^rcp-[A-Za-z0-9][A-Za-z0-9_-]{3,80}$/u;
export const SWITCH_ID_PATTERN = /^sw-[A-Za-z0-9][A-Za-z0-9_-]{3,80}$/u;
/** Entry ids are local to one agenda. */
export const AGENDA_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u;

/** Sub-paths under the SSOD case directory (`knowledge/confidential/<tenant>/decisions/<case>/`). */
export const CUSTOMER_DECISION_LAYOUT = {
  agendasDir: 'agendas',
  receiptsDir: 'receipts',
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

export function isSwitchId(value: unknown): value is string {
  return typeof value === 'string' && SWITCH_ID_PATTERN.test(value);
}

/** The layer order an entry uses (its own, or the default customer > ours > org_default). */
export function entryLayers(entry: Pick<AgendaEntry, 'layers'>): readonly DecisionLayerName[] {
  return entry.layers && entry.layers.length > 0 ? entry.layers : DEFAULT_DECISION_LAYERS;
}
