/**
 * Charter service — what a surface needs to let an accountable human create,
 * read and stop a charter without knowing the registry's shape:
 *
 *   parseCharterForm        untrusted form → validated numbers
 *   renderAcceptanceStatement   the exact text the human agrees to (Japanese)
 *   acceptCharterFromForm   recomputes the statement server-side and refuses if
 *                           its digest differs from what the human saw
 *   viewCharter             public read model (limits, usage, standing stops)
 *
 * Authority stays in the core: only an owner of the tenant can accept a charter
 * that carries money (the owner's membership is the authority evidence);
 * validation, single-active-charter and retire-on-replace are the registry's.
 */

import { createHash } from 'node:crypto';
import type { ActorRef } from '../actor.js';
import { isValidMemberId } from '../organization/member-id-grammar.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { t } from '../t.js';
import type { Charter, ReputationalClass } from './accountability-charter.js';
import {
  acceptCharter,
  readCharterLedger,
  type CharterPathOptions,
} from './accountability-charter-registry.js';
import {
  buildAccountabilityReport,
  renderAccountabilityReportText,
  type AccountabilityReport,
} from './accountability-report.js';

/** The accountable human's own kill switch: always declared, raised from the surface. */
export const MANUAL_STOP_TRIPWIRE = 'manual-stop';

const CURRENCY = 'JPY';
const MAX_AMOUNT = 1_000_000_000_000;
const MAX_DAYS = 365;
const MAX_DEPUTIES = 5;

export interface CharterForm {
  tenant_slug: string;
  per_action: number;
  per_day: number;
  per_month: number;
  max_loss_per_incident: number;
  /** Let operational spend run unattended (names it in `irreversible_named_actions`). */
  allow_named_spend: boolean;
  supersedes_decision_rights: boolean;
  deputies: string[]; // user:<member_id>
  expires_in_days: number;
  reputational_class_max: ReputationalClass;
}

export type ParsedForm = { ok: true; form: CharterForm } | { ok: false; error: string };

function amount(value: unknown, label: string): number | string {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return `${label} must be a whole number`;
  }
  if (value < 0 || value > MAX_AMOUNT) return `${label} is out of range`;
  return value;
}

export function parseCharterForm(raw: unknown): ParsedForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'form must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const tenant = typeof r.tenant_slug === 'string' ? r.tenant_slug.trim() : '';
  if (!isValidTenantSlug(tenant)) return { ok: false, error: 'tenant_slug is invalid' };
  const nums: Record<string, number> = {};
  for (const key of ['per_action', 'per_day', 'per_month', 'max_loss_per_incident']) {
    const v = amount(r[key], key);
    if (typeof v === 'string') return { ok: false, error: v };
    nums[key] = v;
  }
  if (nums.per_action > nums.per_day || nums.per_day > nums.per_month) {
    return { ok: false, error: 'limits must satisfy per_action <= per_day <= per_month' };
  }
  if (nums.max_loss_per_incident > nums.per_month) {
    return { ok: false, error: 'max_loss_per_incident cannot exceed per_month' };
  }
  const days = r.expires_in_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return { ok: false, error: `expires_in_days must be a whole number of 1..${MAX_DAYS}` };
  }
  const deputiesRaw = r.deputies ?? [];
  if (!Array.isArray(deputiesRaw) || deputiesRaw.length > MAX_DEPUTIES) {
    return { ok: false, error: `deputies must be a list of at most ${MAX_DEPUTIES}` };
  }
  const deputies: string[] = [];
  for (const d of deputiesRaw) {
    const id = typeof d === 'string' ? d.trim() : '';
    if (!id.startsWith('user:') || !isValidMemberId(id.slice(5))) {
      return { ok: false, error: `deputy '${String(d)}' must look like user:<member_id>` };
    }
    if (!deputies.includes(id)) deputies.push(id);
  }
  const rep = r.reputational_class_max ?? 'B';
  if (rep !== 'A' && rep !== 'B' && rep !== 'C' && rep !== 'D') {
    return { ok: false, error: 'reputational_class_max must be A, B, C or D' };
  }
  return {
    ok: true,
    form: {
      tenant_slug: tenant,
      per_action: nums.per_action,
      per_day: nums.per_day,
      per_month: nums.per_month,
      max_loss_per_incident: nums.max_loss_per_incident,
      allow_named_spend: r.allow_named_spend === true,
      supersedes_decision_rights: r.supersedes_decision_rights === true,
      deputies,
      expires_in_days: days,
      reputational_class_max: rep,
    },
  };
}

function yen(n: number): string {
  return `${CURRENCY} ${n.toLocaleString('en-US')}`;
}

/**
 * The exact text the human agrees to. Deterministic for (form, accountable,
 * day): the server recomputes it at acceptance and compares digests, so what
 * was shown is what is signed.
 */
export function renderAcceptanceStatement(input: {
  form: CharterForm;
  accountableId: string;
  displayName: string;
  now: Date;
}): string {
  const { form, accountableId, displayName, now } = input;
  const expires = new Date(now.getTime() + form.expires_in_days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const block = (locale: 'ja' | 'en'): string => {
    const say = (key: string, params?: Record<string, string>) =>
      t(`decision:charter_statement_${key}` as Parameters<typeof t>[0], params, locale);
    return [
      say('intro', { name: displayName, id: accountableId, tenant: form.tenant_slug }),
      say('limits', {
        per_action: yen(form.per_action),
        per_day: yen(form.per_day),
        per_month: yen(form.per_month),
      }),
      say('loss', { loss: yen(form.max_loss_per_incident) }),
      say(form.allow_named_spend ? 'spend_on' : 'spend_off'),
      say(form.supersedes_decision_rights ? 'matrix_on' : 'matrix_off'),
      say('stop'),
      say('deputies', {
        deputies: form.deputies.length > 0 ? form.deputies.join(', ') : say('deputies_none'),
      }),
      say('expires', { date: expires }),
      say('authority'),
    ].join('\n');
  };
  // Both languages are part of the signed text: the digest binds exactly what was shown.
  return `${block('ja')}\n\n${block('en')}`;
}

export function statementDigest(statement: string): string {
  return createHash('sha256').update(statement, 'utf8').digest('hex');
}

export interface AcceptFromFormInput {
  form: CharterForm;
  /** The authenticated human (an owner of `form.tenant_slug`). */
  acceptedBy: ActorRef;
  displayName: string;
  holderRole: 'owner' | 'approver' | 'operator' | 'viewer' | undefined;
  /** Digest of the statement the human was shown. */
  statementSha256: string;
  /** The tenant's active charter this one replaces, if any. */
  replaces?: string;
  now?: Date;
  idNonce?: string;
}

export function acceptCharterFromForm(
  input: AcceptFromFormInput,
  options: CharterPathOptions = {}
): Charter {
  const now = input.now ?? new Date();
  const { form } = input;
  if (input.acceptedBy.kind !== 'human') throw new Error('[charter] only a human can accept');
  if (input.holderRole !== 'owner') {
    throw new Error('[charter] only an owner of the organization can create a charter');
  }
  const statement = renderAcceptanceStatement({
    form,
    accountableId: input.acceptedBy.id,
    displayName: input.displayName,
    now,
  });
  if (statementDigest(statement) !== input.statementSha256) {
    throw new Error(
      '[charter] the statement changed since it was shown (or the day rolled over); review it again before accepting'
    );
  }
  const memberId = input.acceptedBy.id.replace(/^user:/, '');
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const nonce = (input.idNonce ?? Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/g, '');
  return acceptCharter(
    {
      draft: {
        charter_id: `chr-${form.tenant_slug}-${stamp}-${nonce || 'x'}`.slice(0, 64),
        scope: { kind: 'organization', tenant_slug: form.tenant_slug },
        accountable: {
          actor: input.acceptedBy.id,
          authority_basis: {
            kind: 'owner',
            evidence_ref: `member-registry:${memberId}:owner@${form.tenant_slug}`,
          },
          expires_at: new Date(now.getTime() + form.expires_in_days * 86_400_000).toISOString(),
          deputies: form.deputies,
        },
        envelope: {
          money: {
            currency: CURRENCY,
            per_action: form.per_action,
            per_day: form.per_day,
            per_month: form.per_month,
          },
          data_tier: { read: [], write: [] },
          external_effects: form.per_action > 0 ? { payment: 'allow' } : {},
          irreversible: form.allow_named_spend ? 'named_actions_only' : 'forbid',
          ...(form.allow_named_spend ? { irreversible_named_actions: ['operational_spend'] } : {}),
          ...(form.supersedes_decision_rights ? { supersedes_decision_rights: true } : {}),
        },
        appetite: {
          max_loss_per_incident: form.max_loss_per_incident,
          reputational_class_max: form.reputational_class_max,
          blast_radius_max: { recipients: 1, systems: 1 },
          tripwires: [MANUAL_STOP_TRIPWIRE],
        },
      },
      statement,
      acceptedBy: input.acceptedBy,
      validation: { holder_role: 'owner' },
      now,
      ...(input.replaces ? { replaces: input.replaces } : {}),
    },
    options
  );
}

export interface CharterView {
  charter_id: string;
  tenant_slug: string;
  responsible: string;
  deputies: string[];
  accepted_at: string;
  expires_at: string;
  money: { currency: string; per_action: number; per_day: number; per_month: number };
  max_loss_per_incident: number;
  allows_named_spend: boolean;
  supersedes_decision_rights: boolean;
  report: AccountabilityReport;
  report_text: string;
}

export function viewCharter(
  charter: Charter,
  now: Date,
  options: CharterPathOptions = {},
  locale: 'ja' | 'en' = 'ja'
): CharterView {
  const report = buildAccountabilityReport({
    charter,
    ledger: readCharterLedger(charter, options),
    now,
  });
  return {
    charter_id: charter.charter_id,
    tenant_slug: charter.scope.kind === 'organization' ? charter.scope.tenant_slug : '',
    responsible: charter.accountable.actor,
    deputies: charter.accountable.deputies,
    accepted_at: charter.accountable.accepted_at,
    expires_at: charter.accountable.expires_at,
    money: { ...charter.envelope.money },
    max_loss_per_incident: charter.appetite.max_loss_per_incident,
    allows_named_spend: (charter.envelope.irreversible_named_actions ?? []).includes(
      'operational_spend'
    ),
    supersedes_decision_rights: charter.envelope.supersedes_decision_rights === true,
    report,
    report_text: renderAccountabilityReportText(report, { locale }),
  };
}
