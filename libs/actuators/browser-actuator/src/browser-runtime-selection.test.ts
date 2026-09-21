import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
vi.mock('@agent/core/audit-chain', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));

await import('./browser-automation-runtime-playwright.js');
await import('./browser-automation-runtime-lightpanda.js');
const { preflightAutomationRuntime, selectBrowserAutomationRuntime } =
  await import('./browser-runtime-capabilities.js');

const READ_ONLY = [
  { type: 'capture', op: 'goto', params: { url: 'https://example.com/' } },
  { type: 'capture', op: 'distill_dom', params: {} },
];
const WITH_SCREENSHOT = [...READ_ONLY, { type: 'capture', op: 'screenshot', params: {} }];

describe('purpose-driven browser runtime selection', () => {
  beforeEach(() => {
    record.mockClear();
    vi.stubEnv('MISSION_ID', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does nothing without a purpose or with an explicit runtime', () => {
    expect(selectBrowserAutomationRuntime(READ_ONLY, {})).toBeUndefined();
    expect(
      selectBrowserAutomationRuntime(READ_ONLY, {
        browser_runtime: 'playwright-chromium',
        runtime_purpose: 'throughput',
      })
    ).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('picks lightpanda for a read-only throughput pipeline and scopes the session', () => {
    const result = preflightAutomationRuntime(READ_ONLY, 'crawl', {
      runtime_purpose: 'throughput',
    });
    expect(result.options.browser_runtime).toBe('lightpanda');
    expect(result.sessionId).toBe('lightpanda--crawl');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'browser-automation-runtime/lightpanda' })
    );
  });

  it('falls back to chromium when the pipeline needs what lightpanda lacks', () => {
    const result = preflightAutomationRuntime(WITH_SCREENSHOT, 'crawl', {
      browser_runtime: 'auto',
      runtime_purpose: 'throughput',
    });
    expect(result.options.browser_runtime).toBe('playwright-chromium');
    expect(result.sessionId).toBe('crawl');
    expect(record.mock.calls[0]![0].metadata.excluded).toEqual([
      { id: 'lightpanda', unmet: ['screenshot (pixel_screenshots)'] },
    ]);
  });

  it('keeps chromium for evidence and rejects unknown purposes', () => {
    expect(selectBrowserAutomationRuntime(READ_ONLY, { runtime_purpose: 'evidence' })).toBe(
      'playwright-chromium'
    );
    expect(() => selectBrowserAutomationRuntime(READ_ONLY, { runtime_purpose: 'cheap' })).toThrow(
      /BROWSER_RUNTIME_SELECTION.*unknown purpose 'cheap'/
    );
  });
});
