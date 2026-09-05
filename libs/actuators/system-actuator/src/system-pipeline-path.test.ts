import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';

import { opCapture } from './system-pipeline-core-helpers.js';

const rootDir = pathResolver.sharedTmp('system-pipeline-path-test');
const missionId = `MSN-SYSTEM-LIST-${process.pid}-${Date.now()}`;
const missionDir = pathResolver.rootResolve(`active/missions/public/${missionId}`);

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
  withExecutionContext('mission_controller', () => {
    safeRmSync(missionDir, { recursive: true, force: true });
  });
});

describe('system pipeline path boundaries', () => {
  it('does not return symlinked files from scan_directory', async () => {
    const target = `${rootDir}/target.txt`;
    const link = `${rootDir}/link.txt`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(target, 'target');
    safeSymlinkSync(target, link);

    const result = await opCapture(
      'scan_directory',
      { path: 'active/shared/tmp/system-pipeline-path-test', recursive: true },
      {},
      (value) => value
    );

    expect(result.scan_result.files).toEqual([
      expect.objectContaining({ path: 'active/shared/tmp/system-pipeline-path-test/target.txt' }),
    ]);
  });

  it('does not project schema-invalid mission state from list_missions', async () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        `${missionDir}/mission-state.json`,
        JSON.stringify({ mission_id: missionId, status: 'active', tier: 'public' })
      );
    });

    const result = await opCapture('list_missions', { status: 'active' }, {}, (value) => value);

    expect(
      result.mission_list_data.mission_list.some(
        (mission: { id?: string }) => mission.id === missionId
      )
    ).toBe(false);
  });
});
