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

const FALLBACK_CATALOG: MissionDistillMarkdownPolicyCatalog = {
  version: '1.0.0',
  title_suffix: 'Completion Summary',
  section_titles: {
    summary: 'Summary',
    key_learnings: 'Key Learnings',
    patterns_discovered: 'Patterns Discovered',
    failures_and_recoveries: 'Failures & Recoveries',
    reusable_artifacts: 'Reusable Artifacts',
  },
  prompt_titles: {
    mission_state: 'Mission State',
    evidence_context: 'Evidence & Context',
  },
};

const catalog = defineCatalog<MissionDistillMarkdownPolicyCatalog>({
  id: 'mission-distill-markdown-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadMissionDistillMarkdownPolicyCatalog(): MissionDistillMarkdownPolicyCatalog {
  return catalog.load();
}

export function resolveMissionDistillMarkdownPolicy(): MissionDistillMarkdownPolicyCatalog {
  return loadMissionDistillMarkdownPolicyCatalog();
}
