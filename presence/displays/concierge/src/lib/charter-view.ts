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
  supersedes_decision_rights: boolean;
}

export const DEFAULT_CHARTER_DRAFT: CharterFormDraft = {
  per_action: '0',
  per_day: '0',
  per_month: '0',
  max_loss_per_incident: '0',
  deputies: '',
  expires_in_days: '90',
  allow_named_spend: false,
  supersedes_decision_rights: false,
};

/** "1,000,000" / "1 000" / "1_000" → 1000000; anything else → NaN. */
export function parseAmount(text: string): number {
  const cleaned = text.replace(/[,_\s]/g, '');
  return /^\d{1,13}$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

export type DraftCheck =
  { ok: true } | { ok: false; reason: 'number' | 'order' | 'loss' | 'days' | 'deputy' };

export function checkDraft(draft: CharterFormDraft): DraftCheck {
  const perAction = parseAmount(draft.per_action);
  const perDay = parseAmount(draft.per_day);
  const perMonth = parseAmount(draft.per_month);
  const loss = parseAmount(draft.max_loss_per_incident);
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
  return { ok: true };
}

export function parseDeputies(text: string): string[] {
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
    supersedes_decision_rights: draft.supersedes_decision_rights,
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
    supersedes_decision_rights: charter.supersedes_decision_rights,
  };
}

export interface CharterTenantView {
  tenant_slug: string;
  role: 'owner' | 'approver' | 'viewer' | null;
  can_create: boolean;
  can_stop: boolean;
  charter: null | {
    charter_id: string;
    responsible: string;
    deputies: string[];
    expires_at: string;
    money: { currency: string; per_action: number; per_day: number; per_month: number };
    max_loss_per_incident: number;
    allows_named_spend: boolean;
    supersedes_decision_rights: boolean;
    report: {
      tripwires_standing: string[];
      money?: { currency: string; spent_today: number; spent_this_month: number };
      amendment_proposals?: CharterProposal[];
    };
    report_text: string;
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

export function isManuallyStopped(view: CharterTenantView): boolean {
  return Boolean(view.charter?.report.tripwires_standing.includes('manual-stop'));
}

/** Server error code → message key; anything else is shown as detail. */
export type CharterErrorKind = 'owner' | 'member' | 'changed' | 'responsible' | 'generic';
export function charterErrorKind(code: string): CharterErrorKind {
  if (code === 'owner_required') return 'owner';
  if (code === 'member_required') return 'member';
  if (code === 'statement_changed') return 'changed';
  if (code === 'not_responsible') return 'responsible';
  return 'generic';
}
