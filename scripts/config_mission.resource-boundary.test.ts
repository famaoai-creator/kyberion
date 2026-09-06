import { describe, expect, it } from 'vitest';
import { resolveConfigMissionBriefPath } from './config_mission.js';

describe('config mission resource boundary', () => {
  it('rejects traversal-shaped tenant and instance identifiers', () => {
    expect(() => resolveConfigMissionBriefPath('../outside', 'cfg-1')).toThrow(
      /invalid tenant slug/u
    );
    expect(() => resolveConfigMissionBriefPath('tenant-a', '../outside')).toThrow(
      /invalid instance id/u
    );
  });
});
