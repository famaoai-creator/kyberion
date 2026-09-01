import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import {
  modelRegistryFileName,
  modelRegistrySnapshotFromDirectory,
  readModelRegistryDirectory,
  type ModelRegistryDirectoryIndex,
} from '@agent/core/model-registry-directory';
import { loadModelRegistry } from '@agent/core/reasoning-model-routing';
import type {
  GovernedModelRegistryEntry,
  GovernedModelRegistrySnapshot,
} from '@agent/core/model-registry-contract';
import { validateModelRegistrySnapshot } from '@agent/core/model-registry-contract';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

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

async function renderBootstrap(snapshot: ModelRegistrySnapshot): Promise<GeneratedFile[]> {
  if (safeExistsSync(DIRECTORY)) {
    const existingItems = safeReaddir(DIRECTORY).filter(
      (entry) => entry.endsWith('.json') && entry !== 'index.json'
    );
    if (existingItems.length) {
      throw new Error(`Refusing to bootstrap a non-empty model registry directory: ${DIRECTORY}`);
    }
  }

  const index: ModelRegistryDirectoryIndex = {
    version: snapshot.version,
    default_model_id: snapshot.default_model_id,
    model_order: snapshot.models.map((model) => model.model_id),
  };
  return [
    { path: INDEX_PATH, content: `${JSON.stringify(index, null, 2)}\n` },
    ...snapshot.models.map((model) => ({
      path: path.join(DIRECTORY, modelRegistryFileName(model.model_id)),
      content: `${JSON.stringify(model, null, 2)}\n`,
    })),
  ];
}

async function renderSnapshot(snapshot: ModelRegistrySnapshot): Promise<GeneratedFile> {
  const config = (await resolvePrettierConfig(SNAPSHOT_PATH)) ?? {};
  const expected = await prettierFormat(
    JSON.stringify(
      {
        $schema: '../schemas/model-registry.schema.json',
        ...snapshot,
      },
      null,
      2
    ),
    {
      ...config,
      parser: 'json',
    }
  );
  return { path: SNAPSHOT_PATH, content: expected };
}

async function render(context: { positional: string[] }): Promise<GeneratedFile[]> {
  if (context.positional.includes('--bootstrap')) {
    return renderBootstrap(loadModelRegistry());
  }
  return [await renderSnapshot(readDirectorySnapshot())];
}

const outputPaths = [
  SNAPSHOT_PATH,
  INDEX_PATH,
  ...loadModelRegistry().models.map((model) =>
    path.join(DIRECTORY, modelRegistryFileName(model.model_id))
  ),
];

export const runSyncModelRegistry = defineGenerator({
  id: 'model-registry',
  outputs: outputPaths,
  normalize: (content) =>
    JSON.stringify(parseSafeJsonObjectInput(content, 'model registry generated output')),
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_model_registry.ts') ||
  isDirectScript(import.meta.url, 'sync_model_registry.js')
)
  void runSyncModelRegistry();
