import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_DEFAULT_MEETING_JOIN_DRIVER,
  resolveDefaultMeetingJoinDriverId,
} from './meeting-join-driver.js';

afterEach(() => vi.unstubAllEnvs());

describe('meeting-join-driver saved seam default', () => {
  it('uses the policy default (chrome-extension) with no saved default', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
    expect(resolveDefaultMeetingJoinDriverId()).toBe('chrome-extension');
    expect(BUILTIN_DEFAULT_MEETING_JOIN_DRIVER).toBe('chrome-extension');
  });

  it('uses the saved default when the caller names no driver', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'meeting-join-driver=browser-playwright');
    expect(resolveDefaultMeetingJoinDriverId()).toBe('browser-playwright');
  });
});
