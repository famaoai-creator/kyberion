import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MissionDistillMarkdownPolicyCatalog {
  version: string;
  title_suffix: string;
  section_titles: {
    summary: string;
    key_learnings: string;
    patterns_discovered: string;
    failures_and_recoveries: string;
    reusable_artifacts: string;
  };
  prompt_titles: {
    mission_state: string;
    evidence_context: string;
  };
}

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/mission-distill-markdown-policy.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-distill-markdown-policy.schema.json'
);

const catalog = defineCatalog<MissionDistillMarkdownPolicyCatalog>({
  id: 'mission-distill-markdown-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMissionDistillMarkdownPolicyCatalog(): MissionDistillMarkdownPolicyCatalog {
  return catalog.load();
}

export function resolveMissionDistillMarkdownPolicy(): MissionDistillMarkdownPolicyCatalog {
  return loadMissionDistillMarkdownPolicyCatalog();
}
