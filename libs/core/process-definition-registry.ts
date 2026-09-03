import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export type ProcessDefinitionKind =
  'mission_workflow_catalog' | 'scenario_pack' | 'playbook_directory' | 'phase_directory';

export type ProcessExecutionRole = 'runtime' | 'validation' | 'knowledge' | 'protocol';

export interface ProcessDefinitionSource {
  id: string;
  kind: ProcessDefinitionKind;
  path: string;
  execution_role: ProcessExecutionRole;
  consumer_paths: string[];
  expected_counts?: Record<string, number>;
  expected_entries?: string[];
}

export interface ProcessDefinitionRegistry {
  version: string;
  sources: ProcessDefinitionSource[];
}

export interface ProcessDefinitionSourceAudit {
  id: string;
  kind: ProcessDefinitionKind;
  execution_role: ProcessExecutionRole;
  path: string;
  exists: boolean;
  actual_counts?: Record<string, number>;
  expected_counts?: Record<string, number>;
  missing_entries?: string[];
  unexpected_entries?: string[];
  missing_consumer_paths?: string[];
  consumer_paths: string[];
}

export interface ProcessDefinitionRegistryAudit {
  ok: boolean;
  version: string;
  sources: ProcessDefinitionSourceAudit[];
  errors: string[];
}

const REGISTRY_PATH = assertSafeRepositoryPath(
  pathResolver.knowledge('product/governance/process-definition-registry.json')
);

const registryCatalog = defineCatalog<ProcessDefinitionRegistry>({
  id: 'process-definition-registry',
  path: REGISTRY_PATH,
  schema: pathResolver.knowledge('product/schemas/process-definition-registry.schema.json'),
});

const JSON_SOURCE_SCHEMA_BY_ID: Record<string, string> = {
  'mission-workflow-catalog': pathResolver.knowledge(
    'product/schemas/mission-workflow-catalog.schema.json'
  ),
  'mission-orchestration-scenarios': pathResolver.knowledge(
    'product/schemas/mission-orchestration-scenario-pack.schema.json'
  ),
  'mission-task-classification-scenarios': pathResolver.knowledge(
    'product/schemas/mission-task-classification-scenarios.schema.json'
  ),
};

export function loadProcessDefinitionRegistry(): ProcessDefinitionRegistry {
  return registryCatalog.load();
}

function rootPath(relativePath: string): string {
  return assertSafeRepositoryPath(relativePath, { allowMissingLeaf: true });
}

function countJsonArray(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return -1;
}

function sortedEntries(path: string): string[] {
  return safeReaddir(path)
    .filter((entry) => !entry.startsWith('.'))
    .sort();
}

function loadJsonSourceAtPath(source: ProcessDefinitionSource, filePath: string) {
  const schema = JSON_SOURCE_SCHEMA_BY_ID[source.id];
  if (!schema) {
    throw new Error(`[PROCESS_DEFINITION] no schema registered for ${source.id}`);
  }
  return defineCatalog<Record<string, unknown>>({
    id: `process-definition-source-${source.id}`,
    path: filePath,
    schema,
  }).load();
}

export function auditProcessDefinitionRegistry(
  registry = loadProcessDefinitionRegistry()
): ProcessDefinitionRegistryAudit {
  const errors: string[] = [];
  const sources: ProcessDefinitionSourceAudit[] = [];

  for (const source of registry.sources) {
    const resolved = rootPath(source.path);
    const exists = safeExistsSync(resolved);
    const audit: ProcessDefinitionSourceAudit = {
      id: source.id,
      kind: source.kind,
      execution_role: source.execution_role,
      path: source.path,
      exists,
      consumer_paths: source.consumer_paths,
    };
    audit.missing_consumer_paths = source.consumer_paths.filter(
      (consumerPath) => !safeExistsSync(rootPath(consumerPath))
    );
    if (audit.missing_consumer_paths.length > 0) {
      errors.push(
        `${source.id}: missing consumer paths ${audit.missing_consumer_paths.join(', ')}`
      );
    }
    if (!exists) {
      errors.push(`${source.id}: missing ${source.path}`);
      sources.push(audit);
      continue;
    }

    if (source.kind === 'playbook_directory' || source.kind === 'phase_directory') {
      if (!safeLstat(resolved).isDirectory()) {
        errors.push(`${source.id}: expected directory ${source.path}`);
        sources.push(audit);
        continue;
      }
      const actual = sortedEntries(resolved);
      const expected = [...(source.expected_entries ?? [])].sort();
      audit.missing_entries = expected.filter((entry) => !actual.includes(entry));
      audit.unexpected_entries = actual.filter((entry) => !expected.includes(entry));
      if (audit.missing_entries.length > 0) {
        errors.push(`${source.id}: missing entries ${audit.missing_entries.join(', ')}`);
      }
      if (audit.unexpected_entries.length > 0) {
        errors.push(`${source.id}: unexpected entries ${audit.unexpected_entries.join(', ')}`);
      }
      sources.push(audit);
      continue;
    }

    if (!safeLstat(resolved).isFile()) {
      errors.push(`${source.id}: expected file ${source.path}`);
      sources.push(audit);
      continue;
    }
    const payload = loadJsonSourceAtPath(source, resolved);
    const actualCounts: Record<string, number> = {};
    for (const key of Object.keys(source.expected_counts ?? {})) {
      actualCounts[key] = countJsonArray(payload, key);
      const expected = source.expected_counts?.[key];
      if (actualCounts[key] !== expected) {
        errors.push(
          `${source.id}: ${key} expected ${String(expected)}, got ${String(actualCounts[key])}`
        );
      }
    }
    audit.actual_counts = actualCounts;
    audit.expected_counts = source.expected_counts;
    sources.push(audit);
  }

  return { ok: errors.length === 0, version: registry.version, sources, errors };
}

export function assertProcessDefinitionRegistry(): ProcessDefinitionRegistryAudit {
  const audit = auditProcessDefinitionRegistry();
  if (!audit.ok) {
    throw new Error(`Process definition registry invalid:\n- ${audit.errors.join('\n- ')}`);
  }
  return audit;
}
