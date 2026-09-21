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

import * as net from 'node:net';
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

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no loopback port'))));
    });
  });
}

async function connectWhenReady(endpoint: string, isAlive: () => boolean): Promise<Browser> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (!isAlive()) break;
    try {
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
  const port = await allocateLoopbackPort();
  const child = safeSpawn(
    bin,
    ['serve', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warn'],
    { env: { LIGHTPANDA_DISABLE_TELEMETRY: 'true', LIGHTPANDA_DISABLE_CORE_DUMP: '1' } }
  );
  let exited = false;
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2_000);
  });
  child.stdout.resume();
  child.on('error', (error) => {
    exited = true;
    stderrTail += `\n${error.message}`;
  });
  child.on('exit', () => {
    exited = true;
  });
  const stop = () => {
    if (!exited) child.kill('SIGTERM');
  };
  process.once('exit', stop);

  let browser: Browser;
  try {
    browser = await connectWhenReady(`http://127.0.0.1:${port}`, () => !exited);
  } catch (error: unknown) {
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

  const shutdown = () => {
    process.removeListener('exit', stop);
    void browser.close().catch(() => undefined);
    stop();
  };
  browser.on('disconnected', shutdown);

  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      locale: options.locale,
    });
    context.on('close', shutdown);
    logger.info(`🐼 [BROWSER] Lightpanda session on 127.0.0.1:${port} (${bin})`);
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
