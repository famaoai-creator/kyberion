/**
 * Call-site adapter: turns a governed decision (decision type + amount, from a
 * validated pipeline step) into the trusted `charter` input of the approval
 * gate — or `undefined`, meaning "the legacy gate applies unchanged".
 *
 * Only decision types listed in the charter decision vocabulary are mapped. An
 * unlisted type (secret mutation, anything new) never gets a charter branch:
 * the envelope has nothing to say about it, and "the envelope says nothing"
 * must not read as "allowed". Listed types that require delegation must also
 * be named in `envelope.delegated_decisions`.
 *
 * An irreversible decision's worst-case loss is its full amount, and the
 * charter must name the decision type in `irreversible_named_actions` to let
 * it run unattended.
 */

import { agentActor } from '../actor.js';
import { buildNhiId, NHI_SLUG_PATTERN } from '../nhi-id.js';
import type { CharterAction } from './accountability-charter.js';
import type { ApprovalGateCharterInput } from './approval-gate-charter.js';
import { findActiveCharter, type CharterPathOptions } from './accountability-charter-registry.js';
import {
  findCharterDecision,
  type CharterDecisionVocabulary,
} from './charter-decision-vocabulary.js';

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
    /** Outside parties the decision reaches (messages, invitations). */
    recipients?: number;
  },
  options: CharterPathOptions & { vocabulary?: CharterDecisionVocabulary } = {},
  now: Date = new Date()
): ApprovalGateCharterInput | undefined {
  const entry = findCharterDecision(input.decisionType, options.vocabulary);
  if (!entry || !input.tenantSlug) return undefined;
  const pathOptions: CharterPathOptions = options.rootDir ? { rootDir: options.rootDir } : {};
  const scope = { kind: 'organization', tenant_slug: input.tenantSlug } as const;
  const charter = findActiveCharter(scope, now, pathOptions);
  if (!charter) return undefined;
  const actor = agentActor(
    buildNhiId(input.tenantSlug, workerSlug(input.agentId)),
    charter.accountable.actor
  );
  const amount =
    entry.amount_semantics !== 'none' &&
    typeof input.amount === 'number' &&
    Number.isFinite(input.amount) &&
    input.amount > 0
      ? input.amount
      : 0;
  const recipients =
    typeof input.recipients === 'number' &&
    Number.isInteger(input.recipients) &&
    input.recipients >= 0
      ? input.recipients
      : entry.default_recipients;
  const action: CharterAction = {
    actor,
    action_class: entry.action_class,
    ...(entry.requires_delegation ? { decision_type: entry.decision_type } : {}),
    ...(entry.amount_semantics === 'spend' && amount > 0
      ? { amount, currency: DECISION_RIGHTS_CURRENCY }
      : {}),
    reversible: entry.reversible,
    ...(entry.reversible ? {} : { irreversible_action_name: entry.decision_type }),
    estimated_loss: entry.reversible ? 0 : amount,
    ...(entry.reputational_class ? { reputational_class: entry.reputational_class } : {}),
    ...(recipients !== undefined || entry.systems !== undefined
      ? {
          blast_radius: {
            ...(recipients !== undefined ? { recipients } : {}),
            ...(entry.systems !== undefined ? { systems: entry.systems } : {}),
          },
        }
      : {}),
  };
  return {
    scope,
    action,
    ...(options.rootDir ? { pathOptions } : {}),
  };
}

/**
 * Outbound customer message → `send_message_external`. A sent message cannot be
 * recalled, so it is irreversible and the charter must name `customer_outbound`
 * (and allow `send_message_external`) to let it run unattended. One message,
 * one recipient, customer-facing (reputational class B). The caller must NOT
 * pass a charter when the audience egress floor is violated: that case always
 * goes to a human.
 */
export function charterInputForCustomerOutbound(
  input: { tenantSlug?: string },
  options: CharterPathOptions = {},
  now: Date = new Date()
): ApprovalGateCharterInput | undefined {
  if (!input.tenantSlug) return undefined;
  const scope = { kind: 'organization', tenant_slug: input.tenantSlug } as const;
  const charter = findActiveCharter(scope, now, options);
  if (!charter) return undefined;
  return {
    scope,
    action: {
      actor: agentActor(
        buildNhiId(input.tenantSlug, 'customer-conversation'),
        charter.accountable.actor
      ),
      action_class: 'send_message_external',
      reversible: false,
      irreversible_action_name: 'customer_outbound',
      estimated_loss: 0,
      reputational_class: 'B',
      blast_radius: { recipients: 1 },
    },
    ...(options.rootDir ? { pathOptions: options } : {}),
  };
}
