/**
 * BrowserMeetingJoinDriver — drive Meet/Zoom/Teams pre-join UIs with
 * Playwright and return a `MeetingSession` whose audio I/O flows
 * through the supplied `AudioBus`.
 *
 * Design:
 *   - Playwright is loaded **lazily** so this package is installable
 *     in environments that won't ever run the driver (CI, server
 *     farms that use vendor SDKs).
 *   - Pre-join interactions are described by the `selectors` table —
 *     keep DOM-fragility out of this file.
 *   - Cookie persistence lets a Google login carry across runs;
 *     `account_slug` keys the cookie file.
 *   - The session's `audioInput` is driven by the bus. The browser
 *     itself plays the meeting audio out to the system audio
 *     subsystem (BlackHole / null-sink) and our bus reads it back —
 *     same on the input side. The driver does not synthesize audio
 *     directly.
 *
 * What this driver does NOT do (left to follow-up wave):
 *   - bot-detection evasion / fingerprint spoofing
 *   - vendor-SDK direct PCM streams (Zoom Meeting SDK does this; not
 *     required for Meet, which has no public bot SDK)
 */

import {
  registerMeetingJoinDriver,
  logger,
  classifyError,
  withRetry,
  type AudioBus,
  type AudioChunk,
  validateMeetingTarget,
  type MeetingJoinDriver,
  type MeetingSession,
  type MeetingSessionState,
  type MeetingTarget,
} from '@agent/core';
import {
  MEET_SELECTORS,
  TEAMS_SELECTORS,
  ZOOM_SELECTORS,
  selectorsForPlatform,
  type MeetingPreJoinSelectors,
} from './selectors.js';
import { readCookies, writeCookies } from './cookie-store.js';
import { safeReadFile, pathResolver } from '@agent/core';

/* Playwright type stand-ins so this file compiles without playwright
 * installed. The real types are loaded via `import('playwright')` at
 * runtime. */
type PlaywrightBrowser = { close: () => Promise<void> };
type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  cookies: () => Promise<unknown[]>;
  addCookies: (cookies: any[]) => Promise<void>;
  close: () => Promise<void>;
};
type PlaywrightPage = {
  goto: (url: string, opts?: any) => Promise<unknown>;
  fill: (selector: string, value: string) => Promise<void>;
  click: (selector: string, opts?: any) => Promise<void>;
  locator: (selector: string) => { first: () => { click: () => Promise<void>; isVisible: () => Promise<boolean> } };
  waitForSelector: (selector: string, opts?: any) => Promise<unknown>;
  isVisible: (selector: string) => Promise<boolean>;
};

const MEETING_BROWSER_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/meeting-browser-driver/manifest.json');
const DEFAULT_MEETING_BROWSER_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

export interface BrowserDriverOptions {
  /** When true, run a visible Chromium (debugging). Default: false (headed=false). */
  headed?: boolean;
  /** Cookie jar key. */
  account_slug?: string;
  /** Override selectors per deployment / DOM update. */
  selectors_override?: Partial<Record<'meet' | 'zoom' | 'teams', MeetingPreJoinSelectors>>;
  /** Timeout in ms for any single pre-join step. */
  step_timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 20_000;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(MEETING_BROWSER_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_MEETING_BROWSER_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

async function loadPlaywright(): Promise<any> {
  // Keep playwright optional: a literal dynamic import would make
  // TypeScript require installed type declarations during repo builds.
  return new Function('specifier', 'return import(specifier)')('playwright');
}

class BrowserMeetingJoinDriver implements MeetingJoinDriver {
  readonly driver_id = 'browser-playwright';
  readonly supported_platforms = ['meet', 'zoom', 'teams', 'auto'] as const;

  constructor(private readonly opts: BrowserDriverOptions = {}) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      // Optional dependency — we don't `require`/`import` it
      // statically so non-bot deployments aren't forced to install.
      await withRetry(async () => loadPlaywright(), buildRetryOptions());
      return { available: true };
    } catch (err: any) {
      return {
        available: false,
        reason: `playwright is not installed in this workspace. \`pnpm add -w playwright && pnpm exec playwright install chromium\`. (${err?.message ?? err})`,
      };
    }
  }

  async join(target: MeetingTarget, bus: AudioBus): Promise<MeetingSession> {
    const probe = await this.probe();
    if (!probe.available) throw new Error(`[browser-driver] ${probe.reason}`);
    const { chromium } = await loadPlaywright();
    const validatedTarget = validateMeetingTarget(target);
    const platform = validatedTarget.platform;
    const selectors = this.opts.selectors_override?.[platform as 'meet' | 'zoom' | 'teams']
      ?? selectorsForPlatform(platform);
    const accountSlug = this.opts.account_slug ?? 'default';
    const stepTimeout = this.opts.step_timeout_ms ?? DEFAULT_TIMEOUT;
    const headed = this.opts.headed ?? false;

    const browser = (await withRetry(async () => chromium.launch({
      headless: !headed,
      args: [
        // Auto-allow microphone + camera permissions so the pre-join
        // UI doesn't prompt and stall the join.
        '--use-fake-ui-for-media-stream',
        // Required for headless WebRTC on some platforms.
        '--disable-blink-features=AutomationControlled',
      ],
    }), buildRetryOptions())) as unknown as PlaywrightBrowser;

    const context = (await withRetry(async () => (browser as any).newContext({
      permissions: ['microphone', 'camera'],
      viewport: { width: 1280, height: 800 },
    }), buildRetryOptions())) as PlaywrightContext;

    // Restore cookies if we have any persisted for this account slug.
    const persisted = readCookies(accountSlug);
    if (persisted.length) await context.addCookies(persisted as any[]);

    const page = await withRetry(async () => context.newPage(), buildRetryOptions());
    const state: MeetingSessionState = {
      session_id: `browser-${Date.now()}`,
      platform,
      status: 'connecting',
    };

    try {
      await withRetry(async () => page.goto(validatedTarget.url, { waitUntil: 'domcontentloaded', timeout: stepTimeout }), buildRetryOptions());
      // Best-effort fill display name (guest path — Meet only).
      if (validatedTarget.display_name) {
        await trySelectors(page, selectors.name_input, async (sel) => {
          await page.fill(sel, validatedTarget.display_name!);
        });
      }
      // Mute mic + camera before joining (the AI controls speech via
      // TTS into the bus, not browser-mic).
      await trySelectors(page, selectors.mute_mic_button, async (sel) => {
        await page.click(sel, { timeout: 2000 });
      });
      await trySelectors(page, selectors.disable_camera_button, async (sel) => {
        await page.click(sel, { timeout: 2000 });
      });

      // Click Join / Ask to join.
      const joined = await trySelectors(page, selectors.join_button, async (sel) => {
        await page.click(sel, { timeout: stepTimeout });
      });
      if (!joined) throw new Error(`[browser-driver] no join button matched (${platform})`);
      state.status = 'in_meeting';
      state.joined_at = new Date().toISOString();

      // Persist cookies so next run skips the login.
      try {
        const fresh = await context.cookies();
        writeCookies(accountSlug, fresh);
      } catch (err: any) {
        logger.warn(`[browser-driver] cookie persist failed: ${err?.message ?? err}`);
      }
    } catch (err: any) {
      state.status = 'error';
      state.error = err?.message ?? String(err);
        await withRetry(async () => browser.close().catch(() => undefined), buildRetryOptions());
        throw err;
      }

    let leaveSignaled = false;
    return {
      state,
      async *audioInput(): AsyncIterable<AudioChunk> {
        for await (const chunk of bus.inputStream()) {
          if (leaveSignaled) return;
          yield chunk;
        }
      },
      async audioOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
        await bus.writeOutput(stream);
      },
      async chat(_text: string): Promise<void> {
        // Chat is platform-specific; selectors not yet wired.
      },
      async leave(): Promise<void> {
        leaveSignaled = true;
        await withRetry(async () => trySelectors(page, selectors.leave_button, async (sel) => {
          await page.click(sel, { timeout: 5_000 });
        }), buildRetryOptions());
        state.status = 'ended';
        state.left_at = new Date().toISOString();
        await withRetry(async () => browser.close().catch(() => undefined), buildRetryOptions());
        await withRetry(async () => bus.close(), buildRetryOptions());
      },
    };
  }
}

async function trySelectors(
  page: PlaywrightPage,
  selectors: string[],
  action: (selector: string) => Promise<void>,
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const visible = await page.isVisible(sel).catch(() => false);
      if (!visible) continue;
      await action(sel);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

export {
  BrowserMeetingJoinDriver,
  MEET_SELECTORS,
  TEAMS_SELECTORS,
  ZOOM_SELECTORS,
};
export type { MeetingPreJoinSelectors };

/**
 * Convenience: register the driver with the core registry on import.
 * Pass options via `installBrowserMeetingJoinDriver(...)`.
 */
export function installBrowserMeetingJoinDriver(opts: BrowserDriverOptions = {}): void {
  registerMeetingJoinDriver(new BrowserMeetingJoinDriver(opts));
}
