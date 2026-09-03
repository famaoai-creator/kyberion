import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadAnalysisConfigAtPath, type AnalysisConfig } from './analysis-config.js';

const TEST_ROOT = pathResolver.sharedTmp(`analysis-config-test/${process.pid}`);
const TEST_PATH = `${TEST_ROOT}/analysis-config.json`;

const validConfig: AnalysisConfig = {
  version: '1.0.0',
  name: 'test analysis config',
  description: 'test config',
  algorithms: {
    cooccurrence: { pipeline_dir: 'pipelines', capability_dir: 'libs/actuators', threshold: 1 },
    ranking: { index_path: 'knowledge/index.json', weights: { title: 10, role: 20 } },
    graph: { knowledge_dir: 'knowledge', output_path: 'knowledge/map.md', mermaid_theme: 'base' },
  },
  auto_update: { related_capabilities: true, related_knowledge: false },
};

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('analysis config contract', () => {
  it('loads a schema-valid config through the canonical loader', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(TEST_PATH, JSON.stringify(validConfig));

    expect(loadAnalysisConfigAtPath(TEST_PATH)).toEqual(validConfig);
  });

  it('uses the governed fallback for missing and schema-invalid configs', () => {
    const missing = loadAnalysisConfigAtPath(TEST_PATH);
    expect(missing.version).toBe('fallback');

    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(TEST_PATH, JSON.stringify({ algorithms: { ranking: { weights: [] } } }));
    expect(loadAnalysisConfigAtPath(TEST_PATH).version).toBe('fallback');
  });

  it('rejects a config path outside the repository', () => {
    expect(() => loadAnalysisConfigAtPath('../analysis-config.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });
});
