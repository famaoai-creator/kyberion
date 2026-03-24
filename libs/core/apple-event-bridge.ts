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
