import { logger } from '@agent/core/core';
import { nowIso } from '@agent/core/foundation';
import type { Page } from '@playwright/test';
import type { BrowserRuntime, BrowserWatchdog } from './browser-runtime-types.js';

/**
 * Watchdog-style side-effect observers for the browser runtime, adopted from
 * the browser-use session model: ops only declare intent; specialized
 * observers record and contain what the page does between steps (dialogs,
 * downloads, crashes, popups, redirects, tab closes). Every event is bounded
 * and lands in the action trail, so per-step delivery receipts carry the
 * same side-effect evidence the Chrome extension's popup sentinel produces
 * on the extension path.
 */

export const BROWSER_DIALOG_POLICIES = ['accept', 'dismiss'] as const;
export type BrowserDialogPolicy = (typeof BROWSER_DIALOG_POLICIES)[number];

const WATCHDOG_EVENT_LIMIT = 200;
const MESSAGE_LIMIT = 200;

function clip(value: string, limit = MESSAGE_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function pushBounded<T>(events: T[], event: T): T[] {
  events.push(event);
  return events.slice(-WATCHDOG_EVENT_LIMIT);
}

export function createBrowserWatchdog(): BrowserWatchdog {
  return {
    dialog_policy: 'accept',
    dialog_events: [],
    download_events: [],
    crash_events: [],
    popup_events: [],
    navigation_events: [],
    close_events: [],
    crashed_tab_ids: [],
  };
}

export function setBrowserDialogPolicy(runtime: BrowserRuntime, policy: BrowserDialogPolicy): void {
  runtime.watchdog.dialog_policy = policy;
}

export function isBrowserDialogPolicy(value: unknown): value is BrowserDialogPolicy {
  return (
    typeof value === 'string' && (BROWSER_DIALOG_POLICIES as readonly string[]).includes(value)
  );
}

export function isBrowserTabCrashed(runtime: BrowserRuntime, tabId: string): boolean {
  return runtime.watchdog.crashed_tab_ids.includes(tabId);
}

/** Observers are async but never awaited by Playwright; each catches its own
 * errors so a failed side-effect write cannot take down the page handler. */
export function attachWatchdogObservers(runtime: BrowserRuntime, page: Page, tabId: string): void {
  const watchdog = runtime.watchdog;

  page.on('dialog', (dialog) => {
    const disposition = watchdog.dialog_policy === 'dismiss' ? 'dismiss' : 'accept';
    const event = {
      tab_id: tabId,
      type: dialog.type(),
      message: clip(dialog.message()),
      disposition,
      ts: nowIso(),
    };
    const settle = disposition === 'accept' ? dialog.accept() : dialog.dismiss();
    settle
      .then(() => {
        watchdog.dialog_events = pushBounded(watchdog.dialog_events, event);
      })
      .catch((error: unknown) => {
        watchdog.dialog_events = pushBounded(watchdog.dialog_events, {
          ...event,
          disposition: 'failed',
          error: clip(error instanceof Error ? error.message : String(error)),
        });
        logger.warn(`[BROWSER] dialog ${disposition} failed on ${tabId}: ${event.message}`);
      });
  });

  page.on('download', (download) => {
    watchdog.download_events = pushBounded(watchdog.download_events, {
      tab_id: tabId,
      suggested_filename: download.suggestedFilename(),
      url: clip(download.url(), 500),
      ts: nowIso(),
    });
    download
      .path()
      .then((downloadPath) => {
        const last = watchdog.download_events[watchdog.download_events.length - 1];
        if (last && last.tab_id === tabId && downloadPath) last.path = downloadPath;
      })
      .catch(() => {
        /* artifact unavailable; the event already records the attempt */
      });
  });

  page.on('crash', () => {
    if (!watchdog.crashed_tab_ids.includes(tabId)) {
      watchdog.crashed_tab_ids = [...watchdog.crashed_tab_ids, tabId];
    }
    watchdog.crash_events = pushBounded(watchdog.crash_events, { tab_id: tabId, ts: nowIso() });
    logger.warn(`[BROWSER] page crashed on ${tabId}`);
  });

  page.on('popup', (popup) => {
    const popupTabId = runtime.pageIds.get(popup) || '';
    watchdog.popup_events = pushBounded(watchdog.popup_events, {
      tab_id: tabId,
      popup_tab_id: popupTabId,
      opener_url: clip(page.url(), 500),
      ts: nowIso(),
    });
    logger.info(`[BROWSER] popup opened from ${tabId}`);
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    watchdog.navigation_events = pushBounded(watchdog.navigation_events, {
      tab_id: tabId,
      url: clip(frame.url(), 500),
      ts: nowIso(),
    });
  });

  page.on('close', () => {
    watchdog.close_events = pushBounded(watchdog.close_events, {
      tab_id: tabId,
      url: clip(page.url(), 500),
      ts: nowIso(),
    });
    watchdog.crashed_tab_ids = watchdog.crashed_tab_ids.filter((id) => id !== tabId);
    if (runtime.tabs.get(tabId) === page) {
      runtime.tabs.delete(tabId);
      if (runtime.activeTabId === tabId) {
        // Fail closed: never silently retarget the pipeline to another page.
        runtime.activeTabId = '';
      }
    }
  });
}

export function summarizeWatchdog(watchdog: BrowserWatchdog): Record<string, unknown> {
  return {
    dialog_policy: watchdog.dialog_policy,
    dialog_events: watchdog.dialog_events.length,
    download_events: watchdog.download_events.length,
    crash_events: watchdog.crash_events.length,
    crashed_tab_ids: watchdog.crashed_tab_ids,
    popup_events: watchdog.popup_events.length,
    navigation_events: watchdog.navigation_events.length,
    close_events: watchdog.close_events.length,
  };
}

export function collectWatchdogEvents(
  runtime: BrowserRuntime,
  kind: string | undefined,
  limit: number
): Record<string, unknown> {
  const watchdog = runtime.watchdog;
  const take = (events: unknown[]) => events.slice(-limit);
  switch (kind) {
    case 'dialog':
      return { dialog_events: take(watchdog.dialog_events) };
    case 'download':
      return { download_events: take(watchdog.download_events) };
    case 'crash':
      return {
        crash_events: take(watchdog.crash_events),
        crashed_tab_ids: watchdog.crashed_tab_ids,
      };
    case 'popup':
      return { popup_events: take(watchdog.popup_events) };
    case 'navigation':
      return { navigation_events: take(watchdog.navigation_events) };
    case 'close':
      return { close_events: take(watchdog.close_events) };
    default:
      return {
        dialog_policy: watchdog.dialog_policy,
        dialog_events: take(watchdog.dialog_events),
        download_events: take(watchdog.download_events),
        crash_events: take(watchdog.crash_events),
        crashed_tab_ids: watchdog.crashed_tab_ids,
        popup_events: take(watchdog.popup_events),
        navigation_events: take(watchdog.navigation_events),
        close_events: take(watchdog.close_events),
      };
  }
}
