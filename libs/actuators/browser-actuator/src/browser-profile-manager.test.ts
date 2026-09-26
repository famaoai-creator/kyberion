import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  getDefaultChromeUserDataDir,
  listChromeProfiles,
  listPlaywrightProfiles,
  listBrowserProfiles,
  resolveBrowserProfile,
  type BrowserProfile,
} from './browser-profile-manager.js';
import * as secureIo from '@agent/core/secure-io';
import * as foundation from '@agent/core/foundation';

describe('browser-profile-manager', () => {
  describe('getDefaultChromeUserDataDir', () => {
    it('returns darwin path on macOS', () => {
      const dir = getDefaultChromeUserDataDir('darwin', { ignoreVaultMount: true });
      expect(dir).toContain('Library/Application Support/Google/Chrome');
    });

    it('returns linux path on linux', () => {
      const dir = getDefaultChromeUserDataDir('linux', { ignoreVaultMount: true });
      expect(dir).toContain('.config/google-chrome');
    });

    it('returns windows path on win32', () => {
      const dir = getDefaultChromeUserDataDir('win32', { ignoreVaultMount: true });
      expect(dir).toContain('Google');
      expect(dir).toContain('Chrome');
    });
  });

  describe('listChromeProfiles', () => {
    it('returns empty array when Local State does not exist', () => {
      vi.spyOn(secureIo, 'safeExistsSync').mockReturnValue(false);
      const profiles = listChromeProfiles('/fake/chrome/dir');
      expect(profiles).toEqual([]);
      vi.restoreAllMocks();
    });

    it('parses profiles correctly from mock Local State', () => {
      const mockLocalState = {
        profile: {
          info_cache: {
            Default: {
              name: 'Motonobu',
              user_name: 'motonobu@gmail.com',
              active_time: 1790452628,
            },
            'Profile 1': {
              name: 'Ichimura',
              user_name: 'famaoai@gmail.com',
              active_time: 1790451406,
            },
          },
        },
      };

      vi.spyOn(secureIo, 'safeExistsSync').mockImplementation((p: string) => {
        if (p.endsWith('Local State')) return true;
        if (p.endsWith('SingletonLock')) return true;
        if (p.includes('Default/Sessions') || p.includes('Profile 1/Sessions')) return true;
        return false;
      });
      vi.spyOn(foundation, 'readJsonIfPresent').mockReturnValue(mockLocalState);
      vi.spyOn(secureIo, 'safeReaddir').mockImplementation((p: string) => {
        if (p.includes('Default/Sessions')) return ['Session_12345'];
        if (p.includes('Profile 1/Sessions')) return ['Session_67890'];
        return [];
      });
      vi.spyOn(secureIo, 'safeStat').mockReturnValue({
        mtimeMs: Date.now() - 5000,
      } as any);

      const profiles = listChromeProfiles('/fake/chrome/dir');
      expect(profiles).toHaveLength(2);

      const defaultProf = profiles.find((p) => p.id === 'Default');
      expect(defaultProf).toBeDefined();
      expect(defaultProf?.name).toBe('Motonobu');
      expect(defaultProf?.email).toBe('motonobu@gmail.com');
      expect(defaultProf?.status).toBe('active');
      expect(defaultProf?.isDefault).toBe(true);

      const prof1 = profiles.find((p) => p.id === 'Profile 1');
      expect(prof1).toBeDefined();
      expect(prof1?.name).toBe('Ichimura');
      expect(prof1?.email).toBe('famaoai@gmail.com');
      expect(prof1?.status).toBe('active');

      vi.restoreAllMocks();
    });
  });

  describe('listPlaywrightProfiles', () => {
    it('returns empty array when base directory does not exist', () => {
      vi.spyOn(secureIo, 'safeExistsSync').mockReturnValue(false);
      const profiles = listPlaywrightProfiles('/fake/playwright/dir');
      expect(profiles).toEqual([]);
      vi.restoreAllMocks();
    });

    it('parses managed Playwright profiles', () => {
      vi.spyOn(secureIo, 'safeExistsSync').mockImplementation((p: string) => {
        if (p === '/fake/playwright/dir') return true;
        if (p.endsWith('session-1/profile.json')) return true;
        if (p.endsWith('session-1/session.json')) return true;
        return false;
      });
      vi.spyOn(secureIo, 'safeReaddir').mockReturnValue(['session-1']);
      vi.spyOn(foundation, 'readJsonIfPresent').mockImplementation((p: string) => {
        if (p.endsWith('profile.json')) {
          return { name: 'Agent Worker 1', email: 'worker1@agent.local' };
        }
        if (p.endsWith('session.json')) {
          return { leaseExpiresAt: Date.now() + 100000 };
        }
        return null;
      });

      const profiles = listPlaywrightProfiles('/fake/playwright/dir');
      expect(profiles).toHaveLength(1);
      expect(profiles[0].id).toBe('session-1');
      expect(profiles[0].name).toBe('Agent Worker 1');
      expect(profiles[0].email).toBe('worker1@agent.local');
      expect(profiles[0].provider).toBe('playwright');
      expect(profiles[0].status).toBe('active');

      vi.restoreAllMocks();
    });
  });

  describe('resolveBrowserProfile', () => {
    const mockProfiles: BrowserProfile[] = [
      {
        id: 'Default',
        provider: 'chrome',
        name: 'Motonobu',
        email: 'motonobu@gmail.com',
        userDataDir: '/path/to/chrome',
        profileDirectory: 'Default',
        status: 'active',
        isDefault: true,
      },
      {
        id: 'Profile 1',
        provider: 'chrome',
        name: 'Ichimura',
        email: 'famaoai@gmail.com',
        userDataDir: '/path/to/chrome',
        profileDirectory: 'Profile 1',
        status: 'active',
      },
      {
        id: 'agent-dev',
        provider: 'playwright',
        name: 'Agent Dev Sandbox',
        userDataDir: '/path/to/playwright/agent-dev',
        status: 'idle',
      },
    ];

    it('resolves by exact ID', () => {
      const match = resolveBrowserProfile({ id: 'Profile 1' }, mockProfiles);
      expect(match?.name).toBe('Ichimura');
    });

    it('resolves by case-insensitive name', () => {
      const match = resolveBrowserProfile('ichimura', mockProfiles);
      expect(match?.id).toBe('Profile 1');
    });

    it('resolves by email address', () => {
      const match = resolveBrowserProfile('famaoai@gmail.com', mockProfiles);
      expect(match?.id).toBe('Profile 1');
    });

    it('resolves Playwright profile by name substring', () => {
      const match = resolveBrowserProfile('sandbox', mockProfiles);
      expect(match?.id).toBe('agent-dev');
      expect(match?.provider).toBe('playwright');
    });

    it('returns undefined when no profile matches', () => {
      const match = resolveBrowserProfile('non-existent', mockProfiles);
      expect(match).toBeUndefined();
    });
  });
});
