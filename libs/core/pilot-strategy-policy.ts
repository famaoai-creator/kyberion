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

const catalog = defineCatalog<PilotStrategyPolicyCatalog>({
  id: 'pilot-strategy-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadPilotStrategyPolicyCatalog(): PilotStrategyPolicyCatalog {
  return catalog.load();
}

export function resolvePilotStrategyPolicy(): PilotStrategyPolicyCatalog {
  return loadPilotStrategyPolicyCatalog();
}
