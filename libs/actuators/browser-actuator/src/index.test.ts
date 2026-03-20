import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetBrowserRuntimeLeasesForTest } = await import('./index');
    await resetBrowserRuntimeLeasesForTest();
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

  it('records action trails and exports playwright/adf artifacts', async () => {
    const { handleAction } = await import('./index');
    const outDir = path.join(process.cwd(), 'active/shared/tmp/browser');
    fs.mkdirSync(outDir, { recursive: true });
    const specPath = path.join(outDir, 'browser-test-playwright.spec.ts');
    const adfPath = path.join(outDir, 'browser-test-pipeline.json');
    if (fs.existsSync(specPath)) fs.rmSync(specPath, { force: true });
    if (fs.existsSync(adfPath)) fs.rmSync(adfPath, { force: true });

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } },
        { type: 'apply', op: 'click_ref', params: { ref: '@e1' } },
        { type: 'apply', op: 'fill_ref', params: { ref: '@e1', text: 'hello' } },
        { type: 'capture', op: 'content', params: { selector: 'button:nth-of-type(1)', export_as: 'content' } },
        { type: 'transform', op: 'export_playwright', params: { path: specPath, export_as: 'spec_path', assertions: 'strict' } },
        { type: 'transform', op: 'export_adf', params: { path: adfPath, export_as: 'adf_path' } },
      ],
      options: { headless: true },
    });

    expect(result.context.action_trail).toEqual([
      expect.objectContaining({ op: 'snapshot', kind: 'capture' }),
      expect.objectContaining({ op: 'click_ref', kind: 'apply', ref: '@e1' }),
      expect.objectContaining({ op: 'fill_ref', kind: 'apply', ref: '@e1', text: 'hello' }),
      expect.objectContaining({ op: 'content', kind: 'capture', selector: 'button:nth-of-type(1)' }),
    ]);
    expect(result.context.spec_path).toBe(specPath);
    expect(result.context.adf_path).toBe(adfPath);
    const spec = fs.readFileSync(specPath, 'utf8');
    expect(spec).toContain('await expect(page).toHaveURL("https://example.com");');
    expect(spec).toContain('await expect(page).toHaveTitle("Test Page");');
    expect(spec).toContain('await expect(page.locator("button:nth-of-type(1)")).toBeVisible();');
    expect(spec).toContain('await page.click("button:nth-of-type(1)");');
    expect(spec).toContain('await page.fill("button:nth-of-type(1)", "hello");');
    expect(spec).toContain('await expect(page.locator("button:nth-of-type(1)")).toHaveValue("hello");');
    expect(spec).toContain('await expect(page.locator("button:nth-of-type(1)")).toContainText("content");');
    expect(JSON.parse(fs.readFileSync(adfPath, 'utf8'))).toMatchObject({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'apply', op: 'click_ref', params: { ref: '@e1' } },
        { type: 'apply', op: 'fill_ref', params: { ref: '@e1', text: 'hello' } },
      ],
    });
  });

  it('reuses leased browser sessions within the same process and can close them explicitly', async () => {
    const { handleAction } = await import('./index');

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-lease',
      steps: [{ type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } }],
      options: { headless: true, lease_ms: 60_000 },
    });

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-lease',
      steps: [{ type: 'capture', op: 'tabs', params: { export_as: 'tabs' } }],
      options: { headless: true, lease_ms: 60_000 },
    });

    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1);

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-lease',
      steps: [{ type: 'control', op: 'close_session', params: {} }],
      options: { headless: true, lease_ms: 60_000 },
    });

    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('exports assertion hints in comment-only mode when requested', async () => {
    const { renderPlaywrightSkeleton } = await import('./index');

    const spec = renderPlaywrightSkeleton([
      { kind: 'capture', op: 'snapshot', url: 'https://example.com', title: 'Test Page', ts: new Date().toISOString() },
      { kind: 'apply', op: 'click_ref', selector: 'button:nth-of-type(1)', ref: '@e1', element_name: 'Submit', element_role: 'button', ts: new Date().toISOString() },
    ], { assertions: 'hint' });

    expect(spec).toContain('// assertion hint: await expect(page).toHaveURL("https://example.com");');
    expect(spec).toContain('// assertion hint: await expect(page).toHaveTitle("Test Page");');
    expect(spec).toContain('// assertion hint: await expect(page.locator("button:nth-of-type(1)")).toBeVisible();');
    expect(spec).toContain('await page.click("button:nth-of-type(1)");');
  });
});
