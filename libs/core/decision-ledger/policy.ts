/**
 * Decision authority policy — who may promote which level (SD-00 §2.2), as
 * governed data instead of literals inside `promote.ts`.
 *
 * The catalog lives at `knowledge/product/governance/decision-authority-policy.json`
 * (schema `decision-authority-policy.schema.json`). `promote.ts` stays pure and
 * takes the policy as a parameter; {@link DEFAULT_DECISION_AUTHORITY_POLICY}
 * is the in-code fallback that mirrors the shipped catalog so pure callers
 * and tests need no I/O. Callers with I/O (the facade, the ledger) load the
 * catalog once with {@link loadDecisionAuthorityPolicy}.
 */
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import type { DecisionLevel } from './model.js';

export type DecidingRole = 'owner' | 'approver' | 'viewer';

export interface DecisionLevelPolicy {
  /** Front-desk roles that may promote this level on the product side. Empty = no member may. */
  deciding_roles: DecidingRole[];
  /** `product-axis`: a decision without enumerated options is not a decision yet. */
  requires_options?: boolean;
  /** `customer-value`: the record is decided only on behalf of a registered customer actor … */
  customer_actor_required?: boolean;
  /** … and only with that actor's approval evidence. */
  customer_evidence_required?: boolean;
}

export interface DecisionAuthorityPolicy {
  version: string;
  /** A decided record must carry at least one basis (where the decision comes from). */
  basis_required_for_decided: boolean;
  levels: Record<DecisionLevel, DecisionLevelPolicy>;
}

export const DEFAULT_DECISION_AUTHORITY_POLICY: DecisionAuthorityPolicy = {
  version: '1.0.0',
  basis_required_for_decided: true,
  levels: {
    'product-fixed': { deciding_roles: ['owner', 'approver'] },
    'product-axis': { deciding_roles: ['owner', 'approver'], requires_options: true },
    'customer-value': {
      deciding_roles: [],
      customer_actor_required: true,
      customer_evidence_required: true,
    },
    undecided: { deciding_roles: [] },
  },
};

const catalog = defineCatalog<DecisionAuthorityPolicy & { $schema?: string }>({
  id: 'decision-authority-policy',
  path: pathResolver.rootResolve('knowledge/product/governance/decision-authority-policy.json'),
  schema: pathResolver.rootResolve(
    'knowledge/product/schemas/decision-authority-policy.schema.json'
  ),
});

export function loadDecisionAuthorityPolicy(): DecisionAuthorityPolicy {
  const { $schema: _schema, ...policy } = catalog.load();
  void _schema;
  return policy;
}
