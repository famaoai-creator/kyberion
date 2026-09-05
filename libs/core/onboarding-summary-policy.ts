import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface OnboardingSummaryPolicyCatalog {
  version: string;
  title: string;
  sections: {
    identity: string;
    services: string;
    tenants: string;
    tutorial: string;
    next_steps: string;
  };
  empty_states: {
    services: string;
    tenants: string;
  };
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/onboarding-summary-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/onboarding-summary-policy.schema.json');

const catalog = defineCatalog<OnboardingSummaryPolicyCatalog>({
  id: 'onboarding-summary-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadOnboardingSummaryPolicyCatalog(): OnboardingSummaryPolicyCatalog {
  return catalog.load();
}

export function resolveOnboardingSummaryPolicy(): OnboardingSummaryPolicyCatalog {
  return loadOnboardingSummaryPolicyCatalog();
}
