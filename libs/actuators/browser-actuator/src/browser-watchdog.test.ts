import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import {
  attachWatchdogObservers,
  collectWatchdogEvents,
  createBrowserWatchdog,
  isBrowserDialogPolicy,
  setBrowserDialogPolicy,
  summarizeWatchdog,
} from './browser-watchdog.js';
import type { BrowserRuntime } from './browser-runtime-types.js';
import {
  BROWSER_APPLY_OP_HANDLERS,
  BROWSER_CAPTURE_OP_HANDLERS,
} from './browser-pipeline-op-handlers.js';
import { browserOperationRequiresAdmission } from './browser-external-governance.js';

type Handler = (...args: never[]) => void;

function fakePage(): {
  page: Page;
  mainFrame: object;
  handlers: Map<string, Handler[]>;
  emit: (n: string, ...a: unknown[]) => void;
} {
  const handlers = new Map<string, Handler[]>();
  const mainFrame = { url: () => 'https://example.test/page' };
  const page = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return page;
    },
    mainFrame: () => mainFrame,
    url: () => 'https://example.test/page',
  } as unknown as Page;
  return {
    page,
    mainFrame,
    handlers,
    emit: (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...(args as never[]));
    },
  };
}

function fakeRuntime(): BrowserRuntime {
  return {
    context: {},
    tabs: new Map(),
    pageIds: new WeakMap(),
    cdpSessions: new WeakMap(),
    activeTabId: '',
    watchdog: createBrowserWatchdog(),
    consoleEvents: [],
    networkEvents: [],
  } as unknown as BrowserRuntime;
}

function fakeDialog(type: string) {
  return {
    type: () => type,
    message: () => `${type} message`,
    accept: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('browser watchdog', () => {
  it('accepts dialogs by default and records them with disposition', async () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    const dialog = fakeDialog('confirm');
    emit('dialog', dialog);
    await flush();
    expect(dialog.accept).toHaveBeenCalledOnce();
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(runtime.watchdog.dialog_events).toHaveLength(1);
    expect(runtime.watchdog.dialog_events[0]).toMatchObject({
      tab_id: 'tab-1',
      type: 'confirm',
      disposition: 'accept',
    });
  });

  it('dismisses dialogs under the dismiss policy', async () => {
    const runtime = fakeRuntime();
    setBrowserDialogPolicy(runtime, 'dismiss');
    const { page, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    const dialog = fakeDialog('alert');
    emit('dialog', dialog);
    await flush();
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(runtime.watchdog.dialog_events[0].disposition).toBe('dismiss');
  });

  it('records a failed dialog settlement instead of throwing', async () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    const dialog = {
      type: () => 'confirm',
      message: () => 'x',
      accept: vi.fn(async () => {
        throw new Error('target closed');
      }),
      dismiss: vi.fn(),
    };
    emit('dialog', dialog);
    await flush();
    expect(runtime.watchdog.dialog_events[0].disposition).toBe('failed');
    expect(runtime.watchdog.dialog_events[0].error).toContain('target closed');
  });

  it('records downloads and backfills the artifact path when it resolves', async () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    emit('download', {
      suggestedFilename: () => 'report.csv',
      url: () => 'https://example.test/dl',
      path: async () => '/tmp/dl-123',
    });
    await flush();
    expect(runtime.watchdog.download_events).toHaveLength(1);
    expect(runtime.watchdog.download_events[0]).toMatchObject({
      suggested_filename: 'report.csv',
      path: '/tmp/dl-123',
    });
  });

  it('marks crashed tabs and clears them when the tab closes', () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    runtime.tabs.set('tab-1', page);
    runtime.activeTabId = 'tab-1';
    attachWatchdogObservers(runtime, page, 'tab-1');
    emit('crash');
    expect(runtime.watchdog.crashed_tab_ids).toEqual(['tab-1']);
    emit('close');
    expect(runtime.watchdog.crashed_tab_ids).toEqual([]);
    expect(runtime.tabs.has('tab-1')).toBe(false);
    expect(runtime.activeTabId).toBe('');
  });

  it('records main-frame navigations and ignores subframe navigations', () => {
    const runtime = fakeRuntime();
    const { page, mainFrame, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    emit('framenavigated', mainFrame);
    emit('framenavigated', { url: () => 'https://subframe.test/x' });
    expect(runtime.watchdog.navigation_events).toHaveLength(1);
    expect(runtime.watchdog.navigation_events[0].url).toBe('https://example.test/page');
  });

  it('popups carry the opener tab and resolved popup tab id', () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    const popup = {} as Page;
    runtime.pageIds.set(popup, 'tab-2');
    attachWatchdogObservers(runtime, page, 'tab-1');
    emit('popup', popup);
    expect(runtime.watchdog.popup_events[0]).toMatchObject({
      tab_id: 'tab-1',
      popup_tab_id: 'tab-2',
    });
  });

  it('bounds every event list and filters by kind', async () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    for (let i = 0; i < 210; i += 1) {
      emit('popup', {} as Page);
    }
    expect(runtime.watchdog.popup_events).toHaveLength(200);
    const all = collectWatchdogEvents(runtime, undefined, 50);
    expect(Object.keys(all)).toContain('navigation_events');
    const onlyDialog = collectWatchdogEvents(runtime, 'dialog', 5);
    expect(Object.keys(onlyDialog)).toEqual(['dialog_events']);
    const crashes = collectWatchdogEvents(runtime, 'crash', 5);
    expect(crashes).toHaveProperty('crashed_tab_ids');
  });

  it('summarizes counts and policy for session_health', () => {
    const runtime = fakeRuntime();
    setBrowserDialogPolicy(runtime, 'dismiss');
    const summary = summarizeWatchdog(runtime.watchdog);
    expect(summary).toMatchObject({ dialog_policy: 'dismiss', crashed_tab_ids: [] });
  });

  it('validates dialog policy values', () => {
    expect(isBrowserDialogPolicy('accept')).toBe(true);
    expect(isBrowserDialogPolicy('dismiss')).toBe(true);
    expect(isBrowserDialogPolicy('block')).toBe(false);
    expect(isBrowserDialogPolicy(undefined)).toBe(false);
  });
});

describe('watchdog op dispatch surface', () => {
  function handlerInput(runtime: BrowserRuntime, page: Page, op: string, params: object) {
    return {
      op,
      params,
      runtime,
      page,
      ctx: {},
      resolve: (value: unknown) => value,
      buildRetryOptions: () => ({}),
      fillWithFallback: vi.fn(),
    } as never;
  }

  it('watchdog_events is an ungated read that lands in the action trail', async () => {
    const runtime = fakeRuntime();
    const { page, emit } = fakePage();
    attachWatchdogObservers(runtime, page, 'tab-1');
    runtime.activeTabId = 'tab-1';
    emit('framenavigated', page.mainFrame());
    const result = (await BROWSER_CAPTURE_OP_HANDLERS.watchdog_events(
      handlerInput(runtime, page, 'watchdog_events', { kind: 'navigation' })
    )) as Record<string, unknown>;
    expect((result.watchdog_events as Record<string, unknown[]>).navigation_events).toHaveLength(1);
    const trail = result.action_trail as Array<Record<string, unknown>>;
    expect(trail[trail.length - 1]).toMatchObject({ kind: 'capture', op: 'watchdog_events' });
  });

  it('dialog_policy requires admission and validates the policy value', async () => {
    const runtime = fakeRuntime();
    const { page } = fakePage();
    runtime.activeTabId = 'tab-1';
    // Governed apply path: without approval authority it must not reach the
    // handler at all — the dialog policy can never change silently.
    await expect(
      BROWSER_APPLY_OP_HANDLERS.dialog_policy({
        op: 'dialog_policy',
        params: { policy: 'dismiss' },
        runtime,
        page,
        ctx: {},
        resolve: (value: unknown) => value,
        buildRetryOptions: () => ({}),
        fillWithFallback: vi.fn(),
      } as never)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(runtime.watchdog.dialog_policy).toBe('accept');
  });

  it('classifies admission parity: cdp gates like evaluate, reads stay open', () => {
    expect(browserOperationRequiresAdmission('capture', 'cdp')).toBe(true);
    expect(browserOperationRequiresAdmission('capture', 'evaluate')).toBe(true);
    expect(browserOperationRequiresAdmission('capture', 'watchdog_events')).toBe(false);
    expect(browserOperationRequiresAdmission('apply', 'dialog_policy')).toBe(true);
  });
});
