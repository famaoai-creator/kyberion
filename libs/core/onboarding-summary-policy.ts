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

const FALLBACK_CATALOG: OnboardingSummaryPolicyCatalog = {
  version: '1.0.0',
  title: 'Kyberion Onboarding Summary',
  sections: {
    identity: 'Identity',
    services: 'Services',
    tenants: 'Tenants',
    tutorial: 'Tutorial',
    next_steps: 'Next Steps',
  },
  empty_states: {
    services: 'None captured yet',
    tenants: 'None registered yet',
  },
};

const catalog = defineCatalog<OnboardingSummaryPolicyCatalog>({
  id: 'onboarding-summary-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadOnboardingSummaryPolicyCatalog(): OnboardingSummaryPolicyCatalog {
  return catalog.load();
}

export function resolveOnboardingSummaryPolicy(): OnboardingSummaryPolicyCatalog {
  return loadOnboardingSummaryPolicyCatalog();
}
