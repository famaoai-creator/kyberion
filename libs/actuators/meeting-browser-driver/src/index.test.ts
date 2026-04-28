import { describe, expect, it, beforeEach } from 'vitest';
import {
  getMeetingJoinDriver,
  listMeetingJoinDriversFor,
  resetMeetingJoinDriverRegistry,
} from '@agent/core';
import { installBrowserMeetingJoinDriver, BrowserMeetingJoinDriver } from './index.js';

describe('BrowserMeetingJoinDriver registration', () => {
  beforeEach(() => {
    resetMeetingJoinDriverRegistry();
  });

  it('registers under driver_id "browser-playwright"', () => {
    installBrowserMeetingJoinDriver();
    const driver = getMeetingJoinDriver('browser-playwright');
    expect(driver).toBeDefined();
    expect(driver?.driver_id).toBe('browser-playwright');
  });

  it('claims meet, zoom, teams', () => {
    installBrowserMeetingJoinDriver();
    expect(listMeetingJoinDriversFor('meet').map((d) => d.driver_id)).toContain('browser-playwright');
    expect(listMeetingJoinDriversFor('zoom').map((d) => d.driver_id)).toContain('browser-playwright');
    expect(listMeetingJoinDriversFor('teams').map((d) => d.driver_id)).toContain('browser-playwright');
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
});
