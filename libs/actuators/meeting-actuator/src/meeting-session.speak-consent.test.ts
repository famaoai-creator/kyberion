import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@agent/core/meeting/meeting-participation-coordinator', () => ({
  checkMeetingParticipationConsent: mocks.check,
}));

import { checkSpeakConsent } from './meeting-session.js';

describe('checkSpeakConsent delegates to the coordinator voice check (PG-04)', () => {
  let savedMission: string | undefined;

  beforeEach(() => {
    savedMission = process.env.MISSION_ID;
    process.env.MISSION_ID = 'MSN-SPEAK-DELEGATE';
    mocks.check.mockReset();
  });

  afterEach(() => {
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
  });

  it('asks for purpose voice with the MISSION_ID mission and no meeting', () => {
    mocks.check.mockReturnValue({ allowed: true, grant_id: 'GRT-20261019-aaaaaaaaaaaa' });
    expect(checkSpeakConsent()).toEqual({ allowed: true });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    const input = mocks.check.mock.calls[0][0];
    expect(input).toMatchObject({ mission_id: 'MSN-SPEAK-DELEGATE', purpose: 'voice' });
    expect(input.meeting).toBeUndefined();
  });

  it('keeps the { allowed, reason } contract on denial', () => {
    mocks.check.mockReturnValue({ allowed: false, reason: 'voice-consent.json missing at x' });
    expect(checkSpeakConsent()).toEqual({
      allowed: false,
      reason: 'voice-consent.json missing at x',
    });
  });

  it('keeps the speak wording for a missing mission id or mission', () => {
    mocks.check.mockReturnValue({ allowed: false, reason: 'x', code: 'no_mission' });
    expect(checkSpeakConsent().reason).toBe(
      'speak requires MISSION_ID + voice-consent.json in the mission evidence dir'
    );
    mocks.check.mockReturnValue({ allowed: false, reason: 'x', code: 'no_mission_dir' });
    expect(checkSpeakConsent().reason).toBe("mission 'MSN-SPEAK-DELEGATE' not found");
  });
});
