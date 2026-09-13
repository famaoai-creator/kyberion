import { logger } from '@agent/core/core';
import { nowIso } from '@agent/core/foundation';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import type { BrowserRuntime } from './browser-runtime-types.js';

export function createBrowserRuntime(
  context: BrowserContext,
  navigationPolicy?: BrowserRuntime['navigationPolicy']
): BrowserRuntime {
  const tabs = new Map<string, Page>();
  const pageIds = new WeakMap<Page, string>();
  const cdpSessions = new WeakMap<Page, CDPSession>();
  const runtime: BrowserRuntime = {
    context,
    tabs,
    pageIds,
    cdpSessions,
    activeTabId: '',
    consoleEvents: [],
    networkEvents: [],
    navigationPolicy,
  };
  context.pages().forEach((page, index) => {
    registerBrowserPage(runtime, page, `tab-${index + 1}`);
  });
  context.on('page', (page) => {
    const tabId = `tab-${runtime.tabs.size + 1}`;
    registerBrowserPage(runtime, page, tabId);
  });
  return runtime;
}

export function registerBrowserPage(runtime: BrowserRuntime, page: Page, tabId: string): void {
  runtime.tabs.set(tabId, page);
  runtime.pageIds.set(page, tabId);
  if (!runtime.activeTabId) runtime.activeTabId = tabId;
  attachPageObservers(runtime, page);
}

export function attachPageObservers(runtime: BrowserRuntime, page: Page): void {
  const tabId = runtime.pageIds.get(page) || `tab-${runtime.tabs.size}`;
  page.on('dialog', async (dialog) => {
    logger.info(
      `[BROWSER] Dialog intercepted: ${dialog.type()} - "${dialog.message().substring(0, 100)}"`
    );
    await dialog.accept();
  });
  page.on('console', (msg) => {
    runtime.consoleEvents.push({
      tab_id: tabId,
      type: msg.type(),
      text: msg.text(),
      ts: nowIso(),
    });
    runtime.consoleEvents = runtime.consoleEvents.slice(-200);
  });
  page.on('request', (request) => {
    runtime.networkEvents.push({
      tab_id: tabId,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      ts: nowIso(),
    });
    runtime.networkEvents = runtime.networkEvents.slice(-200);
  });
}
