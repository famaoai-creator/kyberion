import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveMissionStatePathForBanner } from './cli.js';

describe('cli mission path scope', () => {
  it('uses the canonical mission state loader for the context banner', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('loadStateAtPath(statePath)');
    expect(source).not.toContain('readJson<{ status?: string }>(statePath)');
  });

  it('uses the resolved mission path instead of the legacy public root', () => {
    const missionId = 'MSN-CLI-CONFIDENTIAL-SCOPE';
    const confidential = pathResolver.missionDir(missionId, 'confidential');
    const statePath = path.join(confidential, 'mission-state.json');
    withExecutionContext('mission_controller', () => {
      safeRmSync(confidential, { recursive: true, force: true });
      safeMkdir(confidential, { recursive: true });
      safeWriteFile(statePath, '{"status":"active"}\n');
    });
    try {
      expect(resolveMissionStatePathForBanner(missionId)).toBe(statePath);
      expect(resolveMissionStatePathForBanner(missionId)).not.toBe(
        path.join(pathResolver.missionDir(missionId, 'public'), 'mission-state.json')
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(confidential, { recursive: true, force: true });
      });
    }
  });
});
