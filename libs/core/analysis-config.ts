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

function analysisConfigCatalog(filePath: string) {
  return defineCatalog<AnalysisConfig>({
    id: 'analysis-config',
    path: filePath,
    schema: ANALYSIS_CONFIG_SCHEMA_PATH,
  });
}

/** Load analysis configuration through the shared repository/schema boundary. */
export function loadAnalysisConfigAtPath(filePath = ANALYSIS_CONFIG_PATH): AnalysisConfig {
  return analysisConfigCatalog(filePath).load();
}
