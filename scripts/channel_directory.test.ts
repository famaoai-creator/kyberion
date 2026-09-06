import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { ChannelDirectoryEntry } from '@agent/core/channel-directory';
import {
  renderChannelDirectory,
  resolveChannelDirectoryEntries,
  runChannelDirectory,
} from './channel_directory.js';

const entry: ChannelDirectoryEntry = {
  channel: 'chronos',
  displayName: 'Chronos',
  agentId: 'chronos-agent',
  interactionMode: 'session',
  directReply: 'none',
  status: 'ready',
  manifestPath: 'knowledge/product/governance/surface-provider-manifests.json',
  coordinationRoot: 'active/shared/coordination/channels/chronos',
  requestDir: 'active/shared/coordination/channels/chronos/requests',
  notificationDir: 'active/shared/coordination/channels/chronos/notifications',
};

describe('channel directory entrypoint', () => {
  it('keeps output behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/channel_directory.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
  });

  it('rejects non-string channel filters and renders a deterministic text report', () => {
    expect(() => resolveChannelDirectoryEntries(['chronos'])).toThrow('channel must be a string');
    expect(renderChannelDirectory([])).toBe('No channel directory entries found.');
    expect(renderChannelDirectory([entry])).toContain('Chronos (chronos)');
    expect(renderChannelDirectory([entry])).toContain('coordination root:');
  });

  it('accepts the shared JSON flag after the package-script separator', async () => {
    const originalLog = console.log;
    const output: unknown[] = [];
    console.log = (value: unknown) => output.push(value);
    try {
      await runChannelDirectory(['--', '--json', '--quiet']);
    } finally {
      console.log = originalLog;
    }
    expect(output).toEqual([]);
  });
});
