import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface PilotStrategyPolicyCatalog {
  version: string;
  title: string;
  target: string;
  value_proposition_title: string;
  market_strategy_title: string;
  key_benefits_title: string;
  phase_titles: {
    education: string;
    pilot: string;
    expansion: string;
  };
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/pilot-strategy-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/pilot-strategy-policy.schema.json');

const FALLBACK_CATALOG: PilotStrategyPolicyCatalog = {
  version: '1.0.0',
  title: 'Kyberion AI Consulting: Go-to-Market Strategy',
  target: 'Japanese Mid-sized Enterprise (SMB) Managers',
  value_proposition_title: 'Value Proposition: "Safety through Governance"',
  market_strategy_title: 'Market Strategy (Japanese SMB Focus)',
  key_benefits_title: 'Key Benefits',
  phase_titles: {
    education: 'Education',
    pilot: 'Pilot',
    expansion: 'Expansion',
  },
};

const catalog = defineCatalog<PilotStrategyPolicyCatalog>({
  id: 'pilot-strategy-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadPilotStrategyPolicyCatalog(): PilotStrategyPolicyCatalog {
  return catalog.load();
}

export function resolvePilotStrategyPolicy(): PilotStrategyPolicyCatalog {
  return loadPilotStrategyPolicyCatalog();
}

export function resetPilotStrategyPolicyCatalogCache(): void {
  catalog.reset();
}
