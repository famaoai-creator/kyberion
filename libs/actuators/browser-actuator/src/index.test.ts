import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const goto = vi.fn(async () => undefined);
  const click = vi.fn(async () => undefined);
  const fill = vi.fn(async () => undefined);
  const press = vi.fn(async () => undefined);
  const waitForSelector = vi.fn(async () => undefined);
  const waitForTimeout = vi.fn(async () => undefined);
  const screenshot = vi.fn(async () => undefined);
  const innerText = vi.fn(async () => 'content');
  const content = vi.fn(async () => '<html></html>');
  const evaluate = vi.fn(async () => [
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
  ]);
  const title = vi.fn(async () => 'Test Page');
  const url = vi.fn(() => 'https://example.com');
  const on = vi.fn();
  const tracingStart = vi.fn(async () => undefined);
  const tracingStop = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);

  const page = {
    goto,
    click,
    fill,
    press,
    waitForSelector,
    waitForTimeout,
    screenshot,
    innerText,
    content,
    evaluate,
    title,
    url,
    on,
  };

  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close,
    tracing: {
      start: tracingStart,
      stop: tracingStop,
    },
  };

  const launchPersistentContext = vi.fn(async () => context);

  return {
    page,
    context,
    launchPersistentContext,
    goto,
    click,
    fill,
    press,
    waitForSelector,
    waitForTimeout,
    evaluate,
    title,
    url,
    close,
    tracingStart,
    tracingStop,
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
    expect(mocks.click).toHaveBeenCalledWith('button:nth-of-type(1)', { timeout: 5000 });
    expect(mocks.fill).toHaveBeenCalledWith('button:nth-of-type(1)', 'hello', { timeout: 5000 });
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
});
