import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSurfaceState, readSurfaceLogTail, resolveSurfaceCwd, saveSurfaceState, surfaceStatePath } from '@agent/core/surface-runtime';
import { pathResolver } from '@agent/core';

const testStatePath = path.join(process.cwd(), 'active/shared/tmp/runtime-surface-state.test.json');

describe('Runtime surface state helpers', () => {
  afterEach(() => {
    if (fs.existsSync(testStatePath)) fs.rmSync(testStatePath, { force: true });
  });

  it('loads an empty state when no state file exists', () => {
    expect(loadSurfaceState(testStatePath)).toEqual({ version: 1, surfaces: {} });
  });

  it('saves and reloads surface state', () => {
    const state = {
      version: 1 as const,
      surfaces: {
        'slack-bridge': {
          id: 'slack-bridge',
          pid: 1234,
          resourceId: 'surface:slack-bridge',
          kind: 'gateway' as const,
          command: 'node',
          args: ['dist/satellites/slack-bridge/src/index.js'],
          cwd: process.cwd(),
          logPath: pathResolver.shared('logs/surfaces/slack-bridge.log'),
          startedAt: new Date().toISOString(),
          shutdownPolicy: 'detached' as const,
        },
      },
    };

    saveSurfaceState(state, testStatePath);
    expect(loadSurfaceState(testStatePath)).toEqual(state);
  });

  it('reads the tail of an existing log file', () => {
    const logPath = path.join(process.cwd(), 'active/shared/tmp/surface-runtime-test.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'a\nb\nc\n');

    expect(readSurfaceLogTail(logPath, 2)).toEqual(['b', 'c']);
  });

  it('returns an empty tail when the log does not exist', () => {
    expect(readSurfaceLogTail(pathResolver.shared('logs/surfaces/missing.log'))).toEqual([]);
  });

  it('resolves explicit and implicit working directories', () => {
    expect(
      resolveSurfaceCwd({
        id: 'chronos',
        kind: 'ui',
        description: 'Chronos',
        command: 'node',
      }),
    ).toBe(pathResolver.rootDir());

    expect(
      resolveSurfaceCwd({
        id: 'chronos',
        kind: 'ui',
        description: 'Chronos',
        command: 'node',
        cwd: 'presence/displays/chronos-mirror-v2',
      }),
    ).toBe(pathResolver.resolve('presence/displays/chronos-mirror-v2'));
  });
});
