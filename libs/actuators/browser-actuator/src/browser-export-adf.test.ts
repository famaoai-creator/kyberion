import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { resolveRefOrRecordedTarget } from './recorded-ref-resolver.js';

const TS = '2026-09-13T00:00:00.000Z';

describe('renderBrowserAdf durable export', () => {
  it('exports recorded click_ref with selector as canonical click (no ephemeral ref)', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'goto',
          url: 'https://example.com',
          ts: TS,
        },
        {
          kind: 'capture',
          op: 'snapshot',
          url: 'https://example.com',
          title: 'Example Domain',
          ts: TS,
        },
        {
          kind: 'apply',
          op: 'click_ref',
          ref: '@e1',
          selector: 'body > div > p:nth-of-type(2) > a:nth-of-type(1)',
          element_name: 'Learn more',
          element_role: 'link',
          ts: TS,
        },
      ],
      'example-learn-more'
    );

    expect(adf).toEqual({
      action: 'pipeline',
      session_id: 'example-learn-more',
      steps: [
        { type: 'capture', op: 'goto', params: { url: 'https://example.com' } },
        { type: 'capture', op: 'snapshot', params: {} },
        {
          type: 'apply',
          op: 'click',
          params: {
            selector: 'body > div > p:nth-of-type(2) > a:nth-of-type(1)',
            name: 'Learn more',
            role: 'link',
          },
        },
      ],
    });
    expect(JSON.stringify(adf.steps)).not.toContain('@e1');
    expect(adf.steps.some((step) => step.op === 'click_ref')).toBe(false);
  });

  it('exports recorded click with selector the same way as click_ref', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'click',
          ref: '@e2',
          selector: 'button.submit',
          element_name: 'Submit',
          ts: TS,
        },
      ],
      'canonical-click'
    );

    expect(adf.steps).toEqual([
      {
        type: 'apply',
        op: 'click',
        params: { selector: 'button.submit', name: 'Submit' },
      },
    ]);
  });

  it('exports fill/press/wait with recorded selectors as canonical ops', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'fill_ref',
          ref: '@e1',
          selector: 'input[name="q"]',
          text: 'kyberion',
          element_name: 'Search',
          element_role: 'textbox',
          ts: TS,
        },
        {
          kind: 'apply',
          op: 'press_ref',
          ref: '@e1',
          selector: 'input[name="q"]',
          key: 'Enter',
          ts: TS,
        },
        {
          kind: 'apply',
          op: 'wait_ref',
          ref: '@e3',
          selector: '#results',
          ts: TS,
        },
      ],
      'selector-applies'
    );

    expect(adf.steps).toEqual([
      {
        type: 'apply',
        op: 'fill',
        params: { selector: 'input[name="q"]', text: 'kyberion', name: 'Search', role: 'textbox' },
      },
      {
        type: 'apply',
        op: 'press',
        params: { selector: 'input[name="q"]', key: 'Enter' },
      },
      {
        type: 'apply',
        op: 'wait',
        params: { selector: '#results' },
      },
    ]);
  });

  it('inserts a snapshot before ref-only apply steps so @eN can resolve', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'goto',
          url: 'https://example.com',
          ts: TS,
        },
        {
          kind: 'apply',
          op: 'click_ref',
          ref: '@e1',
          ts: TS,
        },
      ],
      'ref-only'
    );

    expect(adf.steps).toEqual([
      { type: 'capture', op: 'goto', params: { url: 'https://example.com' } },
      { type: 'capture', op: 'snapshot', params: {} },
      { type: 'apply', op: 'click', params: { ref: '@e1' } },
    ]);
  });

  it('does not require a snapshot when role/name can resolve a ref', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'click_ref',
          ref: '@e1',
          element_name: 'Learn more',
          element_role: 'link',
          ts: TS,
        },
      ],
      'role-name-only'
    );

    expect(adf.steps).toEqual([
      {
        type: 'apply',
        op: 'click',
        params: { ref: '@e1', name: 'Learn more', role: 'link' },
      },
    ]);
  });

  it('exports secret fills with recorded selector as dom_path so requireDomPathMatch can corroborate', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'fill_secret_ref',
          ref: '@e1',
          selector: 'input[name="token"]',
          secret_ref: 'GITHUB_TOKEN',
          classification: 'secret_ref',
          element_name: 'API Key',
          element_role: 'textbox',
          ts: TS,
        },
      ],
      'secret-durable'
    );

    expect(adf.steps).toEqual([
      {
        type: 'apply',
        op: 'fill_secret_ref',
        params: {
          ref: '@e1',
          secret_ref: 'GITHUB_TOKEN',
          name: 'API Key',
          role: 'textbox',
          dom_path: 'input[name="token"]',
        },
      },
    ]);
    expect(adf.steps.some((step) => step.op === 'snapshot')).toBe(false);
  });

  it('preserves an explicit trail dom_path when selector is absent (extension-style recording)', () => {
    const recorded = browserRuntimeHelpers.recordBrowserAction(
      { session_id: 'secret-dom-path', action_trail: [] },
      {
        kind: 'apply',
        op: 'fill_secret_ref',
        ref: '@e1',
        dom_path: 'form > input:nth-of-type(2)',
        secret_ref: 'GITHUB_TOKEN',
        classification: 'secret_ref',
        element_name: 'API Key',
        element_role: 'textbox',
      }
    );

    expect(recorded.action_trail[0]).toMatchObject({
      op: 'fill_secret_ref',
      dom_path: 'form > input:nth-of-type(2)',
    });

    const adf = browserRuntimeHelpers.renderBrowserAdf(recorded.action_trail, 'secret-dom-path');
    expect(adf.steps).toEqual([
      {
        type: 'apply',
        op: 'fill_secret_ref',
        params: {
          ref: '@e1',
          secret_ref: 'GITHUB_TOKEN',
          name: 'API Key',
          role: 'textbox',
          dom_path: 'form > input:nth-of-type(2)',
        },
      },
    ]);
    expect(adf.steps.some((step) => step.op === 'snapshot')).toBe(false);
  });

  it('prefers explicit trail dom_path over selector when both are present', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'fill_secret_ref',
          ref: '@e1',
          selector: 'input[name="token"]',
          dom_path: '#approved-token-field',
          secret_ref: 'GITHUB_TOKEN',
          classification: 'secret_ref',
          element_name: 'API Key',
          element_role: 'textbox',
          ts: TS,
        },
      ],
      'secret-dom-path-preferred'
    );

    expect(adf.steps[0]?.params).toMatchObject({
      dom_path: '#approved-token-field',
    });
    expect(adf.steps[0]?.params.selector).toBeUndefined();
  });

  it('omits ref-only secret fills from export instead of snapshot + ephemeral @eN', () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'goto',
          url: 'https://example.com/login',
          ts: TS,
        },
        {
          kind: 'apply',
          op: 'fill_secret_ref',
          ref: '@e1',
          secret_ref: 'GITHUB_TOKEN',
          classification: 'secret_ref',
          ts: TS,
        },
      ],
      'secret-ref-only'
    );

    expect(adf.steps).toEqual([
      { type: 'capture', op: 'goto', params: { url: 'https://example.com/login' } },
    ]);
    expect(adf.steps.some((step) => step.op === 'fill_secret_ref')).toBe(false);
    expect(adf.steps.some((step) => step.op === 'snapshot')).toBe(false);
  });

  it('resolves exported secret-fill identity without a prior snapshot ref_map', async () => {
    const adf = browserRuntimeHelpers.renderBrowserAdf(
      [
        {
          kind: 'apply',
          op: 'fill_secret_ref',
          ref: '@e1',
          selector: 'input#key',
          secret_ref: 'GITHUB_TOKEN',
          classification: 'secret_ref',
          element_name: 'API Key',
          element_role: 'textbox',
          ts: TS,
        },
      ],
      'secret-replay'
    );
    const params = adf.steps[0]?.params as {
      ref: string;
      name: string;
      role: string;
      dom_path: string;
    };
    const page = {
      evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
        if (arg && typeof arg === 'object' && 'domPath' in (arg as Record<string, unknown>)) {
          const { domPath, candidateSelector } = arg as {
            domPath: string;
            candidateSelector: string;
          };
          return domPath === 'input#key' && candidateSelector === 'input#key';
        }
        return {
          elements: [
            {
              ref: '@e9',
              tag: 'input',
              role: 'textbox',
              text: '',
              name: 'API Key',
              type: 'password',
              placeholder: null,
              href: null,
              value: null,
              visible: true,
              editable: true,
              selector: 'input#key',
            },
          ],
        };
      }),
    } as unknown as Page;

    const resolved = await resolveRefOrRecordedTarget({}, params.ref, page, {
      role: params.role,
      name: params.name,
      dom_path: params.dom_path,
      requireDomPathMatch: true,
    });

    expect(resolved.selector).toBe('input#key');
    expect(resolved.ctx.ref_map).toMatchObject({ '@e1': 'input#key' });
  });
});
