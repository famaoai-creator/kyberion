import { describe, expect, it } from 'vitest';
import { FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES } from '@agent/core/browser-automation-runtime-bridge';
import {
  formatBrowserRuntimePreflightError,
  preflightBrowserRuntimePipeline,
  scopeBrowserSessionId,
} from './browser-runtime-capabilities.js';
import { LIGHTPANDA_CAPABILITIES } from './browser-automation-runtime-lightpanda.js';

const READ_ONLY_STEPS = [
  { type: 'capture', op: 'goto', params: { url: 'https://example.com/' } },
  { type: 'apply', op: 'fill', params: { selector: '#q', text: 'x' } },
  { type: 'capture', op: 'distill_dom', params: {} },
];

describe('browser runtime capability preflight', () => {
  it('passes everything for a full-capability runtime', () => {
    const result = preflightBrowserRuntimePipeline(
      [...READ_ONLY_STEPS, { type: 'control', op: 'open_tab', params: {} }],
      { record_video: true, connect_over_cdp: true },
      FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES
    );
    expect(result).toEqual({ blocking: [], degraded: [] });
  });

  it('accepts read-mostly pipelines on lightpanda', () => {
    const result = preflightBrowserRuntimePipeline(READ_ONLY_STEPS, {}, LIGHTPANDA_CAPABILITIES);
    expect(result.blocking).toEqual([]);
  });

  it('blocks unsupported ops, including ones nested in control flow', () => {
    const steps = [
      ...READ_ONLY_STEPS,
      {
        type: 'control',
        op: 'if',
        params: {
          condition: { from: 'x', operator: 'exists' },
          then: [{ type: 'capture', op: 'screenshot', params: {} }],
          else: [{ type: 'control', op: 'setup_passkey_authenticator', params: {} }],
        },
      },
      { type: 'control', op: 'select_tab', params: { tab_id: 'tab-2' } },
    ];
    const { blocking } = preflightBrowserRuntimePipeline(steps, {}, LIGHTPANDA_CAPABILITIES);
    expect(blocking).toEqual([
      { op: 'screenshot', capability: 'pixel_screenshots' },
      { op: 'select_tab', capability: 'multi_tab' },
      { op: 'setup_passkey_authenticator', capability: 'webauthn' },
    ]);
    expect(formatBrowserRuntimePreflightError('lightpanda', blocking)).toMatch(
      /BROWSER_RUNTIME_UNSUPPORTED.*'lightpanda'.*op 'screenshot'/
    );
  });

  it('blocks explicit attach / chrome-profile options and degrades host video', () => {
    const { blocking, degraded } = preflightBrowserRuntimePipeline(
      READ_ONLY_STEPS,
      {
        connect_over_cdp: true,
        cdp_port: 9222,
        browser_channel: 'chrome',
        profile_directory: 'Default',
        record_video: true,
        record_trace: true,
      },
      LIGHTPANDA_CAPABILITIES
    );
    expect(blocking.map((issue) => issue.option)).toEqual([
      'connect_over_cdp',
      'cdp_port',
      'browser_channel',
      'profile_directory',
    ]);
    expect(degraded).toEqual([{ option: 'record_video', capability: 'video_recording' }]);
  });

  it('namespaces session ids for non-default runtimes only, idempotently', () => {
    const DEFAULT = 'playwright-chromium';
    expect(scopeBrowserSessionId('checkout', DEFAULT, DEFAULT)).toBe('checkout');
    expect(scopeBrowserSessionId('checkout', 'lightpanda', DEFAULT)).toBe('lightpanda--checkout');
    expect(scopeBrowserSessionId('lightpanda--checkout', 'lightpanda', DEFAULT)).toBe(
      'lightpanda--checkout'
    );
    expect(scopeBrowserSessionId('', 'lightpanda', DEFAULT)).toBe('lightpanda--default');
  });
});
