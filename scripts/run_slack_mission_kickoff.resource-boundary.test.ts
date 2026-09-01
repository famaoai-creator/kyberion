import { describe, expect, it } from 'vitest';
import { resolveSlackMissionKickoffInputPath } from './run_slack_mission_kickoff.js';

describe('slack mission kickoff resource boundary', () => {
  it('rejects repository-external job input', () => {
    expect(() => resolveSlackMissionKickoffInputPath('/tmp/slack-job.json')).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });
});
