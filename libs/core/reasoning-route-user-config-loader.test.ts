import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadReasoningRouteUserConfigAtPath,
  type ReasoningRouteUserConfig,
} from './reasoning-route-resolver.js';

const fixtureRoot = pathResolver.sharedTmp(`reasoning-route-user-config-${process.pid}`);

describe('reasoning route user config snapshot loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads a schema-valid snapshot through the path-bound catalog', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const filePath = path.join(fixtureRoot, 'snapshot.json');
    const snapshot: ReasoningRouteUserConfig = {
      version: '1.0.0',
      revision: 2,
      updated_at: '2026-09-03T00:00:00.000Z',
      last_change: 'test',
      profiles: { test: { mode: 'stub' } },
    };
    safeWriteFile(filePath, JSON.stringify(snapshot));

    expect(loadReasoningRouteUserConfigAtPath(filePath)).toEqual(snapshot);
  });

  it('rejects schema-invalid, directory, and symlink snapshots', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const invalidPath = path.join(fixtureRoot, 'invalid.json');
    const directoryPath = path.join(fixtureRoot, 'directory.json');
    const targetPath = path.join(fixtureRoot, 'target.json');
    const linkedPath = path.join(fixtureRoot, 'linked.json');
    safeWriteFile(invalidPath, JSON.stringify({ profiles: { test: { mode: '' } } }));
    safeMkdir(directoryPath);
    safeWriteFile(targetPath, JSON.stringify({ profiles: { test: { mode: 'stub' } } }));
    safeSymlinkSync(targetPath, linkedPath);

    expect(() => loadReasoningRouteUserConfigAtPath(invalidPath)).toThrow(
      /Invalid catalog reasoning-route-user-config/
    );
    expect(() => loadReasoningRouteUserConfigAtPath(directoryPath)).toThrow();
    expect(() => loadReasoningRouteUserConfigAtPath(linkedPath)).toThrow();
  });
});
