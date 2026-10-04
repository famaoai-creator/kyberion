import { safeExecResultAsync } from '@agent/core/secure-io';
import { listChromeProfiles, type BrowserProfile } from '../browser-profile-manager.js';
import type { BrowserProfileProviderModule } from '../browser-profile-provider-registry.js';

export const browserProfileProvider: BrowserProfileProviderModule = {
  listProfiles(options = {}) {
    return listChromeProfiles(options.customChromeDir);
  },
  async openProfile(profile: BrowserProfile, url: string, print: (message: string) => void) {
    const profileArg = '--profile-directory=' + (profile.profileDirectory || profile.id);
    const userDataArg = '--user-data-dir=' + profile.userDataDir;
    let command: string;
    let args: string[];
    if (process.platform === 'darwin') {
      command = 'open';
      args = ['-b', 'com.google.Chrome', '--args', userDataArg, profileArg, url];
    } else if (process.platform === 'win32') {
      command = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      args = [userDataArg, profileArg, url];
    } else {
      command = 'google-chrome';
      args = [userDataArg, profileArg, url];
    }
    print(
      '[browser-cli] Opening ' + url + ' in Chrome (' + profile.name + ' [' + profile.id + '])...'
    );
    const result = await safeExecResultAsync(command, args);
    if (result.status !== 0) throw new Error('Failed to open URL in Chrome: ' + result.stderr);
  },
};
