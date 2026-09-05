import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

const SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/specialist-catalog.schema.json'
);
const DIRECTORY = pathResolver.rootResolve('knowledge/product/orchestration/specialists');
const SNAPSHOT_PATH = pathResolver.rootResolve(
  'knowledge/product/orchestration/specialist-catalog.json'
);

type SpecialistCatalogPayload = {
  version?: string;
  specialists: Record<string, Record<string, unknown>>;
};

function loadSpecialistCatalog(filePath: string): SpecialistCatalogPayload {
  return defineCatalog<SpecialistCatalogPayload>({
    id: 'specialist-catalog',
    path: filePath,
    schema: SCHEMA_PATH,
  }).load();
}

function validate(value: unknown, sourcePath: string): SpecialistCatalogPayload {
  return defineCatalog<SpecialistCatalogPayload>({
    id: 'specialist-catalog',
    path: sourcePath,
    schema: SCHEMA_PATH,
  }).validate(value, sourcePath);
}

function render(): GeneratedFile[] {
  if (!safeExistsSync(DIRECTORY)) {
    throw new Error(`Specialist catalog directory not found: ${DIRECTORY}`);
  }

  const files = safeReaddir(DIRECTORY)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    throw new Error(`Specialist catalog directory is empty: ${DIRECTORY}`);
  }

  const merged: SpecialistCatalogPayload = {
    version: '1.0.0',
    specialists: {},
  };

  for (const file of files) {
    const filePath = path.join(DIRECTORY, file);
    const payload = loadSpecialistCatalog(filePath);

    const specialistIds = Object.keys(payload.specialists || {});
    if (specialistIds.length !== 1) {
      throw new Error(`Specialist catalog file ${file} must contain exactly one specialist`);
    }

    const specialistId = specialistIds[0];
    if (file.replace(/\.json$/i, '') !== specialistId) {
      throw new Error(`Specialist catalog file ${file} must match specialist id ${specialistId}`);
    }

    if (payload.version) {
      merged.version = merged.version || payload.version;
    }
    merged.specialists[specialistId] = payload.specialists[specialistId];
  }

  const snapshot: SpecialistCatalogPayload = {
    version: merged.version,
    specialists: Object.keys(merged.specialists)
      .sort()
      .reduce<Record<string, Record<string, unknown>>>((acc, specialistId) => {
        acc[specialistId] = merged.specialists[specialistId];
        return acc;
      }, {}),
  };

  validate(snapshot, SNAPSHOT_PATH);
  return [{ path: SNAPSHOT_PATH, content: `${JSON.stringify(snapshot, null, 2)}\n` }];
}

export const runSyncSpecialistCatalog = defineGenerator({
  id: 'specialist-catalog',
  outputs: [SNAPSHOT_PATH],
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_specialist_catalog.ts') ||
  isDirectScript(import.meta.url, 'sync_specialist_catalog.js')
)
  void runSyncSpecialistCatalog();
