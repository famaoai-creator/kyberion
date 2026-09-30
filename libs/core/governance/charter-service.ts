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
  const lines = [
    `私 ${displayName}(${accountableId})は、組織「${form.tenant_slug}」について、次の範囲内で AI エージェントが私の承認なしに実行することを認め、その結果について最終的な責任を負います。`,
    `・1 回の支出の上限: ${yen(form.per_action)} / 1 日: ${yen(form.per_day)} / 1 か月: ${yen(form.per_month)}`,
    `・1 件で引き受ける損失の上限: ${yen(form.max_loss_per_incident)}`,
    form.allow_named_spend
      ? '・取り消せない支出(operational_spend)を、上の範囲内で承認なしに実行させる'
      : '・取り消せない支出は、承認なしには実行させない',
    form.supersedes_decision_rights
      ? '・decision-rights matrix が人の受け入れを求める判断についても、上の範囲内であればこの憲章が代わりになる'
      : '・decision-rights matrix が人の受け入れを求める判断は、これまでどおり人が受け入れる',
    `・私が「停止」を押したとき、または宣言した停止条件が立ったときは、全ての実行を止める。解除できるのは私と代理責任者だけ`,
    `・代理責任者: ${form.deputies.length > 0 ? form.deputies.join(', ') : 'なし'}`,
    `・期限: ${expires}(期限を過ぎると、従来の承認に戻る)`,
    'この範囲を超える判断は、私(または代理責任者)が個別に行う。私が実際に持っている権限を超える委任は、この宣言では有効にならない。',
  ];
  const en = [
    `I, ${displayName} (${accountableId}), authorize AI agents to act without my approval within the limits below for organization "${form.tenant_slug}", and I accept final responsibility for the result.`,
    `- Per spend: ${yen(form.per_action)} / per day: ${yen(form.per_day)} / per month: ${yen(form.per_month)}`,
    `- Most I accept losing on one item: ${yen(form.max_loss_per_incident)}`,
    form.allow_named_spend
      ? '- Irreversible spend (operational_spend) MAY run without approval within these limits'
      : '- Irreversible spend does NOT run without approval',
    form.supersedes_decision_rights
      ? "- Where the decision-rights matrix requires a human's acceptance, this charter stands in for it within these limits"
      : "- Where the decision-rights matrix requires a human's acceptance, a human still accepts, as before",
    '- When I press "Stop", or a declared stop condition stands, everything stops; only I and my deputies can clear it',
    `- Deputies: ${form.deputies.length > 0 ? form.deputies.join(', ') : 'none'}`,
    `- Valid until: ${expires} (after that, per-decision approval applies again)`,
    'Anything beyond these limits is decided by me (or a deputy) individually. A delegation beyond the authority I actually hold is not made valid by this statement.',
  ];
  // Both languages are part of the signed text: the digest binds exactly what was shown.
  return `${lines.join('\n')}\n\n${en.join('\n')}`;
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
