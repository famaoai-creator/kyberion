import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import {
  loadRegistryDirectory,
  resetRegistryDirectoryCacheForTests,
  type RegistryDirectoryOptions,
} from './registry-directory.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const TEST_ROOT = pathResolver.sharedTmp('registry-directory-tests');
const REGISTRY_DIR = path.join(TEST_ROOT, 'providers');
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/reasoning-provider-registry.schema.json'
);
const OPTIONS: RegistryDirectoryOptions = {
  id: 'registry-directory-test',
  dirPath: REGISTRY_DIR,
  schemaPath: SCHEMA_PATH,
  arrayKey: 'providers',
  idKey: 'mode',
};

function envelope(provider: string): string {
  return JSON.stringify({
    version: '1.0.0',
    providers: [
      {
        mode: 'stub',
        provider,
        module: './reasoning-backend',
        capabilities: {
          reasoning: true,
          structured_output: true,
          abort: false,
          session_continuity: false,
          input_modalities: ['text'],
        },
        env_keys: [],
      },
    ],
  });
}

afterEach(() => {
  resetRegistryDirectoryCacheForTests();
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('registry-directory', () => {
  it('reuses unchanged entries and invalidates them when an item file changes', () => {
    safeMkdir(REGISTRY_DIR, { recursive: true });
    const itemPath = path.join(REGISTRY_DIR, 'stub.json');
    safeWriteFile(itemPath, envelope('initial-provider'));

    const first = loadRegistryDirectory<Record<string, unknown>>(OPTIONS);
    const second = loadRegistryDirectory<Record<string, unknown>>(OPTIONS);
    expect(second.items).toEqual(first.items);
    first.items[0].provider = 'caller-mutated-provider';
    expect(loadRegistryDirectory<Record<string, unknown>>(OPTIONS).items[0]).toMatchObject({
      provider: 'initial-provider',
    });

    safeWriteFile(itemPath, envelope('updated-provider'));

    const updated = loadRegistryDirectory<Record<string, unknown>>(OPTIONS);
    expect(updated.items[0]).toMatchObject({ provider: 'updated-provider' });
  });
});
