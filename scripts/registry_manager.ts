import * as path from 'node:path';
import { safeReadFile, safeWriteFile, safeExistsSync, safeMkdir, pathResolver } from '@agent/core';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('adapter', { type: 'string', demandOption: true, describe: 'Path to the generated JSON profile/capability' })
    .option('tier', { type: 'string', choices: ['public', 'confidential', 'personal'], default: 'public', describe: 'Knowledge tier to register into' })
    .option('type', { type: 'string', choices: ['harness', 'gateway'], demandOption: true, describe: 'Registry type' })
    .parse();

  const adapterPath = path.resolve(process.cwd(), argv.adapter);
  if (!safeExistsSync(adapterPath)) {
    throw new Error(`Input file not found: ${adapterPath}`);
  }

  const payload = JSON.parse(safeReadFile(adapterPath, { encoding: 'utf8' }) as string);
  const capabilityId = payload.capability_id || payload.id;
  if (!capabilityId) {
    throw new Error('Payload missing capability_id');
  }

  // Determine target directory based on tier
  const tierDir = argv.tier === 'public' ? 'knowledge/public/governance' : `knowledge/${argv.tier}/governance`;
  const registryPath = `${tierDir}/${argv.type}-capability-registry.json`;
  const absRegistryPath = pathResolver.rootResolve(registryPath);
  const absTierDir = pathResolver.rootResolve(tierDir);

  if (!safeExistsSync(absTierDir)) {
    safeMkdir(absTierDir, { recursive: true });
  }

  let registry: any = { version: '1.0.0', capabilities: [] };
  if (safeExistsSync(absRegistryPath)) {
    registry = JSON.parse(safeReadFile(absRegistryPath, { encoding: 'utf8' }) as string);
  }

  const existingIndex = registry.capabilities.findIndex((c: any) => c.capability_id === capabilityId);

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
    const absAdaptersDir = pathResolver.rootResolve(adaptersDir);
    if (!safeExistsSync(absAdaptersDir)) {
      safeMkdir(absAdaptersDir, { recursive: true });
    }
    const absTargetAdapterPath = path.join(absAdaptersDir, path.basename(adapterPath));
    safeWriteFile(absTargetAdapterPath, JSON.stringify(payload, null, 2));

    const newEntry = {
      capability_id: capabilityId,
      adapter_profile_path: path.relative(pathResolver.rootDir(), absTargetAdapterPath),
      status: payload.status || 'experimental',
      description: payload.description || payload.notes || '',
      added_at: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      registry.capabilities[existingIndex] = { ...registry.capabilities[existingIndex], ...newEntry };
    } else {
      registry.capabilities.push(newEntry);
    }
  }

  safeWriteFile(absRegistryPath, JSON.stringify(registry, null, 2));
  console.log(`[REGISTRY_MANAGER] Successfully registered ${capabilityId} into ${argv.tier} tier (${argv.type} registry).`);
}

main().catch(err => {
  console.error(`[REGISTRY_MANAGER_ERROR] ${err.message}`);
  process.exit(1);
});
