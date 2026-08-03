import { resolveOsAutomationPlatform } from './os-automation-platform.js';
import type { FocusedInputState } from './apple-event-bridge.js';

const platform = resolveOsAutomationPlatform();

export const activateApplication = platform.activateApplication;
export const detectFocusedInput = platform.detectFocusedInput;
export const keystrokeText = platform.keystrokeText;
export const pasteText = platform.pasteText;
export const pressKey = platform.pressKey;
export const pressKeyCode = platform.pressKeyCode;
export const toggleDictation = platform.toggleDictation;
export const clickAt = platform.clickAt;
export const rightClickAt = platform.rightClickAt;
export const moveMouse = platform.moveMouse;
export const scrollAt = platform.scrollAt;
export const dragFrom = platform.dragFrom;
export const runAppleScript = platform.runAppleScript;
export const getScreenSize = platform.getScreenSize;
export const getWindowList = platform.getWindowList;
export const activateWindowByTitle = platform.activateWindowByTitle;
export const quitApplication = platform.quitApplication;
export const systemNotify = platform.systemNotify;
export const clipboardRead = platform.clipboardRead;
export const clipboardWrite = platform.clipboardWrite;
export const takeScreenshot = platform.takeScreenshot;

export const toAppleScriptString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export {
  listKnownAppCapabilities,
  listTerminalTargets,
  listChromeTabs,
  activateChromeTabByTitle,
  activateChromeTabByUrl,
  closeChromeTabByTitle,
  closeChromeTabByUrl,
  emptyFinderTrash,
  revealFinderPath,
  openFinderPath,
} from './os-app-adapters.js';
export { terminalBridge } from './terminal-bridge.js';
export type { FocusedInputState };
