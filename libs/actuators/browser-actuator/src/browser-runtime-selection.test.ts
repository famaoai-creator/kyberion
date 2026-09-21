import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { setSeamSelectionRule } from '@agent/core/seam-selection-rules';

const record = vi.fn();
vi.mock('@agent/core/audit-chain', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));

await import('./browser-automation-runtime-playwright.js');
await import('./browser-automation-runtime-lightpanda.js');
const { preflightAutomationRuntime, selectBrowserAutomationRuntime } =
  await import('./browser-runtime-capabilities.js');

const rulesDir = pathResolver.sharedTmp('browser-runtime-selection-test');
const rulesFile = path.join(rulesDir, 'rules.json');

const READ_ONLY = [
  { type: 'capture', op: 'goto', params: { url: 'https://example.com/' } },
  { type: 'capture', op: 'distill_dom', params: {} },
];
const WITH_SCREENSHOT = [...READ_ONLY, { type: 'capture', op: 'screenshot', params: {} }];

describe('purpose-driven browser runtime selection', () => {
  beforeEach(() => {
    record.mockClear();
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
    safeRmSync(rulesDir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(rulesDir, { recursive: true, force: true });
  });

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

  it('applies an operator rule even without a purpose, using decisionKey "default"', () => {
    expect(selectBrowserAutomationRuntime(READ_ONLY, {})).toBeUndefined();

    setSeamSelectionRule({
      rule_id: 'always-lightpanda',
      seam: 'browser-automation-runtime',
      when: {},
      prefer: ['lightpanda'],
      set_by: 'user:owner',
    });
    // Rule changes are audited too; assertions below are about selection.
    record.mockClear();

    expect(selectBrowserAutomationRuntime(READ_ONLY, {})).toBe('lightpanda');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'browser-automation-runtime/lightpanda',
        metadata: expect.objectContaining({
          decision_key: 'default',
          rule_id: 'always-lightpanda',
        }),
      })
    );
  });

  it('does not apply an operator rule with an explicit browser_runtime', () => {
    setSeamSelectionRule({
      rule_id: 'always-lightpanda-2',
      seam: 'browser-automation-runtime',
      when: {},
      prefer: ['lightpanda'],
      set_by: 'user:owner',
    });
    // Rule changes are audited too; assertions below are about selection.
    record.mockClear();

    expect(
      selectBrowserAutomationRuntime(READ_ONLY, { browser_runtime: 'playwright-chromium' })
    ).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});
