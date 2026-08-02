import * as mac from './apple-event-bridge.js';
import * as windows from './windows-os-automation.js';
import type { FocusedInputState } from './apple-event-bridge.js';

export interface OsAutomationPlatformAdapter {
  activateApplication(application: string): void;
  detectFocusedInput(): FocusedInputState;
  keystrokeText(text: string): void;
  pasteText(text: string): void;
  pressKey(key: string): void;
  pressKeyCode(keyCode: number): void;
  toggleDictation(keyCode?: number): void;
  clickAt(x: number, y: number, clickCount?: number): void;
  rightClickAt(x: number, y: number, clickCount?: number): void;
  moveMouse(x: number, y: number): void;
  scrollAt(
    x: number,
    y: number,
    direction: 'up' | 'down' | 'left' | 'right',
    amount?: number
  ): void;
  dragFrom(x1: number, y1: number, x2: number, y2: number): void;
  runAppleScript(script: string): string;
  getScreenSize(): { width: number; height: number };
  getWindowList(appName: string): string[];
  activateWindowByTitle(
    appName: string,
    windowTitle: string,
    matchPolicy?: 'strict' | 'prefix' | 'contains'
  ): boolean;
  quitApplication(appName: string): void;
  systemNotify(title: string, message: string, subtitle?: string): void;
  clipboardRead(): string;
  clipboardWrite(text: string): void;
  takeScreenshot(outputPath: string, options?: { silent?: boolean; displayIndex?: number }): string;
}

const macAdapter: OsAutomationPlatformAdapter = mac;
const windowsAdapter: OsAutomationPlatformAdapter = windows;

/** Select once at the boundary; platform-specific code stays inside adapters. */
export function resolveOsAutomationPlatform(): OsAutomationPlatformAdapter {
  return process.platform === 'win32' ? windowsAdapter : macAdapter;
}
