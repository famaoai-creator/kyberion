import * as path from 'node:path';
import { Ajv } from 'ajv';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import {
  modelRegistryFileName,
  readModelRegistryDirectory,
  type ModelRegistryDirectoryIndex,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

const ajv = new Ajv({ allErrors: true });

const DIRECTORY = pathResolver.rootResolve('knowledge/product/governance/model-registry');
const INDEX_PATH = path.join(DIRECTORY, 'index.json');
const SNAPSHOT_PATH = pathResolver.rootResolve('knowledge/product/governance/model-registry.json');
const SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/model-registry.schema.json'
);

export type ModelRegistryEntry = Record<string, unknown> & { model_id: string };

export type ModelRegistrySnapshot = {
  version: string;
  default_model_id: string;
  models: ModelRegistryEntry[];
};

function readJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function validateSnapshot(value: unknown, label: string): asserts value is ModelRegistrySnapshot {
  const schema = readJson<Record<string, unknown>>(SCHEMA_PATH);
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`model-registry schema violation at ${label}: ${errors}`);
  }
}

function readDirectorySnapshot(): ModelRegistrySnapshot {
  const directory = readModelRegistryDirectory<ModelRegistryEntry>(DIRECTORY);
  if (!directory) throw new Error(`Model registry directory not found: ${DIRECTORY}`);
  const { index, modelsById } = directory;
  const snapshot: ModelRegistrySnapshot = {
    version: index.version,
    default_model_id: index.default_model_id,
    models: index.model_order.map((modelId) => modelsById.get(modelId)!),
  };
  validateSnapshot(snapshot, DIRECTORY);
  return snapshot;
}

export function bootstrapModelRegistryDirectory(): void {
  const snapshot = readJson<ModelRegistrySnapshot>(SNAPSHOT_PATH);
  validateSnapshot(snapshot, SNAPSHOT_PATH);
  safeMkdir(DIRECTORY, { recursive: true });

  const existingItems = safeReaddir(DIRECTORY).filter(
    (entry) => entry.endsWith('.json') && entry !== 'index.json'
  );
  if (existingItems.length) {
    throw new Error(`Refusing to bootstrap a non-empty model registry directory: ${DIRECTORY}`);
  }

  const index: ModelRegistryDirectoryIndex = {
    version: snapshot.version,
    default_model_id: snapshot.default_model_id,
    model_order: snapshot.models.map((model) => model.model_id),
  };
  safeWriteFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  for (const model of snapshot.models) {
    safeWriteFile(
      path.join(DIRECTORY, modelRegistryFileName(model.model_id)),
      `${JSON.stringify(model, null, 2)}\n`
    );
  }
}

export async function syncModelRegistrySnapshot(checkOnly = false): Promise<boolean> {
  const snapshot = withExecutionContext('ecosystem_architect', () => readDirectorySnapshot());
  const config = (await resolvePrettierConfig(SNAPSHOT_PATH)) ?? {};
  const expected = await prettierFormat(JSON.stringify(snapshot, null, 2), {
    ...config,
    parser: 'json',
  });
  return withExecutionContext('ecosystem_architect', () => {
    if (checkOnly) {
      if (!safeExistsSync(SNAPSHOT_PATH)) return false;
      return String(safeReadFile(SNAPSHOT_PATH, { encoding: 'utf8' }) || '') === expected;
    }
    safeWriteFile(SNAPSHOT_PATH, expected);
    return true;
  });
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--bootstrap')) {
    withExecutionContext('ecosystem_architect', () => {
      bootstrapModelRegistryDirectory();
      console.log(`[sync:model-registry] bootstrapped ${DIRECTORY}`);
    });
    return;
  }
  const checkOnly = args.has('--check');
  const ok = await syncModelRegistrySnapshot(checkOnly);
  if (!ok && checkOnly) {
    console.error('[sync:model-registry] snapshot is out of date; run pnpm sync:model-registry');
    process.exitCode = 1;
    return;
  }
  console.log(
    `[sync:model-registry] ${checkOnly ? 'snapshot is aligned' : `wrote ${SNAPSHOT_PATH}`}`
  );
}

const isDirectExecution =
  process.argv[1]?.endsWith('sync_model_registry.ts') ||
  process.argv[1]?.endsWith('sync_model_registry.js');
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
