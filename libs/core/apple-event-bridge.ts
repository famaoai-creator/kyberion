import { safeExec, safeExecResult } from './secure-io.js';
import {
  getMacOSFocusedInput,
  getMacOSScreenSize,
  listMacOSAXWindows,
  performMacOSMouseOperation,
  probeMacOSNativeAutomation,
} from './macos-native-automation.js';

export interface FocusedInputState {
  application: string;
  windowTitle: string;
  role: string;
  description: string;
  editable: boolean;
}

function isDarwin() {
  return process.platform === 'darwin';
}

export function toAppleScriptString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function launchApplication(application: string): boolean {
  if (!isDarwin() || !application.trim()) return false;
  return safeExecResult('open', ['-a', application.trim()], { timeoutMs: 10_000 }).status === 0;
}

export function activateApplication(application: string) {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', [
    '-e',
    `tell application "${toAppleScriptString(application)}" to activate`,
  ]);
}

/** Postcondition read: which app is frontmost after an activate dispatch. */
export function getFrontmostApplicationName(): string {
  if (!isDarwin()) return '';
  try {
    return runAppleScript(
      'tell application "System Events" to get name of first application process whose frontmost is true'
    );
  } catch {
    return '';
  }
}

export function detectFocusedInput(): FocusedInputState {
  return getMacOSFocusedInput();
}

/** Native Accessibility availability; no permission request or application event. */
export function isUIAutomationAvailable(): boolean {
  const native = probeMacOSNativeAutomation();
  return native.available && native.accessibility === 'granted';
}

export function keystrokeText(text: string) {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', [
    '-e',
    `tell application "System Events" to keystroke "${toAppleScriptString(text)}"`,
  ]);
}

export function pasteText(text: string) {
  if (!isDarwin()) {
    return;
  }
  const script = [
    'set oldClipboard to the clipboard',
    `set the clipboard to "${toAppleScriptString(text)}"`,
    'tell application "System Events" to keystroke "v" using command down',
    'delay 0.1',
    'set the clipboard to oldClipboard',
  ].join('\n');
  safeExec('osascript', ['-e', script]);
}

export function pressKey(key: string) {
  if (!isDarwin()) {
    return;
  }
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey === 'enter' || normalizedKey === 'return') {
    safeExec('osascript', ['-e', 'tell application "System Events" to key code 36']);
    return;
  }
  safeExec('osascript', [
    '-e',
    `tell application "System Events" to keystroke "${toAppleScriptString(normalizedKey)}"`,
  ]);
}

const MODIFIER_DOWN: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  meta: 'command down',
  ctrl: 'control down',
  control: 'control down',
  alt: 'option down',
  option: 'option down',
  shift: 'shift down',
};

const NAMED_KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  space: 49,
  backspace: 51,
  delete: 117,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
};

export function pressKeyChord(key: string, modifiers: string[] = []) {
  if (!isDarwin()) {
    return;
  }
  const normalizedKey = key.trim().toLowerCase();
  const downs = (modifiers || [])
    .map((m) => MODIFIER_DOWN[String(m).trim().toLowerCase()])
    .filter(Boolean);
  if (!downs.length) {
    pressKey(normalizedKey);
    return;
  }
  const using = ` using {${downs.join(', ')}}`;
  const code = NAMED_KEY_CODES[normalizedKey];
  const body =
    code !== undefined
      ? `key code ${code}${using}`
      : `keystroke "${toAppleScriptString(normalizedKey)}"${using}`;
  safeExec('osascript', ['-e', `tell application "System Events" to ${body}`]);
}

export function pressKeyCode(keyCode: number) {
  if (!isDarwin()) {
    return;
  }
  const normalizedKeyCode = Number(keyCode);
  if (!Number.isInteger(normalizedKeyCode) || normalizedKeyCode <= 0) {
    throw new Error(`Invalid key code for pressKeyCode: ${keyCode}`);
  }
  safeExec('osascript', [
    '-e',
    `tell application "System Events" to key code ${normalizedKeyCode}`,
  ]);
}

export function toggleDictation(keyCode = 176) {
  if (!isDarwin()) {
    return;
  }
  pressKeyCode(keyCode);
}

export function clickAt(x: number, y: number, clickCount = 1) {
  performMacOSMouseOperation({ type: 'click', x, y, button: 'left', count: clickCount });
}

export function rightClickAt(x: number, y: number, clickCount = 1) {
  performMacOSMouseOperation({ type: 'click', x, y, button: 'right', count: clickCount });
}

export function moveMouse(x: number, y: number) {
  performMacOSMouseOperation({ type: 'move', x, y });
}

export function scrollAt(
  x: number,
  y: number,
  direction: 'up' | 'down' | 'left' | 'right',
  amount = 3
) {
  performMacOSMouseOperation({ type: 'scroll', x, y, direction, amount });
}

export function dragFrom(x1: number, y1: number, x2: number, y2: number) {
  performMacOSMouseOperation({ type: 'drag', fromX: x1, fromY: y1, toX: x2, toY: y2 });
}

export function runAppleScript(script: string): string {
  if (!isDarwin()) return '';
  return String(safeExec('osascript', ['-e', script])).trim();
}

export function getScreenSize(): { width: number; height: number } {
  return getMacOSScreenSize();
}

export function getWindowList(appName: string): string[] {
  return listMacOSAXWindows(appName);
}

export function activateWindowByTitle(
  appName: string,
  windowTitle: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'contains'
) {
  if (!isDarwin()) return false;
  const script = [
    'tell application "System Events"',
    `tell process "${toAppleScriptString(appName)}"`,
    'set frontmost to true',
    'try',
    'set targetWindow to missing value',
    'set windowNames to name of every window',
    'repeat with w in windowNames',
    `if ${
      matchPolicy === 'strict'
        ? 'w is "' + toAppleScriptString(windowTitle) + '"'
        : matchPolicy === 'prefix'
          ? '(w as string) starts with "' + toAppleScriptString(windowTitle) + '"'
          : '(w as string) contains "' + toAppleScriptString(windowTitle) + '"'
    } then`,
    'set targetWindow to (first window whose name is w)',
    'exit repeat',
    'end if',
    'end repeat',
    'if targetWindow is not missing value then',
    'try',
    'perform action "AXRaise" of targetWindow',
    'end try',
    'try',
    'set index of targetWindow to 1',
    'end try',
    'return "true"',
    'end if',
    'return "false"',
    'on error',
    'return "false"',
    'end try',
    'end tell',
    'end tell',
  ].join('\n');
  try {
    return runAppleScript(script).trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function setWindowState(
  appName: string,
  windowTitle: string,
  state: 'maximize' | 'minimize' | 'restore',
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'contains'
): boolean {
  if (!isDarwin() || !appName.trim() || !windowTitle.trim()) return false;
  const condition =
    matchPolicy === 'strict'
      ? `name of w is "${toAppleScriptString(windowTitle)}"`
      : matchPolicy === 'prefix'
        ? `(name of w as string) starts with "${toAppleScriptString(windowTitle)}"`
        : `(name of w as string) contains "${toAppleScriptString(windowTitle)}"`;
  const action =
    state === 'maximize'
      ? 'perform action "AXZoom" of w'
      : state === 'minimize'
        ? 'perform action "AXMinimize" of w'
        : 'set value of attribute "AXMinimized" of w to false';
  const script = [
    'tell application "System Events"',
    `tell process "${toAppleScriptString(appName)}"`,
    'set frontmost to true',
    'repeat with w in windows',
    `if ${condition} then`,
    `try ${action} on error return "false" end try`,
    'return "true"',
    'end if',
    'end repeat',
    'return "false"',
    'end tell',
    'end tell',
  ].join('\n');
  try {
    return runAppleScript(script).trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function quitApplication(appName: string) {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', ['-e', `tell application "${toAppleScriptString(appName)}" to quit`]);
}

export function systemNotify(title: string, message: string, subtitle?: string) {
  if (!isDarwin()) {
    return;
  }
  const sub = subtitle ? ` subtitle "${toAppleScriptString(subtitle)}"` : '';
  try {
    safeExec('osascript', [
      '-e',
      `display notification "${toAppleScriptString(message)}" with title "${toAppleScriptString(title)}"${sub}`,
    ]);
  } catch {
    // Notifications are best-effort. They must not fail the user flow.
  }
}

export function clipboardRead(): string {
  if (!isDarwin()) return '';
  return runAppleScript('return the clipboard');
}

export function clipboardWrite(text: string): void {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', ['-e', `set the clipboard to "${toAppleScriptString(text)}"`]);
}

export function takeScreenshot(
  outputPath: string,
  options?: { silent?: boolean; displayIndex?: number }
): string {
  if (!isDarwin()) return '';
  const args = ['-x'];
  if (options?.displayIndex !== undefined) {
    args.push('-D', String(options.displayIndex + 1));
  }
  args.push(outputPath);
  safeExec('screencapture', args);
  return outputPath;
}
