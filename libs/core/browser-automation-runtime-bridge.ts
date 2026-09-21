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

export interface BrowserAutomationRuntimeBridge {
  readonly bridge_id: string;
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
  return bridges[0]!;
}
