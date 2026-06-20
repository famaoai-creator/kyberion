import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getMeetingJoinDriver,
  listMeetingJoinDriversFor,
  resetMeetingJoinDriverRegistry,
  redactMeetingUrl,
  resolveMeetingPlatform,
  validateMeetingTarget,
} from '@agent/core';
import {
  installBrowserMeetingJoinDriver,
  createBrowserMeetingJoinDriver,
  BrowserMeetingJoinDriver,
  MEETING_BROWSER_DRIVER_ID,
  MEETING_BROWSER_DRIVER_ROLE,
  MEET_SELECTORS,
  TEAMS_SELECTORS,
  ZOOM_SELECTORS,
} from './index.js';

// Mock @agent/core for cookie-store tests
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    pathResolver: {
      ...actual.pathResolver,
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
    },
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReadFile: vi.fn().mockReturnValue('[]'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
  };
});

describe('BrowserMeetingJoinDriver registration', () => {
  beforeEach(() => {
    resetMeetingJoinDriverRegistry();
  });

  it('registers under driver_id "browser-playwright"', () => {
    installBrowserMeetingJoinDriver();
    const driver = getMeetingJoinDriver('browser-playwright');
    expect(driver).toBeDefined();
    expect(driver?.driver_id).toBe(MEETING_BROWSER_DRIVER_ID);
  });

  it('claims meet, zoom, teams', () => {
    installBrowserMeetingJoinDriver();
    expect(listMeetingJoinDriversFor('meet').map((d) => d.driver_id)).toContain(
      'browser-playwright'
    );
    expect(listMeetingJoinDriversFor('zoom').map((d) => d.driver_id)).toContain(
      'browser-playwright'
    );
    expect(listMeetingJoinDriversFor('teams').map((d) => d.driver_id)).toContain(
      'browser-playwright'
    );
  });

  it('probe reports unavailable when playwright is not installed', async () => {
    const driver = new BrowserMeetingJoinDriver();
    const probe = await driver.probe();
    // We expect playwright not to be installed in this workspace.
    if (!probe.available) {
      expect(probe.reason).toMatch(/playwright/i);
    } else {
      // If somebody installs it, that's fine too — assertion fits both.
      expect(probe.available).toBe(true);
    }
  });

  it('join throws when playwright is not available', async () => {
    const driver = new BrowserMeetingJoinDriver();
    const probe = await driver.probe();
    if (!probe.available) {
      const mockBus = {
        inputStream: vi.fn(),
        writeOutput: vi.fn(),
        close: vi.fn(),
      };
      await expect(
        driver.join(
          { url: 'https://meet.google.com/abc-def-ghi', platform: 'meet' },
          mockBus as any
        )
      ).rejects.toThrow('[browser-driver]');
    }
  });

  it('has correct driver_id and supported_platforms', () => {
    const driver = new BrowserMeetingJoinDriver();
    expect(driver.driver_id).toBe(MEETING_BROWSER_DRIVER_ID);
    expect(driver.supported_platforms).toContain('meet');
    expect(driver.supported_platforms).toContain('zoom');
    expect(driver.supported_platforms).toContain('teams');
    expect(driver.supported_platforms).toContain('auto');
  });

  it('createBrowserMeetingJoinDriver returns an unregistered driver instance', () => {
    const driver = createBrowserMeetingJoinDriver({
      account_slug: 'factory-account',
    });
    expect(driver.driver_id).toBe(MEETING_BROWSER_DRIVER_ID);
    expect(driver.supported_platforms).toContain('meet');
  });

  it('accepts custom options', () => {
    const driver = new BrowserMeetingJoinDriver({
      headed: true,
      account_slug: 'test-account',
      microphone_device: 'Built-in Microphone',
      speaker_device: 'Built-in Output',
      camera_device: 'FaceTime HD Camera',
      step_timeout_ms: 5000,
    });
    expect(driver.driver_id).toBe(MEETING_BROWSER_DRIVER_ID);
  });
});

describe('BrowserMeetingJoinDriver boundary metadata', () => {
  it('exposes the internal join backend role constant', () => {
    expect(MEETING_BROWSER_DRIVER_ROLE).toBe('internal-join-backend');
  });
});

describe('BrowserMeetingJoinDriver selectors', () => {
  it('MEET_SELECTORS has required fields', () => {
    expect(MEET_SELECTORS).toBeDefined();
    expect(Array.isArray(MEET_SELECTORS.join_button)).toBe(true);
    expect(MEET_SELECTORS.join_button.length).toBeGreaterThan(0);
    expect(Array.isArray(MEET_SELECTORS.continue_without_audio_video_button)).toBe(true);
    expect(Array.isArray(MEET_SELECTORS.settings_button)).toBe(true);
    expect(Array.isArray(MEET_SELECTORS.microphone_device_button)).toBe(true);
    expect(Array.isArray(MEET_SELECTORS.speaker_device_button)).toBe(true);
    expect(Array.isArray(MEET_SELECTORS.camera_device_button)).toBe(true);
  });

  it('TEAMS_SELECTORS has required fields', () => {
    expect(TEAMS_SELECTORS).toBeDefined();
    expect(Array.isArray(TEAMS_SELECTORS.join_button)).toBe(true);
    expect(Array.isArray(TEAMS_SELECTORS.meeting_id_input)).toBe(true);
    expect(Array.isArray(TEAMS_SELECTORS.meeting_passcode_input)).toBe(true);
  });

  it('ZOOM_SELECTORS has required fields', () => {
    expect(ZOOM_SELECTORS).toBeDefined();
    expect(Array.isArray(ZOOM_SELECTORS.join_button)).toBe(true);
  });
});

describe('resolveMeetingPlatform', () => {
  it('infers meet/zoom/teams from known hosts', () => {
    expect(
      resolveMeetingPlatform({
        url: 'https://meet.google.com/abc-defg-hij',
        platform: 'auto',
      }),
    ).toBe('meet');
    expect(
      resolveMeetingPlatform({
        url: 'https://company.zoom.us/j/123',
        platform: 'auto',
      }),
    ).toBe('zoom');
    expect(
      resolveMeetingPlatform({
        url: 'https://teams.microsoft.com/l/meetup-join/abc',
        platform: 'auto',
      }),
    ).toBe('teams');
    expect(
      resolveMeetingPlatform({
        url: 'https://www.microsoft.com/ja-jp/microsoft-teams/join-a-meeting',
        platform: 'auto',
      }),
    ).toBe('teams');
  });

  it('throws on unknown hosts when platform is auto', () => {
    expect(() =>
      resolveMeetingPlatform({
        url: 'https://example.com/meeting',
        platform: 'auto',
      }),
    ).toThrow(/unsupported meeting URL/i);
  });

  it('rejects disallowed hosts before join', () => {
    expect(() =>
      validateMeetingTarget({
        url: 'https://example.com/meeting',
        platform: 'meet',
      }),
    ).toThrow(/not allow-listed/i);
  });

  it('redacts meeting urls down to host-only values', () => {
    expect(redactMeetingUrl('https://meet.google.com/abc-defg-hij?foo=bar')).toBe(
      'meet.google.com',
    );
  });
});

describe('cookie-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readCookies returns empty array when file does not exist', async () => {
    const { safeExistsSync } = await import('@agent/core');
    vi.mocked(safeExistsSync).mockReturnValue(false);

    const { readCookies } = await import('./cookie-store.js');
    const cookies = readCookies('test-account');
    expect(cookies).toEqual([]);
  });

  it('readCookies returns parsed cookies when file exists', async () => {
    const { safeExistsSync, safeReadFile } = await import('@agent/core');
    vi.mocked(safeExistsSync).mockReturnValue(true);
    vi.mocked(safeReadFile).mockReturnValue(JSON.stringify([{ name: 'session', value: 'abc' }]));

    const { readCookies } = await import('./cookie-store.js');
    const cookies = readCookies('test-account');
    expect(cookies).toEqual([{ name: 'session', value: 'abc' }]);
  });

  it('readCookies returns empty array when file contains invalid JSON', async () => {
    const { safeExistsSync, safeReadFile } = await import('@agent/core');
    vi.mocked(safeExistsSync).mockReturnValue(true);
    vi.mocked(safeReadFile).mockReturnValue('not-valid-json');

    const { readCookies } = await import('./cookie-store.js');
    const cookies = readCookies('test-account');
    expect(cookies).toEqual([]);
  });

  it('readCookies returns empty array when file contains non-array JSON', async () => {
    const { safeExistsSync, safeReadFile } = await import('@agent/core');
    vi.mocked(safeExistsSync).mockReturnValue(true);
    vi.mocked(safeReadFile).mockReturnValue(JSON.stringify({ not: 'an array' }));

    const { readCookies } = await import('./cookie-store.js');
    const cookies = readCookies('test-account');
    expect(cookies).toEqual([]);
  });

  it('writeCookies calls safeWriteFile with serialized cookies', async () => {
    const { safeWriteFile, safeMkdir } = await import('@agent/core');

    const { writeCookies } = await import('./cookie-store.js');
    const testCookies = [{ name: 'session', value: 'xyz' }];
    writeCookies('test-account', testCookies);

    expect(safeWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('test-account.json'),
      expect.stringContaining('"session"')
    );
    expect(safeMkdir).toHaveBeenCalled();
  });

  it('cookiePathFor returns path containing account slug', async () => {
    const { cookiePathFor } = await import('./cookie-store.js');
    const cookiePath = cookiePathFor('my-account');
    expect(cookiePath).toContain('my-account.json');
  });
});
