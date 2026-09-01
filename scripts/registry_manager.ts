import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeWriteFile,
  safeExistsSync,
  safeLstat,
  safeMkdir,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { readJson } from '@agent/core/foundation';
import yargs from 'yargs';
import { defineScript, isDirectScript } from './lib/harness.js';

export async function main(args: string[] = []) {
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

  const payload = readJson<Record<string, unknown>>(adapterPath);
  const capabilityId = payload.capability_id || payload.id;
  if (!capabilityId) {
    throw new Error('Payload missing capability_id');
  }

  // Determine target directory based on tier
  const tierDir =
    argv.tier === 'public' ? 'knowledge/product/governance' : `knowledge/${argv.tier}/governance`;
  const registryPath = `${tierDir}/${argv.type}-capability-registry.json`;
  const absRegistryPath = assertSafeRepositoryPath(pathResolver.rootResolve(registryPath), {
    allowMissingLeaf: true,
  });
  const absTierDir = assertSafeRepositoryPath(pathResolver.rootResolve(tierDir), {
    allowMissingLeaf: true,
  });

  if (!safeExistsSync(absTierDir)) {
    safeMkdir(absTierDir, { recursive: true });
  }

  let registry: any = { version: '1.0.0', capabilities: [] };
  if (safeExistsSync(absRegistryPath)) {
    if (!safeLstat(absRegistryPath).isFile()) {
      throw new Error(`Capability registry must be a regular file: ${absRegistryPath}`);
    }
    registry = readJson<Record<string, unknown>>(absRegistryPath);
  }

  const existingIndex = registry.capabilities.findIndex(
    (c: any) => c.capability_id === capabilityId
  );

  if (argv.type === 'harness') {
    // Harness capabilities are stored inline
    if (existingIndex >= 0) {
      registry.capabilities[existingIndex] = payload;
    } else {
      registry.capabilities.push(payload);
    }
  } else if (argv.type === 'gateway') {
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
    safeWriteFile(absTargetAdapterPath, JSON.stringify(payload, null, 2));

    const newEntry = {
      capability_id: capabilityId,
      adapter_profile_path: path.relative(pathResolver.rootDir(), absTargetAdapterPath),
      status: payload.status || 'experimental',
      description: payload.description || payload.notes || '',
      added_at: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      registry.capabilities[existingIndex] = {
        ...registry.capabilities[existingIndex],
        ...newEntry,
      };
    } else {
      registry.capabilities.push(newEntry);
    }
  }

  safeWriteFile(absRegistryPath, JSON.stringify(registry, null, 2));
  console.log(
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
    run: ({ argv }) => main(argv),
  })();
}
