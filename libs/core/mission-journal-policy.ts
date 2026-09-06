import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MissionJournalPolicyCatalog {
  version: string;
  title: string;
  summary_title: string;
  trust_scores_title: string;
  empty_message: string;
  relationship_labels: {
    prerequisites: string;
    successors: string;
  };
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/mission-journal-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-journal-policy.schema.json');

const catalog = defineCatalog<MissionJournalPolicyCatalog>({
  id: 'mission-journal-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMissionJournalPolicyCatalog(): MissionJournalPolicyCatalog {
  return catalog.load();
}

export function resolveMissionJournalPolicy(): MissionJournalPolicyCatalog {
  return loadMissionJournalPolicyCatalog();
}
