import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

const SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/service-endpoints.schema.json'
);
const DIRECTORY = pathResolver.rootResolve('knowledge/product/orchestration/service-endpoints');
const SNAPSHOT_PATH = pathResolver.rootResolve(
  'knowledge/product/orchestration/service-endpoints.json'
);

type ServiceEndpointPayload = {
  default_pattern: string;
  version?: string;
  services: Record<string, Record<string, unknown>>;
};

function endpointCatalog(filePath: string) {
  return defineCatalog<ServiceEndpointPayload>({
    id: 'service-endpoints-entry',
    path: filePath,
    schema: SCHEMA_PATH,
  });
}

function loadEndpointFile(filePath: string): ServiceEndpointPayload {
  return endpointCatalog(filePath).load();
}

function validate(value: unknown, sourcePath: string): asserts value is ServiceEndpointPayload {
  endpointCatalog(sourcePath).validate(value, sourcePath);
}

function render(): GeneratedFile[] {
  if (!safeExistsSync(DIRECTORY)) {
    throw new Error(`Service endpoints directory not found: ${DIRECTORY}`);
  }

  const files = safeReaddir(DIRECTORY)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
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
    const payload = loadEndpointFile(filePath);

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

  validate(snapshot, SNAPSHOT_PATH);
  return [{ path: SNAPSHOT_PATH, content: `${JSON.stringify(snapshot, null, 2)}\n` }];
}

export const runSyncServiceEndpoints = defineGenerator({
  id: 'service-endpoints',
  outputs: [SNAPSHOT_PATH],
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_service_endpoints.ts') ||
  isDirectScript(import.meta.url, 'sync_service_endpoints.js')
)
  void runSyncServiceEndpoints();
