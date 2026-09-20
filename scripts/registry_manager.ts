import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { defineCatalog, nowIso } from '@agent/core/foundation';
import yargs from 'yargs';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

type RegistryType = 'harness' | 'gateway';

type CapabilityRegistry = {
  version: string;
  capabilities: Array<Record<string, unknown>>;
};

const REGISTRY_SCHEMA_PATHS: Record<RegistryType, string> = {
  harness: pathResolver.knowledge('product/schemas/harness-capability-registry.schema.json'),
  gateway: pathResolver.knowledge('product/schemas/gateway-capability-registry.schema.json'),
};
const ADAPTER_SCHEMA_PATHS: Record<RegistryType, string> = {
  harness: pathResolver.knowledge('product/schemas/harness-capability-entry.schema.json'),
  gateway: pathResolver.knowledge('product/schemas/gateway-adapter-profile.schema.json'),
};

export function loadAdapterPayloadAtPath(
  adapterPath: string,
  type: RegistryType
): Record<string, unknown> {
  return defineCatalog<Record<string, unknown>>({
    id: `registry-manager-${type}-adapter`,
    path: assertSafeRepositoryPath(adapterPath),
    schema: ADAPTER_SCHEMA_PATHS[type],
  }).load();
}

export function loadCapabilityRegistryAtPath(
  registryPath: string,
  type: RegistryType
): CapabilityRegistry {
  const absPath = assertSafeRepositoryPath(registryPath, { allowMissingLeaf: true });
  if (safeExistsSync(absPath) && safeLstat(absPath).isDirectory()) {
    return loadCapabilityRegistryDirectory(absPath, type);
  }
  if (!safeExistsSync(absPath)) {
    return { version: '1.0.0', capabilities: [] };
  }
  return defineCatalog<CapabilityRegistry>({
    id: `registry-manager-${type}-registry`,
    path: absPath,
    schema: REGISTRY_SCHEMA_PATHS[type],
  }).load();
}

/** Merge every per-item envelope in a registry directory (RSP-11+ canonical). */
export function loadCapabilityRegistryDirectory(
  dirPath: string,
  type: RegistryType
): CapabilityRegistry {
  const absDir = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  const merged: CapabilityRegistry = { version: '1.0.0', capabilities: [] };
  if (!safeExistsSync(absDir)) return merged;
  const files = safeReaddir(absDir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'index.json')
    .sort();
  for (const file of files) {
    const envelope = defineCatalog<CapabilityRegistry>({
      id: `registry-manager-${type}-registry`,
      path: assertSafeRepositoryPath(path.join(absDir, file)),
      schema: REGISTRY_SCHEMA_PATHS[type],
    }).load();
    if (!Array.isArray(envelope.capabilities) || envelope.capabilities.length !== 1) {
      throw new Error(`Registry file ${file} must contain exactly one capability`);
    }
    const item = envelope.capabilities[0] as Record<string, unknown>;
    const itemId = String(item.capability_id || '');
    if (!itemId || `${itemId}.json` !== file) {
      throw new Error(`Registry file ${file} must match its capability_id (${itemId})`);
    }
    if (merged.capabilities.some((entry) => entry.capability_id === itemId)) {
      throw new Error(`Duplicate capability_id in registry directory: ${itemId}`);
    }
    merged.version = String(
      (envelope as unknown as Record<string, unknown>)['version'] || merged.version
    );
    merged.capabilities.push(item);
  }
  merged.capabilities.sort((left, right) =>
    String(left.capability_id).localeCompare(String(right.capability_id))
  );
  return merged;
}

/** Persist one capability as a per-item envelope file in the registry directory. */
export function writeCapabilityRegistryItem(
  dirPath: string,
  type: RegistryType,
  version: string,
  item: Record<string, unknown>
): string {
  const absDir = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  const itemId = String(item.capability_id || '');
  if (!itemId) throw new Error('Capability item missing capability_id');
  safeMkdir(absDir, { recursive: true });
  const envelope = { version, capabilities: [item] };
  const validated = defineCatalog<CapabilityRegistry>({
    id: `registry-manager-${type}-registry`,
    path: assertSafeRepositoryPath(path.join(absDir, `${itemId}.json`), {
      allowMissingLeaf: true,
    }),
    schema: REGISTRY_SCHEMA_PATHS[type],
  }).validate(envelope, `${itemId}.json`);
  const target = assertSafeRepositoryPath(path.join(absDir, `${itemId}.json`), {
    allowMissingLeaf: true,
  });
  safeWriteFile(target, JSON.stringify(validated, null, 2));
  return target;
}

export function validateCapabilityRegistry(
  registryPath: string,
  type: RegistryType,
  registry: CapabilityRegistry
): CapabilityRegistry {
  return defineCatalog<CapabilityRegistry>({
    id: `registry-manager-${type}-registry`,
    path: assertSafeRepositoryPath(registryPath, { allowMissingLeaf: true }),
    schema: REGISTRY_SCHEMA_PATHS[type],
  }).validate(registry, registryPath);
}

export async function main(args: string[] = [], print: Print = () => undefined) {
  const argv = await yargs(args)
    .option('adapter', {
      type: 'string',
      demandOption: true,
      describe: 'Path to the generated JSON profile/capability',
    })
    .option('tier', {
      type: 'string',
      choices: ['public', 'confidential', 'personal'],
      default: 'public',
      describe: 'Knowledge tier to register into',
    })
    .option('type', {
      type: 'string',
      choices: ['harness', 'gateway'],
      demandOption: true,
      describe: 'Registry type',
    })
    .parse();

  const adapterPath = assertSafeRepositoryPath(pathResolver.resolve(argv.adapter), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(adapterPath)) {
    throw new Error(`Input file not found: ${adapterPath}`);
  }
  if (!safeLstat(adapterPath).isFile()) {
    throw new Error(`Input adapter must be a regular file: ${adapterPath}`);
  }

  const type = argv.type as RegistryType;
  const payload = loadAdapterPayloadAtPath(adapterPath, type);
  const capabilityId = payload.capability_id || payload.id;
  if (!capabilityId) {
    throw new Error('Payload missing capability_id');
  }

  // Determine target directory based on tier (RSP-11+: per-item canonical files).
  const tierDir =
    argv.tier === 'public' ? 'knowledge/product/governance' : `knowledge/${argv.tier}/governance`;
  const registryDirRel = `${tierDir}/${argv.type}-capabilities`;
  const absRegistryDir = assertSafeRepositoryPath(pathResolver.rootResolve(registryDirRel), {
    allowMissingLeaf: true,
  });
  const absTierDir = assertSafeRepositoryPath(pathResolver.rootResolve(tierDir), {
    allowMissingLeaf: true,
  });

  if (!safeExistsSync(absTierDir)) {
    safeMkdir(absTierDir, { recursive: true });
  }

  let registry: CapabilityRegistry = loadCapabilityRegistryDirectory(absRegistryDir, type);

  const existingIndex = registry.capabilities.findIndex(
    (c: any) => c.capability_id === capabilityId
  );

  if (type === 'harness') {
    // Harness capabilities are stored as per-item envelopes
    const next =
      existingIndex >= 0 ? { ...registry.capabilities[existingIndex], ...payload } : payload;
    writeCapabilityRegistryItem(absRegistryDir, type, registry.version, next);
  } else if (type === 'gateway') {
    // Gateway capabilities store the profile as a separate artifact and point to it
    const adaptersDir = `${tierDir}/adapters`;
    const absAdaptersDir = assertSafeRepositoryPath(pathResolver.rootResolve(adaptersDir), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(absAdaptersDir)) {
      safeMkdir(absAdaptersDir, { recursive: true });
    }
    const absTargetAdapterPath = assertSafeRepositoryPath(
      path.join(absAdaptersDir, path.basename(adapterPath)),
      { allowMissingLeaf: true }
    );
    const validatedPayload = defineCatalog<Record<string, unknown>>({
      id: `registry-manager-${type}-adapter`,
      path: absTargetAdapterPath,
      schema: ADAPTER_SCHEMA_PATHS[type],
    }).validate(payload, absTargetAdapterPath);
    safeWriteFile(absTargetAdapterPath, JSON.stringify(validatedPayload, null, 2));

    const newEntry = {
      capability_id: capabilityId,
      adapter_profile_path: path.relative(pathResolver.rootDir(), absTargetAdapterPath),
      status: payload.status || 'experimental',
      description: payload.description || payload.notes || '',
      added_at: nowIso(),
    };

    if (existingIndex >= 0) {
      writeCapabilityRegistryItem(absRegistryDir, type, registry.version, {
        ...registry.capabilities[existingIndex],
        ...newEntry,
      });
    } else {
      writeCapabilityRegistryItem(absRegistryDir, type, registry.version, newEntry);
    }
  }

  print(
    `[REGISTRY_MANAGER] Successfully registered ${capabilityId} into ${argv.tier} tier (${argv.type} registry).`
  );
}

if (
  isDirectScript(import.meta.url, 'registry_manager.ts') ||
  isDirectScript(import.meta.url, 'registry_manager.js')
) {
  void defineScript({
    name: 'registry:manage',
    flags: [],
    run: ({ argv, print }) => main(argv, print),
  })();
}
