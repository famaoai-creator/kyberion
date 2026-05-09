import * as path from 'node:path';
import AjvModule from 'ajv';
import { pathResolver, safeExistsSync, safeReaddir, safeReadFile, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

const SCHEMA_PATH = pathResolver.rootResolve('knowledge/public/schemas/service-endpoints.schema.json');
const DIRECTORY = pathResolver.rootResolve('knowledge/public/orchestration/service-endpoints');
const SNAPSHOT_PATH = pathResolver.rootResolve('knowledge/public/orchestration/service-endpoints.json');

type ServiceEndpointPayload = {
  default_pattern: string;
  version?: string;
  services: Record<string, Record<string, unknown>>;
};

function readJson<T>(absPath: string): T {
  return JSON.parse(safeReadFile(absPath, { encoding: 'utf8' }) as string) as T;
}

function validate(value: unknown): asserts value is ServiceEndpointPayload {
  const schema = JSON.parse(safeReadFile(SCHEMA_PATH, { encoding: 'utf8' }) as string);
  const check = ajv.compile(schema);
  if (!check(value)) {
    const errors = (check.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`service-endpoints schema violation: ${errors}`);
  }
}

function main(): void {
  withExecutionContext('ecosystem_architect', () => {
    if (!safeExistsSync(DIRECTORY)) {
      throw new Error(`Service endpoints directory not found: ${DIRECTORY}`);
    }

    const files = safeReaddir(DIRECTORY).filter((entry) => entry.endsWith('.json')).sort();
    if (files.length === 0) {
      throw new Error(`Service endpoints directory is empty: ${DIRECTORY}`);
    }

    const merged: ServiceEndpointPayload = {
      default_pattern: '',
      services: {},
    };
    let version = '';

    for (const file of files) {
      const filePath = path.join(DIRECTORY, file);
      const payload = readJson<ServiceEndpointPayload>(filePath);
      validate(payload);

      const serviceIds = Object.keys(payload.services || {});
      if (serviceIds.length !== 1) {
        throw new Error(`Service endpoints file ${file} must contain exactly one service`);
      }

      const serviceId = serviceIds[0];
      if (file.replace(/\.json$/i, '') !== serviceId) {
        throw new Error(`Service endpoints file ${file} must match service id ${serviceId}`);
      }

      if (!merged.default_pattern) {
        merged.default_pattern = payload.default_pattern;
      } else if (merged.default_pattern !== payload.default_pattern) {
        throw new Error(`Service endpoints default_pattern mismatch in ${file}`);
      }

      if (!version && payload.version) {
        version = payload.version;
      } else if (payload.version && version && payload.version !== version) {
        throw new Error(`Service endpoints version mismatch in ${file}`);
      }

      merged.services[serviceId] = payload.services[serviceId];
    }

    const snapshot: Record<string, unknown> = {
      ...(version ? { version } : {}),
      default_pattern: merged.default_pattern,
      services: Object.keys(merged.services)
        .sort()
        .reduce<Record<string, Record<string, unknown>>>((acc, serviceId) => {
          acc[serviceId] = merged.services[serviceId];
          return acc;
        }, {}),
    };

    validate(snapshot);
    safeWriteFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`[sync:service-endpoints] wrote ${SNAPSHOT_PATH}`);
  }, 'ecosystem_architect');
}

main();
