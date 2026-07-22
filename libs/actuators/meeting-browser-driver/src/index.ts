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
  abortableAudioChunks,
  logger,
  retry,
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
import {
  buildRetryOptions,
  loadPlaywright,
  trySelectors,
  waitForAnyVisibleSelector,
} from './meeting-browser-driver-helpers.js';
import { safeReadFile, pathResolver } from '@agent/core';
import * as path from 'node:path';

/* Playwright type stand-ins so this file compiles without playwright
 * installed. The real types are loaded via `import('playwright')` at
 * runtime. */
type PlaywrightBrowser = { close: () => Promise<void> };
type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  cookies: () => Promise<unknown[]>;
  addCookies: (cookies: any[]) => Promise<void>;
  close: () => Promise<void>;
  pages?: () => PlaywrightPage[];
};
type PlaywrightPage = {
  goto: (url: string, opts?: any) => Promise<unknown>;
  fill: (selector: string, value: string) => Promise<void>;
  click: (selector: string, opts?: any) => Promise<void>;
  close: () => Promise<void>;
  locator: (selector: string) => {
    first: () => { click: () => Promise<void>; isVisible: () => Promise<boolean> };
    innerText: () => Promise<string>;
  };
  waitForSelector: (selector: string, opts?: any) => Promise<unknown>;
  isVisible: (selector: string) => Promise<boolean>;
};

export const MEETING_BROWSER_DRIVER_ID = 'browser-playwright' as const;
export const MEETING_BROWSER_DRIVER_ROLE = 'internal-join-backend' as const;

export interface BrowserDriverOptions {
  /** When true, run a visible Chromium (debugging). Default: false (headed=false). */
  headed?: boolean;
  /** Use an existing Chrome/Chromium profile directory for persistence. */
  user_data_dir?: string;
  /** Select a specific Chrome profile within `user_data_dir`. */
  profile_directory?: string;
  /** Attach to an already-running Chrome via CDP instead of launching a browser. */
  connect_over_cdp?: boolean;
  /** CDP endpoint URL when attaching to an existing Chrome. */
  cdp_url?: string;
  /** CDP port when attaching to an existing Chrome. */
  cdp_port?: number;
  /** Prefer the Chrome channel when launching a persistent context. */
  browser_channel?: 'chrome' | 'chromium';
  /** Cookie jar key. */
  account_slug?: string;
  /** Best-effort Meet pre-join device preferences. */
  microphone_device?: string;
  speaker_device?: string;
  camera_device?: string;
  /** Override selectors per deployment / DOM update. */
  selectors_override?: Partial<Record<'meet' | 'zoom' | 'teams', MeetingPreJoinSelectors>>;
  /** Timeout in ms for any single pre-join step. */
  step_timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 20_000;

interface PlaywrightJoinRuntime {
  browser?: PlaywrightBrowser;
  context: PlaywrightContext;
  cleanup_mode: 'browser' | 'context' | 'none';
}

async function clickFirstVisible(
  page: PlaywrightPage,
  selectors: string[],
  timeoutMs: number
): Promise<boolean> {
  return trySelectors(page, selectors, async (sel) => {
    await page.click(sel, { timeout: timeoutMs });
  });
}

async function fillFirstVisible(
  page: PlaywrightPage,
  selectors: string[],
  value: string | undefined,
  timeoutMs: number
): Promise<boolean> {
  const desired = typeof value === 'string' ? value.trim() : '';
  if (!desired) return false;
  const selector = await waitForAnyVisibleSelector(page, selectors, {
    timeoutMs,
    pollMs: 250,
  });
  if (!selector) return false;
  await page.fill(selector, desired);
  return true;
}

async function selectDeviceChoice(
  page: PlaywrightPage,
  selectors: MeetingPreJoinSelectors,
  controlSelectors: string[],
  preference: string | undefined,
  timeoutMs: number
): Promise<boolean> {
  const desired = typeof preference === 'string' ? preference.trim() : '';
  if (!desired) return false;

  const opened = controlSelectors.length
    ? await clickFirstVisible(page, controlSelectors, timeoutMs)
    : true;
  if (!opened) return false;
  await new Promise((resolve) => setTimeout(resolve, 250));

  const selectHandled = await trySelectors(page, ['select'], async (sel) => {
    await (page as any).locator(sel).selectOption({ label: desired });
  });
  if (selectHandled) return true;

  const optionSelectors = selectors.device_option.flatMap((base) => [
    `${base}:has-text("${desired}")`,
    `${base}[aria-label*="${desired}" i]`,
  ]);

  return trySelectors(page, optionSelectors, async (sel) => {
    await page.click(sel, { timeout: timeoutMs });
  });
}

async function fillMeetingEntryFields(
  page: PlaywrightPage,
  selectors: MeetingPreJoinSelectors,
  target: { meeting_id?: string; passcode?: string; display_name?: string },
  timeoutMs: number
): Promise<void> {
  await fillFirstVisible(page, selectors.meeting_id_input, target.meeting_id, timeoutMs);
  await fillFirstVisible(page, selectors.meeting_passcode_input, target.passcode, timeoutMs);
  // Some vendors expose a name field on a later step or only for guests.
  if (target.display_name) {
    await fillFirstVisible(
      page,
      selectors.name_input,
      target.display_name,
      Math.max(timeoutMs, 20_000)
    );
  }
}

async function configureMeetingDevices(
  page: PlaywrightPage,
  selectors: MeetingPreJoinSelectors,
  preferences: { microphone?: string; speaker?: string; camera?: string },
  timeoutMs: number
): Promise<void> {
  const desired = [preferences.microphone, preferences.speaker, preferences.camera].some(
    (value) => typeof value === 'string' && value.trim().length > 0
  );
  if (!desired) return;

  const opened = await clickFirstVisible(page, selectors.settings_button, timeoutMs);
  if (!opened) return;
  await new Promise((resolve) => setTimeout(resolve, 250));

  await selectDeviceChoice(
    page,
    selectors,
    selectors.microphone_device_button,
    preferences.microphone,
    timeoutMs
  );
  await selectDeviceChoice(
    page,
    selectors,
    selectors.speaker_device_button,
    preferences.speaker,
    timeoutMs
  );
  await selectDeviceChoice(
    page,
    selectors,
    selectors.camera_device_button,
    preferences.camera,
    timeoutMs
  );
}

function resolveChromeUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = typeof userDataDir === 'string' ? userDataDir.trim() : '';
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : pathResolver.rootResolve(trimmed);
}

async function createPlaywrightJoinRuntime(
  chromium: any,
  opts: BrowserDriverOptions
): Promise<PlaywrightJoinRuntime> {
  const headed = opts.headed ?? false;
  const launchArgs = [
    '--use-fake-ui-for-media-stream',
    '--disable-blink-features=AutomationControlled',
  ];

  if (opts.connect_over_cdp) {
    const cdpUrl =
      typeof opts.cdp_url === 'string' && opts.cdp_url.trim().length > 0
        ? opts.cdp_url.trim()
        : typeof opts.cdp_port === 'number' && Number.isFinite(opts.cdp_port)
          ? `http://127.0.0.1:${opts.cdp_port}`
          : '';
    if (!cdpUrl) {
      throw new Error('connect_over_cdp=true requires cdp_url or cdp_port');
    }
    const browser = (await retry(
      async () => chromium.connectOverCDP(cdpUrl),
      buildRetryOptions()
    )) as PlaywrightBrowser & { contexts: () => PlaywrightContext[] };
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error(`No browser context available via CDP at ${cdpUrl}`);
    }
    if (typeof (context as any).grantPermissions === 'function') {
      await (context as any).grantPermissions(['microphone', 'camera']);
    }
    return {
      browser,
      context,
      cleanup_mode: 'none',
    };
  }

  const userDataDir = resolveChromeUserDataDir(opts.user_data_dir);
  if (userDataDir) {
    const context = (await retry(
      async () =>
        chromium.launchPersistentContext(userDataDir, {
          channel: opts.browser_channel === 'chrome' ? 'chrome' : undefined,
          headless: !headed,
          viewport: { width: 1280, height: 800 },
          args: [
            ...launchArgs,
            ...(opts.profile_directory ? [`--profile-directory=${opts.profile_directory}`] : []),
          ],
        }),
      buildRetryOptions()
    )) as PlaywrightContext;
    if (typeof (context as any).grantPermissions === 'function') {
      await (context as any).grantPermissions(['microphone', 'camera']);
    }
    return { context, cleanup_mode: 'context' };
  }

  const browser = (await retry(
    async () =>
      chromium.launch({
        headless: !headed,
        args: launchArgs,
      }),
    buildRetryOptions()
  )) as PlaywrightBrowser & { newContext: (opts?: any) => Promise<PlaywrightContext> };
  const context = (await retry(
    async () =>
      browser.newContext({
        permissions: ['microphone', 'camera'],
        viewport: { width: 1280, height: 800 },
      }),
    buildRetryOptions()
  )) as PlaywrightContext;
  return { browser, context, cleanup_mode: 'browser' };
}

class BrowserMeetingJoinDriver implements MeetingJoinDriver {
  readonly driver_id = MEETING_BROWSER_DRIVER_ID;
  readonly supported_platforms = ['meet', 'zoom', 'teams', 'auto'] as const;

  constructor(private readonly opts: BrowserDriverOptions = {}) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      // Optional dependency — we don't `require`/`import` it
      // statically so non-bot deployments aren't forced to install.
      await retry(async () => loadPlaywright(), buildRetryOptions());
      return { available: true };
    } catch (err: any) {
      return {
        available: false,
        reason: `Playwright Chromium runtime is unavailable. Run \`pnpm env:bootstrap --manifest meeting-participation-runtime --apply --force\`. (${err?.message ?? err})`,
      };
    }
  }

  async join(target: MeetingTarget, bus: AudioBus): Promise<MeetingSession> {
    const probe = await this.probe();
    if (!probe.available) throw new Error(`[browser-driver] ${probe.reason}`);
    const { chromium } = await loadPlaywright();
    const validatedTarget = validateMeetingTarget(target);
    const platform = validatedTarget.platform;
    const selectors =
      this.opts.selectors_override?.[platform as 'meet' | 'zoom' | 'teams'] ??
      selectorsForPlatform(platform);
    const accountSlug = this.opts.account_slug ?? 'default';
    const microphoneDevice = this.opts.microphone_device;
    const speakerDevice = this.opts.speaker_device;
    const cameraDevice = this.opts.camera_device;
    const stepTimeout = this.opts.step_timeout_ms ?? DEFAULT_TIMEOUT;
    const headed = this.opts.headed ?? false;

    const runtime = await createPlaywrightJoinRuntime(chromium, this.opts);
    const { context } = runtime;

    // Restore cookies if we have any persisted for this account slug.
    const persisted = readCookies(accountSlug);
    if (persisted.length) await context.addCookies(persisted as any[]);

    const page = await retry(async () => context.newPage(), buildRetryOptions());
    const state: MeetingSessionState = {
      session_id: `browser-${Date.now()}`,
      platform,
      status: 'connecting',
    };

    try {
      await retry(
        async () =>
          page.goto(validatedTarget.url, { waitUntil: 'domcontentloaded', timeout: stepTimeout }),
        buildRetryOptions()
      );
      await trySelectors(page, selectors.continue_without_audio_video_button, async (sel) => {
        await page.click(sel, { timeout: stepTimeout });
      });
      await fillMeetingEntryFields(
        page,
        selectors,
        {
          meeting_id: validatedTarget.meeting_id,
          passcode: validatedTarget.passcode,
          display_name: validatedTarget.display_name,
        },
        stepTimeout
      );
      await configureMeetingDevices(
        page,
        selectors,
        {
          microphone: microphoneDevice,
          speaker: speakerDevice,
          camera: cameraDevice,
        },
        stepTimeout
      );
      // Mute mic + camera before joining (the AI controls speech via
      // TTS into the bus, not browser-mic).
      await trySelectors(page, selectors.mute_mic_button, async (sel) => {
        await page.click(sel, { timeout: 2000 });
      });
      await trySelectors(page, selectors.disable_camera_button, async (sel) => {
        await page.click(sel, { timeout: 2000 });
      });

      // Click Join / Ask to join.
      const joinSelector = await waitForAnyVisibleSelector(page, selectors.join_button, {
        timeoutMs: Math.max(stepTimeout, 30_000),
        pollMs: 500,
      });
      const joined = joinSelector
        ? await trySelectors(page, [joinSelector], async (sel) => {
            await page.click(sel, { timeout: stepTimeout });
          })
        : false;
      if (!joined) {
        const bodyText = await page
          .locator('body')
          .innerText()
          .catch(() => '');
        if (/You can't join this video call/i.test(bodyText) || /Sign in/i.test(bodyText)) {
          throw new Error(
            `[browser-driver] Meet rejected this browser session before join. Use a signed-in Chrome profile or seed account_slug='${accountSlug}' with valid Google cookies.`
          );
        }
        throw new Error(`[browser-driver] no join button matched (${platform})`);
      }
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
      if (runtime.cleanup_mode === 'browser' && runtime.browser) {
        await retry(
          async () => runtime.browser?.close().catch(() => undefined),
          buildRetryOptions()
        );
      } else if (runtime.cleanup_mode === 'context') {
        await retry(async () => context.close().catch(() => undefined), buildRetryOptions());
      } else {
        await page.close().catch(() => undefined);
      }
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
      async audioOutput(stream: AsyncIterable<AudioChunk>, signal?: AbortSignal): Promise<void> {
        await bus.writeOutput(abortableAudioChunks(stream, signal));
      },
      async chat(_text: string): Promise<void> {
        // Chat is platform-specific; selectors not yet wired.
      },
      async leave(): Promise<void> {
        leaveSignaled = true;
        await retry(
          async () =>
            trySelectors(page, selectors.leave_button, async (sel) => {
              await page.click(sel, { timeout: 5_000 });
            }),
          buildRetryOptions()
        );
        state.status = 'ended';
        state.left_at = new Date().toISOString();
        if (runtime.cleanup_mode === 'browser' && runtime.browser) {
          await retry(
            async () => runtime.browser?.close().catch(() => undefined),
            buildRetryOptions()
          );
        } else if (runtime.cleanup_mode === 'context') {
          await retry(async () => context.close().catch(() => undefined), buildRetryOptions());
        } else {
          await page.close().catch(() => undefined);
        }
        await retry(async () => bus.close(), buildRetryOptions());
      },
    };
  }
}

export { BrowserMeetingJoinDriver, MEET_SELECTORS, TEAMS_SELECTORS, ZOOM_SELECTORS };
export type { MeetingPreJoinSelectors };

/**
 * Convenience: register the driver with the core registry on import.
 * Pass options via `installBrowserMeetingJoinDriver(...)` or build a
 * standalone driver with `createBrowserMeetingJoinDriver(...)`.
 */
export function installBrowserMeetingJoinDriver(opts: BrowserDriverOptions = {}): void {
  registerMeetingJoinDriver(createBrowserMeetingJoinDriver(opts));
}

/**
 * Create the internal Playwright join backend without registering it.
 * This keeps the browser join driver usable as an explicit backend in
 * coordinators that want to own the registry step themselves.
 */
export function createBrowserMeetingJoinDriver(
  opts: BrowserDriverOptions = {}
): BrowserMeetingJoinDriver {
  return new BrowserMeetingJoinDriver(opts);
}
