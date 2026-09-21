/**
 * Lightpanda provider for the browser-automation-runtime seam.
 *
 * Lightpanda (https://github.com/lightpanda-io/browser) is a CDP headless
 * browser without a layout engine: fast and light for read-mostly flows, but
 * one page per session, no pixel screenshots, no WebAuthn. The binary comes
 * from the governed tool-runtime `lightpanda` (`pnpm tool:setup -- --tool
 * lightpanda --apply`), overridable with KYBERION_LIGHTPANDA_BIN.
 *
 * Each session spawns its own `lightpanda serve` and works in a fresh browser
 * context: the default context carries a phantom about:blank page whose
 * navigation never completes, so it is never handed to the actuator.
 */

import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { logger } from '@agent/core/core';
import {
  registerBrowserAutomationRuntimeBridge,
  type BrowserAutomationLaunchPersistentContextOptions,
  type BrowserAutomationRuntimeCapabilities,
} from '@agent/core/browser-automation-runtime-bridge';
import { safeSpawn } from '@agent/core/secure-io';
import { resolveLightpandaBin } from '@agent/core/tool-binary-resolvers';

export const LIGHTPANDA_BRIDGE_ID = 'lightpanda';

export const LIGHTPANDA_CAPABILITIES: Readonly<BrowserAutomationRuntimeCapabilities> =
  Object.freeze({
    multi_tab: false,
    pixel_screenshots: false,
    video_recording: false,
    webauthn: false,
    persistent_profile: false,
    attach_existing_browser: false,
  });

const STARTUP_TIMEOUT_MS = 10_000;

/** Parse Lightpanda's own bound-port announcement (avoids reserve/close TOCTOU). */
export function extractLightpandaListeningPort(text: string): number | undefined {
  const match = text.match(/address=(?:["']?)(?:127\.0\.0\.1|localhost):(\d+)/u);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/** Require the CDP endpoint to identify itself as Lightpanda before attaching. */
export function isLightpandaCdpVersion(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['Browser', 'browser', 'product']
    .map((key) => record[key])
    .some((candidate) => typeof candidate === 'string' && /lightpanda/iu.test(candidate));
}

async function connectWhenReady(endpoint: string, isAlive: () => boolean): Promise<Browser> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (!isAlive()) break;
    try {
      const version = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!version.ok) throw new Error(`CDP version endpoint returned HTTP ${version.status}`);
      const versionPayload: unknown = await version.json();
      if (!isLightpandaCdpVersion(versionPayload)) {
        throw new Error('CDP endpoint did not identify itself as Lightpanda');
      }
      return await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const reason = lastError instanceof Error ? lastError.message.split('\n')[0] : 'process exited';
  throw new Error(`[lightpanda] CDP server at ${endpoint} did not become ready: ${reason}`);
}

async function launchLightpandaContext(
  options: BrowserAutomationLaunchPersistentContextOptions
): Promise<BrowserContext> {
  const bin = resolveLightpandaBin();
  const child = safeSpawn(
    bin,
    // Let Lightpanda bind port 0 itself and report the resulting port. A
    // reserve-then-close allocation has a local TOCTOU race before the child
    // can bind, which could connect the actuator to another local service.
    ['serve', '--host', '127.0.0.1', '--port', '0', '--log-level', 'warn'],
    { env: { LIGHTPANDA_DISABLE_TELEMETRY: 'true', LIGHTPANDA_DISABLE_CORE_DUMP: '1' } }
  );
  let exited = false;
  let stderrTail = '';
  let serverLogBuffer = '';
  let resolvePort: (port: number) => void = () => undefined;
  let rejectPort: (error: Error) => void = () => undefined;
  const portReady = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  const portTimer = setTimeout(
    () => rejectPort(new Error('Lightpanda did not report its bound CDP port')),
    STARTUP_TIMEOUT_MS
  );
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-2_000);
    serverLogBuffer = (serverLogBuffer + text).slice(-2_000);
    const port = extractLightpandaListeningPort(serverLogBuffer);
    if (port) resolvePort(port);
  });
  child.stdout.resume();
  child.on('error', (error) => {
    exited = true;
    rejectPort(error);
    stderrTail += `\n${error.message}`;
  });
  child.on('exit', () => {
    exited = true;
    rejectPort(new Error('Lightpanda exited before reporting its bound CDP port'));
  });
  const stop = () => {
    if (!exited) child.kill('SIGTERM');
  };
  process.once('exit', stop);

  let browser: Browser;
  let endpoint = 'http://127.0.0.1:<pending-port>';
  try {
    const port = await portReady;
    clearTimeout(portTimer);
    endpoint = `http://127.0.0.1:${port}`;
    browser = await connectWhenReady(endpoint, () => !exited);
  } catch (error: unknown) {
    clearTimeout(portTimer);
    stop();
    process.removeListener('exit', stop);
    const detail = stderrTail.trim()
      ? ` (${stderrTail.trim().split('\n').slice(-3).join(' | ')})`
      : '';
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail}. ` +
        `Binary: ${bin} — install with \`pnpm tool:setup -- --tool lightpanda --apply\` or set KYBERION_LIGHTPANDA_BIN.`
    );
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.removeListener('exit', stop);
    browser.removeListener('disconnected', shutdown);
    if (browser.isConnected()) void browser.close().catch(() => undefined);
    stop();
  };
  browser.on('disconnected', shutdown);

  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      locale: options.locale,
    });
    context.on('close', shutdown);
    logger.info(`🐼 [BROWSER] Lightpanda session on ${endpoint} (${bin})`);
    return context;
  } catch (error: unknown) {
    shutdown();
    throw error;
  }
}

let registered = false;

export function registerLightpandaBrowserAutomationRuntime(): void {
  if (registered) return;
  registered = true;
  registerBrowserAutomationRuntimeBridge({
    bridge_id: LIGHTPANDA_BRIDGE_ID,
    capabilities: LIGHTPANDA_CAPABILITIES,
    connectOverCDP() {
      return Promise.reject(
        new Error(
          '[lightpanda] attaching to an existing browser is not supported; the provider owns its own `lightpanda serve` process'
        )
      );
    },
    launchPersistentContext(_userDataDir, options) {
      return launchLightpandaContext(options);
    },
  });
}

registerLightpandaBrowserAutomationRuntime();
