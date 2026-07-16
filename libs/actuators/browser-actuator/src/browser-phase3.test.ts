import { describe, expect, it } from 'vitest';
import { getOpInputContract, safeReadFile, safeRmSync, validateOpInput } from '@agent/core';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';

describe('browser-actuator phase 1-3 contracts', () => {
  it('blocks private navigation targets by default while allowing data URLs', () => {
    expect(() => browserRuntimeHelpers.assertNavigationAllowed('http://127.0.0.1:8080')).toThrow(
      'BROWSER_NAVIGATION_BLOCKED'
    );
    expect(() => browserRuntimeHelpers.assertNavigationAllowed('http://10.0.0.2/internal')).toThrow(
      'BROWSER_NAVIGATION_BLOCKED'
    );
    expect(() =>
      browserRuntimeHelpers.assertNavigationAllowed('http://192.0.0.1/internal')
    ).toThrow('BROWSER_NAVIGATION_BLOCKED');
    expect(() =>
      browserRuntimeHelpers.assertNavigationAllowed('http://[::ffff:127.0.0.1]/internal')
    ).toThrow('BROWSER_NAVIGATION_BLOCKED');
    expect(() => browserRuntimeHelpers.assertNavigationAllowed('data:text/html,ok')).not.toThrow();
    expect(() =>
      browserRuntimeHelpers.assertNavigationAllowed('https://example.com', {
        allowed_origins: ['https://allowed.example'],
      })
    ).toThrow('BROWSER_NAVIGATION_BLOCKED');
  });

  it('keeps secret values out of action trails', () => {
    const result = browserRuntimeHelpers.recordBrowserAction(
      { session_id: 'phase3-test', action_trail: [] },
      {
        kind: 'apply',
        op: 'fill_secret_ref',
        ref: '@e1',
        selector: 'input[type=password]',
        secret_ref: 'GITHUB_TOKEN',
        classification: 'secret_ref',
      }
    );
    expect(result.action_trail[0]).toMatchObject({
      op: 'fill_secret_ref',
      redacted: true,
      classification: 'secret_ref',
      secret_ref: 'GITHUB_TOKEN',
    });
    expect(JSON.stringify(result.action_trail)).not.toContain('actual-secret-value');
  });

  it('preserves secret_ref semantics when exporting recorded ref actions', () => {
    const action = {
      kind: 'apply' as const,
      op: 'fill_ref',
      ref: '@e1',
      selector: 'input[name="token"]',
      secret_ref: 'GITHUB_TOKEN',
      classification: 'secret_ref' as const,
      ts: new Date().toISOString(),
    };
    const playwright = browserRuntimeHelpers.renderPlaywrightSkeleton([action]);
    expect(playwright).toContain('process.env["GITHUB_TOKEN"]');
    expect(playwright).not.toContain('actual-secret-value');

    const adf = browserRuntimeHelpers.renderBrowserAdf([action], 'phase3-test');
    expect(adf.steps).toContainEqual({
      type: 'apply',
      op: 'fill_secret_ref',
      params: { ref: '@e1', secret_ref: 'GITHUB_TOKEN' },
    });
  });

  it('exposes canonical contracts for ref extraction, scrolling, health, and evidence', () => {
    for (const op of [
      'extract_text_ref',
      'scroll_ref',
      'scroll',
      'session_health',
      'action_trail',
      'fill_secret_ref',
      'export_failure_bundle',
    ]) {
      expect(getOpInputContract('browser', op), op).not.toBeNull();
    }
    expect(validateOpInput('browser', 'fill_secret_ref', { ref: '@e1' }).valid).toBe(false);
    expect(
      validateOpInput('browser', 'fill_secret_ref', { ref: '@e1', secret_ref: 'TOKEN' }).valid
    ).toBe(true);
  });

  it('keeps semantic snapshot state and failure evidence durable', async () => {
    const page = {
      evaluate: async () => ({
        viewport: { width: 1280, height: 720, scale: 2 },
        ready_state: 'complete',
        elements: [
          {
            ref: '@e1',
            tag: 'input',
            role: 'textbox',
            text: '',
            name: 'Token',
            type: 'password',
            placeholder: null,
            href: null,
            value: '<redacted>',
            value_redacted: true,
            visible: true,
            editable: true,
            focused: true,
            selector: 'input[name="token"]',
          },
        ],
      }),
      url: () => 'https://example.com/login',
      title: async () => 'Login',
    } as unknown as Parameters<typeof browserRuntimeHelpers.buildSnapshot>[0];
    const snapshot = await browserRuntimeHelpers.buildSnapshot(page, {
      sessionId: 'phase3-test',
      tabId: 'tab-1',
      maxElements: 20,
    });
    expect(snapshot.viewport).toEqual({ width: 1280, height: 720, scale: 2 });
    expect(snapshot.focused_ref).toBe('@e1');
    expect(snapshot.ready_state).toBe('complete');
    expect(snapshot.elements[0].value_redacted).toBe(true);

    const bundlePath = browserRuntimeHelpers.saveFailureBundle('phase3-test', {
      schema_version: 'browser-failure-bundle.v1',
      snapshot,
      screenshot: 'active/shared/tmp/browser/phase3-test.png',
      trace_path: 'active/shared/tmp/browser/phase3-test.zip',
      console_events: [{ type: 'error' }],
      network_events: [{ url: 'https://example.com/api' }],
      action_trail: [{ op: 'fill_secret_ref', redacted: true }],
    });
    try {
      const bundle = JSON.parse(safeReadFile(bundlePath, { encoding: 'utf8' }) as string);
      expect(bundle).toMatchObject({
        schema_version: 'browser-failure-bundle.v1',
        trace_path: 'active/shared/tmp/browser/phase3-test.zip',
      });
      expect(bundle.snapshot.focused_ref).toBe('@e1');
      expect(bundle.action_trail[0].redacted).toBe(true);
    } finally {
      safeRmSync(bundlePath, { force: true });
    }
  });
});
