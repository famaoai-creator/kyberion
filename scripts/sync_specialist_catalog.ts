import * as path from 'node:path';
import AjvModule from 'ajv';
import { pathResolver, safeExistsSync, safeReaddir, safeReadFile, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

const SCHEMA_PATH = pathResolver.rootResolve('knowledge/public/schemas/specialist-catalog.schema.json');
const DIRECTORY = pathResolver.rootResolve('knowledge/public/orchestration/specialists');
const SNAPSHOT_PATH = pathResolver.rootResolve('knowledge/public/orchestration/specialist-catalog.json');

type SpecialistCatalogPayload = {
  version?: string;
  specialists: Record<string, Record<string, unknown>>;
};

function readJson<T>(absPath: string): T {
  return JSON.parse(safeReadFile(absPath, { encoding: 'utf8' }) as string) as T;
}

function validate(value: unknown): asserts value is SpecialistCatalogPayload {
  const schema = readJson(SCHEMA_PATH);
  const check = ajv.compile(schema);
  if (!check(value)) {
    const errors = (check.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`specialist-catalog schema violation: ${errors}`);
  }
}

function main(): void {
  withExecutionContext('ecosystem_architect', () => {
    if (!safeExistsSync(DIRECTORY)) {
      throw new Error(`Specialist catalog directory not found: ${DIRECTORY}`);
    }

    const files = safeReaddir(DIRECTORY).filter((entry) => entry.endsWith('.json')).sort();
    if (!files.length) {
      throw new Error(`Specialist catalog directory is empty: ${DIRECTORY}`);
    }

    const merged: SpecialistCatalogPayload = {
      version: '1.0.0',
      specialists: {},
    };

    for (const file of files) {
      const filePath = path.join(DIRECTORY, file);
      const payload = readJson<SpecialistCatalogPayload>(filePath);
      validate(payload);

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

    validate(snapshot);
    safeWriteFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`[sync:specialist-catalog] wrote ${SNAPSHOT_PATH}`);
  }, 'ecosystem_architect');
}

main();
