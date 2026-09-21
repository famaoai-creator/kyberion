/**
 * Browser-automation-runtime seam — headless/browser engine backends.
 *
 * Callers resolve by id; Playwright Chromium registers as the builtin
 * provider from the browser-actuator package so core never imports Playwright.
 */

import { coreSeamCatalog, createSeam } from './seam.js';

export interface BrowserAutomationLaunchPersistentContextOptions {
  channel?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  recordVideo?: { dir: string };
  args?: string[];
  [key: string]: unknown;
}

/**
 * What a provider can do beyond basic single-page automation (navigate,
 * locate, fill, click, evaluate, cookies, routing). Callers preflight
 * pipelines against these flags so unsupported ops fail before launch.
 */
export interface BrowserAutomationRuntimeCapabilities {
  /** More than one page per session: open_tab / select_tab / popups. */
  multi_tab: boolean;
  /** Screenshots rendered with real layout (usable as visual evidence). */
  pixel_screenshots: boolean;
  video_recording: boolean;
  /** CDP WebAuthn domain (virtual authenticators / passkeys). */
  webauthn: boolean;
  /** Chrome user-data-dir profiles (channel, profile_directory, DevToolsActivePort). */
  persistent_profile: boolean;
  /** Attach to an already running browser over CDP. */
  attach_existing_browser: boolean;
}

export const FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES: Readonly<BrowserAutomationRuntimeCapabilities> =
  Object.freeze({
    multi_tab: true,
    pixel_screenshots: true,
    video_recording: true,
    webauthn: true,
    persistent_profile: true,
    attach_existing_browser: true,
  });

export interface BrowserAutomationRuntimeBridge {
  readonly bridge_id: string;
  /** Omitted = full Chromium-equivalent capabilities. */
  readonly capabilities?: Readonly<BrowserAutomationRuntimeCapabilities>;
  connectOverCDP(endpoint: string): Promise<unknown>;
  launchPersistentContext(
    userDataDir: string,
    options: BrowserAutomationLaunchPersistentContextOptions
  ): Promise<unknown>;
}

const browserAutomationRuntimeSeam = createSeam<BrowserAutomationRuntimeBridge>({
  key: 'browser-automation-runtime',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const registeredDisposers = new Map<string, () => void>();

export function registerBrowserAutomationRuntimeBridge(
  bridge: BrowserAutomationRuntimeBridge
): () => void {
  const id = String(bridge.bridge_id || '').trim();
  if (!id) throw new Error('BrowserAutomationRuntimeBridge.bridge_id is required');
  registeredDisposers.get(id)?.();
  const disposer = browserAutomationRuntimeSeam.register(id, bridge, {
    provenance: 'builtin',
    source: 'browser-automation-runtime-bridge',
  });
  registeredDisposers.set(id, disposer);
  return disposer;
}

export function listBrowserAutomationRuntimeBridges(): BrowserAutomationRuntimeBridge[] {
  return browserAutomationRuntimeSeam.list().map((entry) => entry.implementation);
}

export function resetBrowserAutomationRuntimeBridges(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
}

export function resolveBrowserAutomationRuntime(
  preference?: string
): BrowserAutomationRuntimeBridge {
  const bridges = listBrowserAutomationRuntimeBridges();
  const wanted =
    String(preference || 'auto')
      .trim()
      .toLowerCase() || 'auto';
  if (wanted !== 'auto') {
    const exact = bridges.find((bridge) => bridge.bridge_id === wanted);
    if (!exact) {
      throw new Error(
        `[browser-automation-runtime] provider '${wanted}' is not registered (have: ${
          bridges.map((bridge) => bridge.bridge_id).join(', ') || 'none'
        })`
      );
    }
    return exact;
  }
  if (bridges.length === 0) {
    throw new Error(
      '[browser-automation-runtime] no browser automation runtime providers registered'
    );
  }
  // Capability-restricted providers (e.g. lightpanda) are opt-in only: 'auto'
  // never silently downgrades a session, whatever the registration order.
  const full = bridges.find((bridge) => !bridge.capabilities);
  if (!full) {
    throw new Error(
      '[browser-automation-runtime] no full-capability provider is registered; ' +
        'select a restricted provider explicitly by id'
    );
  }
  return full;
}

export function getBrowserAutomationRuntimeCapabilities(
  bridge: BrowserAutomationRuntimeBridge
): Readonly<BrowserAutomationRuntimeCapabilities> {
  return bridge.capabilities ?? FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES;
}
