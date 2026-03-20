import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const pageHandlers = new Map<string, Record<string, Function>>();
  function createPage(label: string, initialUrl = 'https://example.com', initialTitle = 'Test Page') {
    const handlers: Record<string, Function> = {};
    pageHandlers.set(label, handlers);
    let currentUrl = initialUrl;
    let currentTitle = initialTitle;
    return {
      goto: vi.fn(async (url: string) => { currentUrl = url; }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => undefined),
      innerText: vi.fn(async () => 'content'),
      content: vi.fn(async () => '<html></html>'),
      evaluate: vi.fn(async () => [
        {
          ref: '@e1',
          tag: 'button',
          role: 'button',
          text: 'Submit',
          name: 'Submit',
          type: null,
          placeholder: null,
          href: null,
          value: null,
          visible: true,
          editable: false,
          selector: 'button:nth-of-type(1)',
        },
      ]),
      title: vi.fn(async () => currentTitle),
      url: vi.fn(() => currentUrl),
      on: vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      __setTitle: (next: string) => { currentTitle = next; },
      __handlers: handlers,
    };
  }

  const page = createPage('tab-1');
  const page2 = createPage('tab-2', 'https://example.org', 'Second Tab');
  const tracingStart = vi.fn(async () => undefined);
  const tracingStop = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);

  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page2),
    close,
    tracing: {
      start: tracingStart,
      stop: tracingStop,
    },
  };

  const launchPersistentContext = vi.fn(async () => context);

  return {
    page,
    page2,
    context,
    launchPersistentContext,
    close,
    tracingStart,
    tracingStop,
    pageHandlers,
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: mocks.launchPersistentContext,
  },
}));

describe('browser-actuator v3 contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures a snapshot and reuses ref selectors for ref-based actions', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } },
        { type: 'apply', op: 'click_ref', params: { ref: '@e1' } },
        { type: 'apply', op: 'fill_ref', params: { ref: '@e1', text: 'hello' } },
      ],
      options: { headless: true },
    });

    expect(mocks.launchPersistentContext).toHaveBeenCalled();
    expect(mocks.page.click).toHaveBeenCalledWith('button:nth-of-type(1)', { timeout: 5000 });
    expect(mocks.page.fill).toHaveBeenCalledWith('button:nth-of-type(1)', 'hello', { timeout: 5000 });
    expect(result.context.snapshot).toMatchObject({
      session_id: 'browser-test',
      title: 'Test Page',
      url: 'https://example.com',
      element_count: 1,
    });
    expect(result.context.ref_map).toEqual({
      '@e1': 'button:nth-of-type(1)',
    });
  });

  it('fails fast when a ref action is used before snapshot capture', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [{ type: 'apply', op: 'click_ref', params: { ref: '@missing' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({
      op: 'click_ref',
      status: 'failed',
    });
    expect(String(result.results[0].error)).toContain('Unknown browser ref');
  });

  it('tracks tabs and exports console/network observations', async () => {
    const { handleAction } = await import('./index');

    mocks.page2.goto.mockImplementationOnce(async (url: string) => {
      const handlers = mocks.pageHandlers.get('tab-2') || {};
      handlers.console?.({ type: () => 'log', text: () => 'hello from tab 2' });
      handlers.request?.({ method: () => 'GET', url: () => `${url}/api`, resourceType: () => 'fetch' });
    });

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'control', op: 'open_tab', params: { url: 'https://example.org', tab_id: 'research' } },
        { type: 'control', op: 'select_tab', params: { tab_id: 'research' } },
        { type: 'capture', op: 'tabs', params: { export_as: 'tabs' } },
        { type: 'capture', op: 'console', params: { export_as: 'console' } },
        { type: 'capture', op: 'network', params: { export_as: 'network' } },
      ],
      options: { headless: true },
    });

    expect(result.context.tabs).toEqual([
      expect.objectContaining({ tab_id: 'tab-1', active: false }),
      expect.objectContaining({ tab_id: 'research', active: true }),
    ]);
    expect(result.context.console).toEqual([
      expect.objectContaining({ tab_id: 'research', text: 'hello from tab 2' }),
    ]);
    expect(result.context.network).toEqual([
      expect.objectContaining({ tab_id: 'research', url: 'https://example.org/api' }),
    ]);
  });
});
