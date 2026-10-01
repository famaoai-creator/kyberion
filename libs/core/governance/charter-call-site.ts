/**
 * Call-site adapter: turns a governed decision (decision type + amount, from a
 * validated pipeline step) into the trusted `charter` input of the approval
 * gate — or `undefined`, meaning "the legacy gate applies unchanged".
 *
 * Only decision types with an honest charter vocabulary are mapped. An
 * unmapped type (secret mutation, headcount, anything new) never gets a
 * charter branch: the envelope has nothing to say about it, and "the envelope
 * says nothing" must not read as "allowed".
 *
 * Money and contracts are treated as irreversible and their worst-case loss as
 * the full amount: the charter's `irreversible` and appetite limits apply
 * conservatively, and the charter must name the decision type in
 * `irreversible_named_actions` to let it run unattended.
 */

import { agentActor } from '../actor.js';
import { buildNhiId, NHI_SLUG_PATTERN } from '../nhi-id.js';
import type { ApprovalGateCharterInput } from './approval-gate-charter.js';
import { findActiveCharter, type CharterPathOptions } from './accountability-charter-registry.js';

/** decision_type (decision-rights matrix) → charter action class. */
const DECISION_TYPE_TO_CHARTER_CLASS: Readonly<Record<string, string>> = {
  operational_spend: 'payment',
  contract_signature: 'sign_contract',
};

/** decision-rights thresholds are expressed in JPY (`amount_jpy`). */
const DECISION_RIGHTS_CURRENCY = 'JPY';

function workerSlug(agentId: string | undefined): string {
  const slug = String(agentId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '');
  return NHI_SLUG_PATTERN.test(slug) ? slug : 'pipeline-worker';
}

export function charterInputForDecision(
  input: {
    tenantSlug?: string;
    agentId?: string;
    decisionType: string;
    amount?: number;
  },
  options: CharterPathOptions = {},
  now: Date = new Date()
): ApprovalGateCharterInput | undefined {
  const actionClass = DECISION_TYPE_TO_CHARTER_CLASS[input.decisionType];
  if (!actionClass || !input.tenantSlug) return undefined;
  const scope = { kind: 'organization', tenant_slug: input.tenantSlug } as const;
  const charter = findActiveCharter(scope, now, options);
  if (!charter) return undefined;
  const actor = agentActor(
    buildNhiId(input.tenantSlug, workerSlug(input.agentId)),
    charter.accountable.actor
  );
  const amount =
    typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : 0;
  return {
    scope,
    action: {
      actor,
      action_class: actionClass,
      ...(amount > 0 ? { amount, currency: DECISION_RIGHTS_CURRENCY } : {}),
      reversible: false,
      irreversible_action_name: input.decisionType,
      estimated_loss: amount,
    },
    ...(options.rootDir ? { pathOptions: options } : {}),
  };
}
