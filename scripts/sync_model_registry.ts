import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import {
  loadJson,
  modelRegistryFileName,
  modelRegistrySnapshotFromDirectory,
  readModelRegistryDirectory,
  type ModelRegistryDirectoryIndex,
  type GovernedModelRegistryEntry,
  type GovernedModelRegistrySnapshot,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
  validateModelRegistrySnapshot,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript } from './lib/harness.js';

const DIRECTORY = pathResolver.rootResolve('knowledge/product/governance/model-registry');
const INDEX_PATH = path.join(DIRECTORY, 'index.json');
const SNAPSHOT_PATH = pathResolver.rootResolve('knowledge/product/governance/model-registry.json');
export type ModelRegistryEntry = GovernedModelRegistryEntry;
export type ModelRegistrySnapshot = GovernedModelRegistrySnapshot<ModelRegistryEntry>;

function readDirectorySnapshot(): ModelRegistrySnapshot {
  const directory = readModelRegistryDirectory<ModelRegistryEntry>(DIRECTORY);
  if (!directory) throw new Error(`Model registry directory not found: ${DIRECTORY}`);
  return validateModelRegistrySnapshot(modelRegistrySnapshotFromDirectory(directory), DIRECTORY);
}

export function bootstrapModelRegistryDirectory(): void {
  const snapshot = validateModelRegistrySnapshot(
    loadJson<ModelRegistrySnapshot>(SNAPSHOT_PATH),
    SNAPSHOT_PATH
  );
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

export const runSyncModelRegistry = defineScript({
  name: 'sync:model-registry',
  async run(context) {
    if (context.positional.includes('--bootstrap')) {
      withExecutionContext('ecosystem_architect', () => {
        bootstrapModelRegistryDirectory();
        context.print(`[sync:model-registry] bootstrapped ${DIRECTORY}`);
      });
      return;
    }
    const checkOnly = context.check;
    const ok = await syncModelRegistrySnapshot(checkOnly);
    if (!ok && checkOnly) {
      throw new Error('snapshot is out of date; run pnpm sync:model-registry');
    }
    context.print(
      `[sync:model-registry] ${checkOnly ? 'snapshot is aligned' : `wrote ${SNAPSHOT_PATH}`}`
    );
  },
});

if (
  isDirectScript(import.meta.url, 'sync_model_registry.ts') ||
  isDirectScript(import.meta.url, 'sync_model_registry.js')
)
  void runSyncModelRegistry();
