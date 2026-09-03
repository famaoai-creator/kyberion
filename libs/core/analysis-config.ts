import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface AnalysisConfig {
  version: string;
  name: string;
  description: string;
  algorithms: {
    cooccurrence: {
      pipeline_dir: string;
      capability_dir: string;
      threshold: number;
    };
    ranking: {
      index_path: string;
      weights: Record<string, number>;
    };
    graph: {
      knowledge_dir: string;
      output_path: string;
      mermaid_theme: string;
    };
  };
  auto_update: {
    related_capabilities: boolean;
    related_knowledge: boolean;
  };
}

const ANALYSIS_CONFIG_PATH = pathResolver.knowledge('product/governance/analysis-config.json');
const ANALYSIS_CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/analysis-config.schema.json'
);

const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  version: 'fallback',
  name: 'Context Analysis Configuration',
  description: 'Safe defaults for context analysis.',
  algorithms: {
    cooccurrence: { pipeline_dir: 'pipelines', capability_dir: 'libs/actuators', threshold: 1 },
    ranking: {
      index_path: 'knowledge/orchestration/knowledge_index.json',
      weights: {
        title: 10,
        id: 5,
        tag: 15,
        category: 3,
        role: 25,
        phase: 18,
        scope: 12,
        kind: 10,
        authority: 8,
        usage_yield: 4,
      },
    },
    graph: {
      knowledge_dir: 'knowledge',
      output_path: 'knowledge/Ecosystem_Map.md',
      mermaid_theme: 'base',
    },
  },
  auto_update: { related_capabilities: true, related_knowledge: true },
};

function analysisConfigCatalog(filePath: string) {
  return defineCatalog<AnalysisConfig>({
    id: 'analysis-config',
    path: filePath,
    schema: ANALYSIS_CONFIG_SCHEMA_PATH,
    fallback: DEFAULT_ANALYSIS_CONFIG,
    fallbackOnInvalid: true,
  });
}

/** Load analysis configuration through the shared repository/schema boundary. */
export function loadAnalysisConfigAtPath(filePath = ANALYSIS_CONFIG_PATH): AnalysisConfig {
  return analysisConfigCatalog(filePath).load();
}
