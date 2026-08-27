import * as path from 'node:path';

import { loadJson, safeExistsSync, safeReaddir } from './secure-io.js';
import { isRecord } from './foundation/text.js';

export type ModelRegistryDirectoryIndex = {
  version: string;
  default_model_id: string;
  model_order: string[];
};

export type ModelRegistryDirectoryEntry<T> = {
  file: string;
  model: T;
};

export type ModelRegistryDirectory<T> = {
  index: ModelRegistryDirectoryIndex;
  entries: Array<ModelRegistryDirectoryEntry<T>>;
  modelsById: Map<string, T>;
};

export type ModelRegistryDirectorySnapshot<T> = {
  version: string;
  default_model_id: string;
  models: T[];
};

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertDirectoryIndex(value: unknown, indexPath: string): ModelRegistryDirectoryIndex {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'default_model_id', 'model_order'])) {
    throw new Error(`Invalid model registry directory index at ${indexPath}`);
  }

  const { version, default_model_id: defaultModelId, model_order: modelOrder } = value;
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    typeof defaultModelId !== 'string' ||
    defaultModelId.length === 0 ||
    !Array.isArray(modelOrder) ||
    modelOrder.length === 0 ||
    modelOrder.some((modelId) => typeof modelId !== 'string' || modelId.length === 0) ||
    new Set(modelOrder).size !== modelOrder.length ||
    !modelOrder.includes(defaultModelId)
  ) {
    throw new Error(`Invalid model registry directory index at ${indexPath}`);
  }

  return {
    version,
    default_model_id: defaultModelId,
    model_order: [...modelOrder],
  };
}

/**
 * Encode the canonical model ID as a portable, injective filename component.
 * Lowercase hex avoids path separators, Windows-reserved characters, and
 * case-folding collisions on case-insensitive filesystems, while remaining
 * injective instead of making lossy substitutions such as mapping both `a:b`
 * and `a--b` to the same filename.
 */
export function modelRegistryFileName(modelId: string): string {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('Model registry file name requires a non-empty model_id');
  }
  return `model-${Buffer.from(modelId, 'utf8').toString('hex')}.json`;
}

export function readModelRegistryDirectory<T extends { model_id?: unknown }>(
  directory: string
): ModelRegistryDirectory<T> | null {
  if (!safeExistsSync(directory)) return null;

  const indexPath = path.join(directory, 'index.json');
  if (!safeExistsSync(indexPath)) {
    throw new Error(`Model registry directory index missing at ${indexPath}`);
  }
  const index = assertDirectoryIndex(loadJson<unknown>(indexPath), indexPath);

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json') && entry !== 'index.json')
    .sort();
  if (!files.length) throw new Error(`Model registry directory is empty: ${directory}`);

  const entries: Array<ModelRegistryDirectoryEntry<T>> = [];
  const modelsById = new Map<string, T>();
  for (const file of files) {
    const model = loadJson<T>(path.join(directory, file));
    const modelId = model.model_id;
    if (typeof modelId !== 'string' || modelId.length === 0) {
      throw new Error(`Model registry item ${file} must define a non-empty string model_id`);
    }
    if (modelRegistryFileName(modelId) !== file) {
      throw new Error(`Model registry item ${file} must match model_id ${modelId}`);
    }
    if (modelsById.has(modelId)) throw new Error(`Duplicate model_id in directory: ${modelId}`);
    modelsById.set(modelId, model);
    entries.push({ file, model });
  }

  const directoryIds = [...modelsById.keys()].sort();
  const orderedIds = [...index.model_order].sort();
  if (JSON.stringify(directoryIds) !== JSON.stringify(orderedIds)) {
    throw new Error('Model registry directory items do not match index.model_order');
  }

  return { index, entries, modelsById };
}

export function modelRegistrySnapshotFromDirectory<T extends { model_id?: unknown }>(
  directory: ModelRegistryDirectory<T>
): ModelRegistryDirectorySnapshot<T> {
  return {
    version: directory.index.version,
    default_model_id: directory.index.default_model_id,
    models: directory.index.model_order.map((modelId) => {
      const model = directory.modelsById.get(modelId);
      if (!model) throw new Error(`Model registry directory is missing model ${modelId}`);
      return model;
    }),
  };
}
