import { safeExec } from './secure-io.js';

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

export function activateApplication(application: string) {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', ['-e', `tell application "${toAppleScriptString(application)}" to activate`]);
}

export function detectFocusedInput(): FocusedInputState {
  if (!isDarwin()) {
    return {
      application: '',
      windowTitle: '',
      role: '',
      description: '',
      editable: false,
    };
  }

  const script = [
    'tell application "System Events"',
    'set frontApp to name of first application process whose frontmost is true',
    'set windowTitle to ""',
    'set focusedRole to ""',
    'set focusedDescription to ""',
    'set editableFlag to "false"',
    'tell application process frontApp',
    'try',
    'set windowTitle to name of front window',
    'end try',
    'try',
    'set focusedElement to value of attribute "AXFocusedUIElement"',
    'try',
    'set focusedRole to value of attribute "AXRole" of focusedElement',
    'end try',
    'try',
    'set focusedDescription to value of attribute "AXDescription" of focusedElement',
    'end try',
    'if focusedRole is in {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"} then',
    'set editableFlag to "true"',
    'end if',
    'end try',
    'end tell',
    'return frontApp & linefeed & windowTitle & linefeed & focusedRole & linefeed & focusedDescription & linefeed & editableFlag',
    'end tell',
  ].join('\n');

  const output = String(safeExec('osascript', ['-e', script])).trimEnd();
  const [application = '', windowTitle = '', role = '', description = '', editableFlag = 'false'] = output.split('\n');
  return {
    application,
    windowTitle,
    role,
    description,
    editable: editableFlag.trim().toLowerCase() === 'true',
  };
}

export function keystrokeText(text: string) {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${toAppleScriptString(text)}"`]);
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
  safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${toAppleScriptString(normalizedKey)}"`]);
}

export function pressKeyCode(keyCode: number) {
  if (!isDarwin()) {
    return;
  }
  const normalizedKeyCode = Number(keyCode);
  if (!Number.isInteger(normalizedKeyCode) || normalizedKeyCode <= 0) {
    throw new Error(`Invalid key code for pressKeyCode: ${keyCode}`);
  }
  safeExec('osascript', ['-e', `tell application "System Events" to key code ${normalizedKeyCode}`]);
}

export function toggleDictation(keyCode = 176) {
  if (!isDarwin()) {
    return;
  }
  pressKeyCode(keyCode);
}

export function clickAt(x: number, y: number, clickCount = 1) {
  if (!isDarwin()) {
    return;
  }
  for (let index = 0; index < clickCount; index += 1) {
    safeExec('osascript', ['-e', `tell application "System Events" to click at {${x}, ${y}}`]);
  }
}

export function rightClickAt(x: number, y: number, clickCount = 1) {
  if (!isDarwin()) {
    return;
  }
  for (let index = 0; index < clickCount; index += 1) {
    safeExec('osascript', ['-e', `tell application "System Events" to do shell script "/usr/bin/env cliclick rc:${x},${y}"`]);
  }
}

export function moveMouse(x: number, y: number) {
  if (!isDarwin()) {
    return;
  }
  safeExec('osascript', ['-e', `tell application "System Events" to do shell script "/usr/bin/env cliclick m:${x},${y}"`]);
}

function execCliclick(args: string[]): void {
  try {
    safeExec('cliclick', args);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('No such file')) {
      throw new Error(`This op requires cliclick. Install with: brew install cliclick`);
    }
    throw err;
  }
}

export function scrollAt(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount = 3) {
  if (!isDarwin()) return;
  const dirCode = { up: 'su', down: 'sd', left: 'sl', right: 'sr' }[direction];
  execCliclick([`${dirCode}:${x},${y},${amount}`]);
}

export function dragFrom(x1: number, y1: number, x2: number, y2: number) {
  if (!isDarwin()) return;
  execCliclick([`dd:${x1},${y1}`, `du:${x2},${y2}`]);
}

export function runAppleScript(script: string): string {
  if (!isDarwin()) return '';
  return String(safeExec('osascript', ['-e', script])).trim();
}

export function getScreenSize(): { width: number; height: number } {
  if (!isDarwin()) return { width: 0, height: 0 };
  try {
    const output = runAppleScript('tell application "Finder" to get bounds of window of desktop');
    const parts = output.split(',').map(s => Number(s.trim()));
    return { width: parts[2] ?? 0, height: parts[3] ?? 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

export function getWindowList(appName: string): string[] {
  if (!isDarwin()) return [];
  const script = [
    `tell application "${toAppleScriptString(appName)}"`,
    'try',
    'set windowNames to name of every window',
    'set output to ""',
    'repeat with w in windowNames',
    'set output to output & w & linefeed',
    'end repeat',
    'return output',
    'on error',
    'return ""',
    'end try',
    'end tell',
  ].join('\n');
  try {
    return runAppleScript(script).split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function quitApplication(appName: string) {
  if (!isDarwin()) return;
  safeExec('osascript', ['-e', `tell application "${toAppleScriptString(appName)}" to quit`]);
}

export function systemNotify(title: string, message: string, subtitle?: string) {
  if (!isDarwin()) return;
  const sub = subtitle ? ` subtitle "${toAppleScriptString(subtitle)}"` : '';
  safeExec('osascript', [
    '-e',
    `display notification "${toAppleScriptString(message)}" with title "${toAppleScriptString(title)}"${sub}`,
  ]);
}

export function clipboardRead(): string {
  if (!isDarwin()) return '';
  return runAppleScript('return the clipboard');
}

export function clipboardWrite(text: string): void {
  if (!isDarwin()) return;
  safeExec('osascript', ['-e', `set the clipboard to "${toAppleScriptString(text)}"`]);
}

export function takeScreenshot(outputPath: string, options?: { silent?: boolean; displayIndex?: number }): string {
  if (!isDarwin()) return '';
  const args = ['-x'];
  if (options?.displayIndex !== undefined) {
    args.push('-D', String(options.displayIndex + 1));
  }
  args.push(outputPath);
  safeExec('screencapture', args);
  return outputPath;
}
