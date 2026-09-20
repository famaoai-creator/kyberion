import { defineCatalog } from './foundation/governed-catalog.js';
import * as pathResolver from './path-resolver.js';
import type { MissionClassification } from './mission-classification.js';

/**
 * TC-03: the obligatory part of a mission team roster, derived from the
 * mission classification instead of from a template name.
 *
 * A mission team template (`mission-team-templates.json`) expresses the
 * *preference* of an organization: "for this kind of work we usually field
 * this line-up". It cannot express a *governance requirement*, because an
 * organization overlay may freely drop roles from it. This catalog is that
 * missing layer: every obligation whose `when` matches contributes roles the
 * roster must contain, and those roles survive template and overlay choices.
 *
 * TC-01 also reads `always_staffed_roles` from here: the structural roles a
 * mission staffs at creation time. Every other roster role starts on
 * standby (see `applyStaffingPolicy` in mission-team-plan-composer.ts) and
 * is staffed when work actually demands it.
 */
export interface TeamCompositionObligationRule {
  id: string;
  reason: string;
  when: {
    mission_class?: string[];
    delivery_shape?: string[];
    risk_profile?: string[];
    stage?: string[];
    tier?: Array<'personal' | 'confidential' | 'public'>;
  };
  require_roles: string[];
}

export interface TeamCompositionObligationsCatalog {
  version: string;
  always_staffed_roles: string[];
  obligations: TeamCompositionObligationRule[];
}

export interface MatchedTeamCompositionObligation {
  id: string;
  reason: string;
  require_roles: string[];
}

const OBLIGATIONS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/team-composition-obligations.schema.json'
);

const FALLBACK: TeamCompositionObligationsCatalog = {
  version: '1.0.0',
  always_staffed_roles: ['owner', 'orchestrator'],
  obligations: [],
};

const obligationsCatalog = defineCatalog<TeamCompositionObligationsCatalog>({
  id: 'team-composition-obligations',
  path: () => pathResolver.knowledge('product/governance/team-composition-obligations.json'),
  schema: OBLIGATIONS_SCHEMA_PATH,
  fallback: FALLBACK,
});

export function loadTeamCompositionObligations(): TeamCompositionObligationsCatalog {
  return obligationsCatalog.load();
}

export function resetTeamCompositionObligations(): void {
  obligationsCatalog.reset();
}

/** Structural roles a mission staffs at creation time (TC-01). */
export function resolveAlwaysStaffedRoles(): Set<string> {
  return new Set(loadTeamCompositionObligations().always_staffed_roles);
}

function facetMatches(declared: string[] | undefined, actual: string | undefined): boolean {
  if (!declared || declared.length === 0) return true;
  if (!actual) return false;
  return declared.includes(actual);
}

export interface TeamCompositionObligationInput {
  classification?: MissionClassification;
  tier?: 'personal' | 'confidential' | 'public';
}

/**
 * Every rule whose declared facets all match, in catalog order. Facets are
 * AND-ed across kinds and OR-ed within one kind; a rule with an empty `when`
 * applies to every mission.
 */
export function matchTeamCompositionObligations(
  input: TeamCompositionObligationInput
): MatchedTeamCompositionObligation[] {
  const classification = input.classification;
  return loadTeamCompositionObligations()
    .obligations.filter(
      (rule) =>
        facetMatches(rule.when.mission_class, classification?.mission_class) &&
        facetMatches(rule.when.delivery_shape, classification?.delivery_shape) &&
        facetMatches(rule.when.risk_profile, classification?.risk_profile) &&
        facetMatches(rule.when.stage, classification?.stage) &&
        facetMatches(rule.when.tier, input.tier)
    )
    .map((rule) => ({
      id: rule.id,
      reason: rule.reason,
      require_roles: [...rule.require_roles],
    }));
}

/** Roles the matched obligations require, in first-match order. */
export function resolveObligatoryRoles(input: TeamCompositionObligationInput): string[] {
  const roles: string[] = [];
  for (const obligation of matchTeamCompositionObligations(input)) {
    for (const role of obligation.require_roles) {
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}
