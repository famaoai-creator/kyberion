import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface GoldenOutputRegistryEntry {
  id: string;
  pipeline: string;
  note?: string;
  input?: Record<string, unknown>;
  ignore_paths?: string[];
}

export interface GoldenOutputSnapshot {
  generated_at: string;
  pipeline_id: string;
  pipeline_path: string;
  result_hash: string;
  result: unknown;
}

const GOLDEN_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/golden-output-registry.schema.json'
);
const GOLDEN_SNAPSHOT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/golden-output-snapshot.schema.json'
);

export function loadGoldenOutputRegistryAtPath(
  filePath = pathResolver.rootResolve('tests/golden/pipelines.json')
): GoldenOutputRegistryEntry[] {
  return defineCatalog<GoldenOutputRegistryEntry[]>({
    id: 'golden-output-registry',
    path: filePath,
    schema: GOLDEN_REGISTRY_SCHEMA_PATH,
  }).load();
}

export function loadGoldenOutputSnapshotAtPath(filePath: string): GoldenOutputSnapshot {
  return defineCatalog<GoldenOutputSnapshot>({
    id: 'golden-output-snapshot',
    path: filePath,
    schema: GOLDEN_SNAPSHOT_SCHEMA_PATH,
  }).load();
}
