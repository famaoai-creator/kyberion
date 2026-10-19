import * as mac from '../apple-event-bridge.js';
import * as windows from '../windows-os-automation.js';
import type { FocusedInputState } from '../apple-event-bridge.js';

export interface OsAutomationPlatformAdapter {
  launchApplication(application: string): boolean;
  activateApplication(application: string): void;
  detectFocusedInput(): FocusedInputState;
  keystrokeText(text: string): void;
  pasteText(text: string): void;
  pressKey(key: string): void;
  pressKeyChord(key: string, modifiers?: string[]): void;
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
  isUIAutomationAvailable?(): boolean;
  activateWindowByTitle(
    appName: string,
    windowTitle: string,
    matchPolicy?: 'strict' | 'prefix' | 'contains'
  ): boolean;
  setWindowState(
    appName: string,
    windowTitle: string,
    state: 'maximize' | 'minimize' | 'restore',
    matchPolicy?: 'strict' | 'prefix' | 'contains'
  ): boolean;
  quitApplication(appName: string): void;
  systemNotify(title: string, message: string, subtitle?: string): void;
  clipboardRead(): string;
  clipboardWrite(text: string): void;
  takeScreenshot(outputPath: string, options?: { silent?: boolean; displayIndex?: number }): string;
}

export type MouseOperation =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: number }
  | {
      type: 'scroll';
      x: number;
      y: number;
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: number;
    }
  | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number };

/** Build the stable pointer API over platform-native primitives. */
export function createMouseOperationExecutor(
  adapter: Pick<
    OsAutomationPlatformAdapter,
    'moveMouse' | 'clickAt' | 'rightClickAt' | 'scrollAt' | 'dragFrom'
  >
): (operation: MouseOperation) => void {
  return (operation) => {
    switch (operation.type) {
      case 'move':
        adapter.moveMouse(operation.x, operation.y);
        return;
      case 'click':
        (operation.button === 'right' ? adapter.rightClickAt : adapter.clickAt)(
          operation.x,
          operation.y,
          operation.count ?? 1
        );
        return;
      case 'scroll':
        adapter.scrollAt(operation.x, operation.y, operation.direction, operation.amount);
        return;
      case 'drag':
        adapter.dragFrom(operation.fromX, operation.fromY, operation.toX, operation.toY);
        return;
    }
  };
}

const macAdapter: OsAutomationPlatformAdapter = mac;
const windowsAdapter: OsAutomationPlatformAdapter = windows;
const unsupportedAdapter: OsAutomationPlatformAdapter = {
  launchApplication: () => false,
  activateApplication: () => undefined,
  detectFocusedInput: () => ({
    application: '',
    windowTitle: '',
    role: '',
    description: '',
    editable: false,
  }),
  keystrokeText: () => undefined,
  pasteText: () => undefined,
  pressKey: () => undefined,
  pressKeyChord: () => undefined,
  pressKeyCode: () => undefined,
  toggleDictation: () => undefined,
  clickAt: () => undefined,
  rightClickAt: () => undefined,
  moveMouse: () => undefined,
  scrollAt: () => undefined,
  dragFrom: () => undefined,
  runAppleScript: () => '',
  getScreenSize: () => ({ width: 0, height: 0 }),
  getWindowList: () => [],
  isUIAutomationAvailable: () => false,
  activateWindowByTitle: () => false,
  setWindowState: () => false,
  quitApplication: () => undefined,
  systemNotify: () => undefined,
  clipboardRead: () => '',
  clipboardWrite: () => undefined,
  takeScreenshot: () => '',
};

/** Select once at the boundary; platform-specific code stays inside adapters. */
export function resolveOsAutomationPlatform(
  platform: NodeJS.Platform = process.platform
): OsAutomationPlatformAdapter {
  if (platform === 'win32') return windowsAdapter;
  if (platform === 'darwin') return macAdapter;
  return unsupportedAdapter;
}
