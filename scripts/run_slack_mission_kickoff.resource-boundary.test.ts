import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  loadSlackMissionKickoffInputAtPath,
  resolveSlackMissionKickoffInputPath,
} from './run_slack_mission_kickoff.js';

const root = pathResolver.sharedTmp(`slack-mission-kickoff-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('slack mission kickoff resource boundary', () => {
  it('rejects repository-external job input', () => {
    expect(() => resolveSlackMissionKickoffInputPath('/tmp/slack-job.json')).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });

  it('loads only schema-valid kickoff jobs', () => {
    const inputPath = path.join(root, 'job.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(
      inputPath,
      JSON.stringify({
        missionId: 'MSN-SLACK-KICKOFF',
        channel: 'slack',
        threadTs: '123.456',
        sourceText: 'start mission',
        proposal: { teamRoles: ['planner'] },
      })
    );
    expect(loadSlackMissionKickoffInputAtPath(inputPath)).toMatchObject({
      missionId: 'MSN-SLACK-KICKOFF',
      channel: 'slack',
    });

    safeWriteFile(inputPath, JSON.stringify({ missionId: 'MSN-SLACK-KICKOFF' }));
    expect(() => loadSlackMissionKickoffInputAtPath(inputPath)).toThrow(
      /Invalid catalog slack-mission-kickoff-input/u
    );
  });
});
