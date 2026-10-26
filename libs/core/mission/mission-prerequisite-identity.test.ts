import { describe, expect, it } from 'vitest';
import {
  probeMissionPrerequisiteIdentity,
  withMissionPrerequisiteIdentityProbe,
} from './mission-prerequisite-identity.js';

describe('mission prerequisite metadata port', () => {
  it('isolates concurrent owner requests and releases the probe after completion', async () => {
    expect(probeMissionPrerequisiteIdentity()).toBeUndefined();
    const results = await Promise.all([
      withMissionPrerequisiteIdentityProbe(
        () => ({ ready: true, missing_files: [] }),
        async () => {
          await Promise.resolve();
          return probeMissionPrerequisiteIdentity();
        }
      ),
      withMissionPrerequisiteIdentityProbe(
        () => ({ ready: false, missing_files: ['my-vision.md'] }),
        async () => {
          await Promise.resolve();
          return probeMissionPrerequisiteIdentity();
        }
      ),
    ]);
    expect(results).toEqual([
      { ready: true, missing_files: [] },
      { ready: false, missing_files: ['my-vision.md'] },
    ]);
    expect(probeMissionPrerequisiteIdentity()).toBeUndefined();
  });
  it('rejects unknown filenames and contradictory readiness', () => {
    for (const metadata of [
      { ready: true, missing_files: ['my-vision.md'] },
      { ready: false, missing_files: ['other.json'] },
    ]) {
      expect(() =>
        withMissionPrerequisiteIdentityProbe(() => metadata, probeMissionPrerequisiteIdentity)
      ).toThrow('Invalid mission prerequisite');
    }
  });
});
