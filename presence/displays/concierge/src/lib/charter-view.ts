/**
 * Pure helpers behind the charter pane. No I/O and no `t()`. The server
 * (`/api/charters`) is the only authority: this shapes the form and does a
 * cheap pre-check so an obviously malformed value never leaves the browser.
 */

export interface CharterFormDraft {
  per_action: string;
  per_day: string;
  per_month: string;
  max_loss_per_incident: string;
  deputies: string;
  expires_in_days: string;
  allow_named_spend: boolean;
  allow_customer_outbound: boolean;
  /** Decision types delegated by name (the server holds the list of delegable ones). */
  delegated_decisions: string[];
  supersedes_decision_rights: boolean;
  /** Explicit information delegation; the server validates every value. */
  recipient_purposes: string;
  recipient_classes: string;
  recipient_categories: string;
  max_attachments: string;
  approved_processors: string;
  processing_purposes: string;
  processing_categories: string;
  reputational_class_max: string;
}

export const DEFAULT_CHARTER_DRAFT: CharterFormDraft = {
  per_action: '0',
  per_day: '0',
  per_month: '0',
  max_loss_per_incident: '0',
  deputies: '',
  expires_in_days: '90',
  allow_named_spend: false,
  allow_customer_outbound: false,
  delegated_decisions: [],
  supersedes_decision_rights: false,
  recipient_purposes: '',
  recipient_classes: '',
  recipient_categories: '',
  max_attachments: '0',
  approved_processors: '',
  processing_purposes: '',
  processing_categories: '',
  reputational_class_max: 'B',
};

/** "1,000,000" / "1 000" / "1_000" → 1000000; anything else → NaN. */
export function parseAmount(text: string): number {
  const cleaned = text.replace(/[,_\s]/g, '');
  return /^\d{1,13}$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

export type DraftCheck =
  | { ok: true }
  | { ok: false; reason: 'number' | 'order' | 'loss' | 'days' | 'deputy' | 'processor' };

export function checkDraft(draft: CharterFormDraft): DraftCheck {
  const perAction = parseAmount(draft.per_action);
  const perDay = parseAmount(draft.per_day);
  const perMonth = parseAmount(draft.per_month);
  const loss = parseAmount(draft.max_loss_per_incident);
  const attachments = Number(draft.max_attachments);
  if (!/^\d+$/.test(draft.max_attachments) || !Number.isSafeInteger(attachments)) {
    return { ok: false, reason: 'number' };
  }
  if ([perAction, perDay, perMonth, loss].some((n) => Number.isNaN(n))) {
    return { ok: false, reason: 'number' };
  }
  if (perAction > perDay || perDay > perMonth) return { ok: false, reason: 'order' };
  if (loss > perMonth) return { ok: false, reason: 'loss' };
  const days = Number(draft.expires_in_days);
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: 'days' };
  if (parseDeputies(draft.deputies).some((d) => !/^user:[a-z][a-z0-9-]*$/.test(d))) {
    return { ok: false, reason: 'deputy' };
  }
  // Check the same de-duplicated lists that draftToForm sends to the server.
  const processors = parseList(draft.approved_processors);
  const purposes = parseList(draft.processing_purposes);
  const categories = parseList(draft.processing_categories);
  const validIds = (items: string[]) =>
    items.length <= 20 && items.every((item) => /^[a-z0-9][a-z0-9:_-]{0,127}$/.test(item));
  if (
    !validIds(processors) ||
    !validIds(purposes) ||
    categories.some(
      (category) =>
        !['routine_business', 'personal_data', 'sensitive_business', 'unknown'].includes(category)
    ) ||
    (processors.length > 0 && (purposes.length === 0 || categories.length === 0)) ||
    (processors.length === 0 && (purposes.length > 0 || categories.length > 0))
  ) {
    return { ok: false, reason: 'processor' };
  }
  return { ok: true };
}

export function parseDeputies(text: string): string[] {
  return parseList(text);
}

/** Comma / whitespace / Japanese-comma separated list, trimmed, de-duplicated. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s、]+/)
        .map((d) => d.trim())
        .filter(Boolean)
    ),
  ];
}

/** The form body the API expects. Call only after `checkDraft` is ok. */
export function draftToForm(tenantSlug: string, draft: CharterFormDraft) {
  return {
    tenant_slug: tenantSlug,
    per_action: parseAmount(draft.per_action),
    per_day: parseAmount(draft.per_day),
    per_month: parseAmount(draft.per_month),
    max_loss_per_incident: parseAmount(draft.max_loss_per_incident),
    allow_named_spend: draft.allow_named_spend,
    allow_customer_outbound: draft.allow_customer_outbound,
    delegated_decisions: [...draft.delegated_decisions].sort(),
    supersedes_decision_rights: draft.supersedes_decision_rights,
    recipient_purposes: parseList(draft.recipient_purposes),
    recipient_classes: parseList(draft.recipient_classes),
    recipient_categories: parseList(draft.recipient_categories),
    max_attachments: Number(draft.max_attachments),
    approved_processors: parseList(draft.approved_processors),
    processing_purposes: parseList(draft.processing_purposes),
    processing_categories: parseList(draft.processing_categories),
    reputational_class_max: draft.reputational_class_max,
    deputies: parseDeputies(draft.deputies),
    expires_in_days: Number(draft.expires_in_days),
  };
}

/** Prefill the form from the charter in force, so an amendment starts from the current limits. */
export function draftFromCharter(charter: {
  money: { per_action: number; per_day: number; per_month: number };
  max_loss_per_incident: number;
  deputies: string[];
  allows_named_spend: boolean;
  allows_customer_outbound?: boolean;
  delegated_decisions?: string[];
  recipient_purposes?: string[];
  recipient_classes?: string[];
  recipient_categories?: string[];
  max_attachments?: number;
  approved_processors?: string[];
  processing_purposes?: string[];
  processing_categories?: string[];
  reputational_class_max?: string;
  supersedes_decision_rights: boolean;
}): CharterFormDraft {
  return {
    per_action: String(charter.money.per_action),
    per_day: String(charter.money.per_day),
    per_month: String(charter.money.per_month),
    max_loss_per_incident: String(charter.max_loss_per_incident),
    deputies: charter.deputies.join(', '),
    expires_in_days: '90',
    allow_named_spend: charter.allows_named_spend,
    allow_customer_outbound: charter.allows_customer_outbound === true,
    delegated_decisions: [...(charter.delegated_decisions ?? [])],
    supersedes_decision_rights: charter.supersedes_decision_rights,
    recipient_purposes: (charter.recipient_purposes ?? []).join(', '),
    recipient_classes: (charter.recipient_classes ?? []).join(', '),
    recipient_categories: (charter.recipient_categories ?? []).join(', '),
    max_attachments: String(charter.max_attachments ?? 0),
    approved_processors: (charter.approved_processors ?? []).join(', '),
    processing_purposes: (charter.processing_purposes ?? []).join(', '),
    processing_categories: (charter.processing_categories ?? []).join(', '),
    reputational_class_max: charter.reputational_class_max ?? 'B',
  };
}

export interface CharterTenantView {
  tenant_slug: string;
  role: 'owner' | 'approver' | 'viewer' | null;
  can_create: boolean;
  /** An approver may draft limits for the owner to decide. */
  can_propose?: boolean;
  /** The approver's draft waiting for the owner (owner and approvers only). */
  draft?: CharterDraft | null;
  can_stop: boolean;
  charter: null | {
    charter_id: string;
    responsible: string;
    deputies: string[];
    expires_at: string;
    money: { currency: string; per_action: number; per_day: number; per_month: number };
    max_loss_per_incident: number;
    allows_named_spend: boolean;
    allows_customer_outbound?: boolean;
    delegated_decisions?: string[];
    recipient_purposes?: string[];
    recipient_classes?: string[];
    recipient_categories?: string[];
    max_attachments?: number;
    approved_processors?: string[];
    processing_purposes?: string[];
    processing_categories?: string[];
    reputational_class_max?: string;
    supersedes_decision_rights: boolean;
    report: {
      tripwires_standing: string[];
      money?: { currency: string; spent_today: number; spent_this_month: number };
      amendment_proposals?: CharterProposal[];
    };
    report_text: string;
  };
}

export interface CharterDraft {
  proposed_by: string;
  proposed_by_name: string;
  proposed_at: string;
  note: string;
  form: {
    per_action: number;
    per_day: number;
    per_month: number;
    max_loss_per_incident: number;
    deputies: string[];
    expires_in_days: number;
    allow_named_spend: boolean;
    allow_customer_outbound: boolean;
    delegated_decisions?: string[];
    recipient_purposes?: string[];
    recipient_classes?: string[];
    recipient_categories?: string[];
    max_attachments?: number;
    approved_processors?: string[];
    processing_purposes?: string[];
    processing_categories?: string[];
    reputational_class_max?: string;
    supersedes_decision_rights: boolean;
  };
}

/** Load an approver's draft into the form. Nothing is saved: the owner still reviews and agrees. */
export function draftFromProposal(proposal: CharterDraft): CharterFormDraft {
  const f = proposal.form;
  return {
    per_action: String(f.per_action),
    per_day: String(f.per_day),
    per_month: String(f.per_month),
    max_loss_per_incident: String(f.max_loss_per_incident),
    deputies: f.deputies.join(', '),
    expires_in_days: String(f.expires_in_days),
    allow_named_spend: f.allow_named_spend,
    allow_customer_outbound: f.allow_customer_outbound,
    delegated_decisions: [...(f.delegated_decisions ?? [])],
    supersedes_decision_rights: f.supersedes_decision_rights,
    recipient_purposes: (f.recipient_purposes ?? []).join(', '),
    recipient_classes: (f.recipient_classes ?? []).join(', '),
    recipient_categories: (f.recipient_categories ?? []).join(', '),
    max_attachments: String(f.max_attachments ?? 0),
    approved_processors: (f.approved_processors ?? []).join(', '),
    processing_purposes: (f.processing_purposes ?? []).join(', '),
    processing_categories: (f.processing_categories ?? []).join(', '),
    reputational_class_max: f.reputational_class_max ?? 'B',
  };
}

export interface CharterProposal {
  field: string;
  count: number;
  current?: unknown;
  requested?: unknown;
}

const PROPOSAL_DRAFT_FIELD: Record<string, keyof CharterFormDraft> = {
  'envelope.money.per_action': 'per_action',
  'envelope.money.per_day': 'per_day',
  'envelope.money.per_month': 'per_month',
  'appetite.max_loss_per_incident': 'max_loss_per_incident',
};

/** Only numeric limits the form edits can be pre-filled; other fields are shown as advice only. */
export function proposalDraftField(proposal: CharterProposal): keyof CharterFormDraft | null {
  if (typeof proposal.requested !== 'number') return null;
  return PROPOSAL_DRAFT_FIELD[proposal.field] ?? null;
}

/**
 * Put a proposal into the form. It never saves anything: the owner still
 * reviews the statement and accepts. Raising a limit may require raising the
 * ones above it (`checkDraft` enforces per_action ≤ per_day ≤ per_month), so
 * the parents are lifted together rather than leaving the form invalid.
 */
export function applyProposalToDraft(
  draft: CharterFormDraft,
  proposal: CharterProposal
): CharterFormDraft {
  const key = proposalDraftField(proposal);
  if (!key) return draft;
  const value = proposal.requested as number;
  const next = { ...draft, [key]: String(value) };
  const lift = (child: keyof CharterFormDraft, parent: keyof CharterFormDraft) => {
    const c = parseAmount(String(next[child]));
    const p = parseAmount(String(next[parent]));
    if (!Number.isNaN(c) && (Number.isNaN(p) || c > p)) next[parent] = String(c) as never;
  };
  lift('per_action', 'per_day');
  lift('per_day', 'per_month');
  lift('max_loss_per_incident', 'per_month');
  return next;
}

/** 0..100, clamped; a zero limit reads as 0 so an unset budget never shows a full bar. */
export function usagePercent(spent: number, limit: number): number {
  if (!(limit > 0) || !(spent > 0)) return 0;
  return Math.min(100, Math.round((spent / limit) * 100));
}

export function parseCharterOverview(value: unknown): CharterTenantView[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !Array.isArray(v.tenants)) return undefined;
  const out: CharterTenantView[] = [];
  for (const t of v.tenants) {
    if (!t || typeof t !== 'object') return undefined;
    const e = t as Record<string, unknown>;
    if (
      typeof e.tenant_slug !== 'string' ||
      typeof e.can_create !== 'boolean' ||
      typeof e.can_stop !== 'boolean'
    ) {
      return undefined;
    }
    const c = e.charter;
    if (
      c !== null &&
      (typeof c !== 'object' || typeof (c as Record<string, unknown>).charter_id !== 'string')
    ) {
      return undefined;
    }
    out.push(e as unknown as CharterTenantView);
  }
  return out;
}

export interface CharterDecisionOption {
  decision_type: string;
  label: string;
}

/** The delegable decision types the server offers; malformed entries are dropped. */
export function parseCharterDecisionOptions(value: unknown): CharterDecisionOption[] {
  if (!value || typeof value !== 'object') return [];
  const options = (value as Record<string, unknown>).decision_options;
  if (!Array.isArray(options)) return [];
  return options.filter(
    (o): o is CharterDecisionOption =>
      Boolean(o) &&
      typeof (o as CharterDecisionOption).decision_type === 'string' &&
      typeof (o as CharterDecisionOption).label === 'string'
  );
}

/** Toggle one delegated decision; the list stays sorted and duplicate-free. */
export function setDelegatedDecision(
  draft: CharterFormDraft,
  decisionType: string,
  on: boolean
): CharterFormDraft {
  const rest = draft.delegated_decisions.filter((d) => d !== decisionType);
  return { ...draft, delegated_decisions: (on ? [...rest, decisionType] : rest).sort() };
}

export function isManuallyStopped(view: CharterTenantView): boolean {
  return Boolean(view.charter?.report.tripwires_standing.includes('manual-stop'));
}

/** Server error code → message key; anything else is shown as detail. */
export type CharterErrorKind =
  'owner' | 'approver' | 'member' | 'changed' | 'responsible' | 'generic';
export function charterErrorKind(code: string): CharterErrorKind {
  if (code === 'owner_required') return 'owner';
  if (code === 'approver_required') return 'approver';
  if (code === 'member_required') return 'member';
  if (code === 'statement_changed') return 'changed';
  if (code === 'not_responsible') return 'responsible';
  return 'generic';
}
