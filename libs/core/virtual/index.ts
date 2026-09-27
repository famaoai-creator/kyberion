/** Domain barrel — public surface for libs/core/virtual */
export * from './computer-surface.js';
export * from './desktop-event-feed.js';
export * from './desktop-intent-reconstruction.js';
export * from './desktop-launch-adapter.js';
export * from './desktop-pipeline.js';
export * from './desktop-promotion-transaction.js';
export * from './desktop-recording-compiler.js';
export * from './desktop-recording.js';
export * from './os-accessibility-detector.js';
export * from './os-app-adapters.js';
export * from './os-automation-bridge.js';
export * from './os-automation-platform.js';
export {
  activateApplication,
  detectFocusedInput,
  keystrokeText,
  pasteText,
  pressKey,
  pressKeyCode,
  toggleDictation,
  clickAt,
  rightClickAt,
  moveMouse,
  scrollAt,
  dragFrom,
  runAppleScript,
  getScreenSize,
  getWindowList,
  activateWindowByTitle,
  quitApplication,
  systemNotify,
  clipboardRead,
  clipboardWrite,
  takeScreenshot,
  toAppleScriptString,
  terminalBridge,
  FocusedInputState,
} from './os-automation.js';
export * from './screen-capture-bridge.js';
export * from './screen-display-inventory-bridge.js';
export * from './screen-frame-redaction.js';
export * from './screen-recording-bridge.js';
export * from './virtual-audio-device-bridge.js';
export * from './virtual-audio-input-recording-bridge.js';
export * from './virtual-audio-output-playback-bridge.js';
export * from './virtual-camera-bridge.js';
export * from './virtual-camera-injection-bridge.js';
export * from './virtual-device-inventory-bridge.js';
export * from './virtual-input-device-inventory-bridge.js';
export * from './virtual-media-device-control-bridge.js';
