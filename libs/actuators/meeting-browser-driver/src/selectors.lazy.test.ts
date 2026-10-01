import { describe, expect, it, vi } from 'vitest';

const registryCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@agent/core/meeting/meeting-platform-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/meeting/meeting-platform-registry')>();
  return {
    ...actual,
    findMeetingPlatform: (id: string) => {
      registryCalls.count += 1;
      return actual.findMeetingPlatform(id);
    },
  };
});

describe('meeting selectors module (S2)', () => {
  it('does not load the meeting platform registry at import; deprecated constants resolve lazily', async () => {
    const selectors = await import('./selectors.js');
    expect(registryCalls.count).toBe(0);

    expect(selectors.ZOOM_SELECTORS.join_button.length).toBeGreaterThan(0);
    expect(registryCalls.count).toBeGreaterThan(0);
    expect({ ...selectors.TEAMS_IN_MEETING_SELECTORS }).toEqual(
      selectors.inMeetingSelectorsForPlatform('teams')
    );
    expect(Object.keys(selectors.MEET_SELECTORS)).toEqual(
      Object.keys(selectors.selectorsForPlatform('meet'))
    );
  });
});
