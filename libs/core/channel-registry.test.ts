import { afterEach, describe, expect, it } from 'vitest';
import { loadChannelRegistry } from './channel-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const rootDir = pathResolver.sharedTmp('channel-registry-loader-test');

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('channel registry loader', () => {
  it('loads the presence registry through its dedicated schema', () => {
    const registry = loadChannelRegistry();

    expect(registry.channels.length).toBeGreaterThan(0);
    expect(registry.channels[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), priority: expect.any(Number) })
    );
  });

  it('rejects malformed channel registry payloads', () => {
    const registryPath = `${rootDir}/presence/bridge/channel-registry.json`;
    safeMkdir(`${rootDir}/presence/bridge`, { recursive: true });
    safeWriteFile(registryPath, JSON.stringify({ channels: [] }));

    expect(() => loadChannelRegistry(rootDir)).toThrow('Invalid catalog presence-channel-registry');
  });
});
