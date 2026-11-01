import { describe, expect, it, vi } from 'vitest';
import {
  assertCdpMethodAllowed,
  BrowserCdpError,
  executeBrowserCdp,
  parseCdpMethodName,
  resolveCdpTimeoutMs,
} from './browser-cdp-op.js';
import type { BrowserRuntime } from './browser-runtime-types.js';
import { BROWSER_CAPTURE_OP_HANDLERS } from './browser-pipeline-op-handlers.js';
import type { Page } from '@playwright/test';

function runtimeWithCdp(send: (method: string, params?: unknown) => Promise<unknown>): {
  runtime: BrowserRuntime;
  page: Page;
} {
  const page = { url: () => 'https://example.test/page' } as unknown as Page;
  const cdpSessions = new WeakMap();
  const session = {
    send: (method: string, params?: unknown) => send(method, params),
    on: () => session,
  };
  const runtime = {
    cdpSessions,
    activeTabId: 'tab-1',
    tabs: new Map([['tab-1', page]]),
    context: {
      newCDPSession: vi.fn(async (p: Page) => {
        cdpSessions.set(p, session);
        return session;
      }),
    },
  } as unknown as BrowserRuntime;
  return { runtime, page };
}

describe('cdp op method boundary', () => {
  it('parses Domain.command names and rejects malformed input', () => {
    expect(parseCdpMethodName('DOMSnapshot.captureSnapshot')).toEqual({
      domain: 'DOMSnapshot',
      command: 'captureSnapshot',
    });
    for (const bad of ['', 'foo', 'DOM.', '.getDocument', 42, undefined, null]) {
      expect(() => parseCdpMethodName(bad)).toThrowError(BrowserCdpError);
    }
  });

  it('allows page-scoped domains and refuses out-of-scope domains', () => {
    for (const method of [
      'DOM.getDocument',
      'DOMSnapshot.captureSnapshot',
      'Accessibility.getFullAXTree',
      'Page.navigate',
      'Page.captureScreenshot',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'CSS.getComputedStyleForNode',
    ]) {
      expect(() => assertCdpMethodAllowed(method)).not.toThrow();
    }
    for (const method of [
      'Target.attachToTarget',
      'Target.createTarget',
      'Browser.close',
      'Debugger.enable',
      'Security.setIgnoreCertificateErrors',
      'Storage.setCookies',
      'Network.setExtraHTTPHeaders',
      'Network.enable',
      'Fetch.enable',
      'Emulation.setDeviceMetricsOverride',
      'Profiler.start',
      'IO.read',
    ]) {
      const error = catchError(() => assertCdpMethodAllowed(method));
      expect(error).toBeInstanceOf(BrowserCdpError);
      expect((error as BrowserCdpError).code).toBe('CDP_DOMAIN_DENIED');
    }
  });

  it('refuses allowed-domain methods that widen the boundary', () => {
    for (const method of [
      'Page.setBypassCSP',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.addBinding',
      'Page.setInterceptFileChooserDialog',
    ]) {
      const error = catchError(() => assertCdpMethodAllowed(method));
      expect((error as BrowserCdpError).code).toBe('CDP_METHOD_DENIED');
    }
  });

  it('clamps the timeout to the documented bounds', () => {
    expect(resolveCdpTimeoutMs(undefined)).toBe(10_000);
    expect(resolveCdpTimeoutMs(500)).toBe(500);
    expect(resolveCdpTimeoutMs(999_999)).toBe(60_000);
    expect(resolveCdpTimeoutMs(-5)).toBe(10_000);
    expect(resolveCdpTimeoutMs('abc')).toBe(10_000);
  });
});

describe('executeBrowserCdp', () => {
  it('rejects before touching the session for denied methods', async () => {
    const send = vi.fn(async () => ({}));
    const { runtime, page } = runtimeWithCdp(send);
    await expect(
      executeBrowserCdp(runtime, page, 'Target.attachToTarget', {}, 1000)
    ).rejects.toMatchObject({ code: 'CDP_DOMAIN_DENIED' });
    expect(send).not.toHaveBeenCalled();
    await expect(executeBrowserCdp(runtime, page, '', {}, 1000)).rejects.toMatchObject({
      code: 'CDP_DOMAIN_DENIED',
    });
  });

  it('sends allowed methods and returns the raw result', async () => {
    const payload = { documents: [{ nodeId: 1 }] };
    const send = vi.fn(async () => payload);
    const { runtime, page } = runtimeWithCdp(send);
    const result = await executeBrowserCdp(
      runtime,
      page,
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
      5000
    );
    expect(result).toBe(payload);
    expect(send).toHaveBeenCalledWith('DOMSnapshot.captureSnapshot', { computedStyles: [] });
  });

  it('reuses the cached CDP session per page', async () => {
    const send = vi.fn(async () => ({}));
    const { runtime, page } = runtimeWithCdp(send);
    await executeBrowserCdp(runtime, page, 'Page.getLayoutMetrics', undefined, 1000);
    await executeBrowserCdp(runtime, page, 'Page.getLayoutMetrics', undefined, 1000);
    expect(runtime.context.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging call instead of waiting forever', async () => {
    const send = vi.fn(() => new Promise<unknown>(() => {}));
    const { runtime, page } = runtimeWithCdp(send);
    await expect(executeBrowserCdp(runtime, page, 'DOM.getDocument', {}, 25)).rejects.toMatchObject(
      { code: 'CDP_TIMEOUT' }
    );
  });

  it('wraps transport failures as CDP_CALL_FAILED', async () => {
    const send = vi.fn(async () => {
      throw new Error('Session closed');
    });
    const { runtime, page } = runtimeWithCdp(send);
    await expect(
      executeBrowserCdp(runtime, page, 'DOM.getDocument', {}, 1000)
    ).rejects.toMatchObject({ code: 'CDP_CALL_FAILED' });
  });
});

describe('cdp op dispatch surface', () => {
  it('the governed cdp op requires admission before touching the session', async () => {
    const send = vi.fn(async () => ({}));
    const { runtime, page } = runtimeWithCdp(send);
    await expect(
      BROWSER_CAPTURE_OP_HANDLERS.cdp({
        op: 'cdp',
        params: { method: 'DOM.getDocument' },
        runtime,
        page,
        ctx: {},
        resolve: (value: unknown) => value,
        buildRetryOptions: () => ({}),
        fillWithFallback: vi.fn(),
      } as never)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(send).not.toHaveBeenCalled();
  });
});

function catchError(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
