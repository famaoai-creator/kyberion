import { safeExec } from './secure-io.js';
import { activateApplication, toAppleScriptString } from './apple-event-bridge.js';

export interface KnownAppCapability {
  application: string;
  adapter: 'browser_tabs' | 'terminal' | 'file_manager';
  capabilities: string[];
}

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
}

const KNOWN_APP_CAPABILITIES: KnownAppCapability[] = [
  {
    application: 'Google Chrome',
    adapter: 'browser_tabs',
    capabilities: ['list_tabs', 'activate_tab_by_title'],
  },
  {
    application: 'Finder',
    adapter: 'file_manager',
    capabilities: ['empty_trash'],
  },
  {
    application: 'Terminal',
    adapter: 'terminal',
    capabilities: ['activate_application'],
  },
  {
    application: 'iTerm2',
    adapter: 'terminal',
    capabilities: ['activate_application'],
  },
];

function isDarwin() {
  return process.platform === 'darwin';
}

export function listKnownAppCapabilities(): KnownAppCapability[] {
  return KNOWN_APP_CAPABILITIES.map((entry) => ({
    ...entry,
    capabilities: [...entry.capabilities],
  }));
}

export function listChromeTabs(application = 'Google Chrome'): BrowserTabInfo[] {
  if (!isDarwin()) {
    return [];
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    'set outLines to {}',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'set end of outLines to ((index of t as string) & linefeed & (title of t as string) & linefeed & (URL of t as string))',
    'end repeat',
    'end repeat',
    'return outLines as string',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  if (!output) {
    return [];
  }
  const lines = output.split('\n').map((line) => line.trim());
  const tabs: BrowserTabInfo[] = [];
  for (let index = 0; index < lines.length; index += 3) {
    tabs.push({
      index: Number(lines[index] || tabs.length + 1),
      title: lines[index + 1] || '',
      url: lines[index + 2] || '',
    });
  }
  return tabs;
}

export function activateChromeTabByTitle(title: string, application = 'Google Chrome') {
  if (!isDarwin()) {
    return { matched: false };
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    `set targetTitle to "${toAppleScriptString(title)}"`,
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if (title of t as string) contains targetTitle then',
    'set active tab index of w to (index of t)',
    'set index of w to 1',
    'return "matched"',
    'end if',
    'end repeat',
    'end repeat',
    'return "not_matched"',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  return { matched: output === 'matched' };
}

export function emptyFinderTrash() {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', ['-e', 'tell application "Finder" to empty the trash']);
}
