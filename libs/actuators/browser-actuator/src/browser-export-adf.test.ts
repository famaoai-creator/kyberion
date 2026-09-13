import { describe, expect, it } from 'vitest';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';

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
});
