export {
  activateApplication,
  detectFocusedInput,
  keystrokeText,
  pasteText,
  pressKey,
  clickAt,
  rightClickAt,
  moveMouse,
  toAppleScriptString,
} from './apple-event-bridge.js';
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
export type { FocusedInputState } from './apple-event-bridge.js';
