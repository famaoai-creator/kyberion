import { describe, expect, it, vi } from 'vitest';
import {
  buildBrowserElementPresentPipeline,
  createBrowserInteractionHelpers,
} from './browser-interaction-helpers.js';

describe('browser conditional interaction lowering', () => {
  it('lowers element presence into existing query_elements and if ops', () => {
    const steps = buildBrowserElementPresentPipeline({
      condition: {
        selector: 'button',
        text: '承認',
        exact: true,
        export_as: 'approval_count',
      },
      then: [{ type: 'apply', op: 'click_first_match', params: { selector: 'button' } }],
      else: [{ type: 'capture', op: 'snapshot', params: { export_as: 'unchanged' } }],
    });

    expect(steps).toEqual([
      {
        type: 'capture',
        op: 'query_elements',
        params: {
          selector: 'button',
          text: '承認',
          exact: true,
          export_as: 'approval_count',
        },
      },
      {
        type: 'control',
        op: 'if',
        params: {
          condition: { from: 'approval_count', operator: 'gt', value: 0 },
          then: [{ type: 'apply', op: 'click_first_match', params: { selector: 'button' } }],
          else: [{ type: 'capture', op: 'snapshot', params: { export_as: 'unchanged' } }],
        },
      },
    ]);
  });

  it('provides click_if_present as a compatible computer interaction shortcut', () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });

    const browserAction = helpers.translateComputerInteractionToBrowserAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'click_if_present',
        selector: 'button[data-action="approve"]',
        text: '承認',
      },
    } as any);

    expect(browserAction.steps).toEqual([
      {
        type: 'capture',
        op: 'query_elements',
        params: {
          selector: 'button[data-action="approve"]',
          text: '承認',
          export_as: 'conditional_match_count',
        },
      },
      {
        type: 'control',
        op: 'if',
        params: {
          condition: { from: 'conditional_match_count', operator: 'gt', value: 0 },
          then: [
            {
              type: 'apply',
              op: 'click_first_match',
              params: {
                selector: 'button[data-action="approve"]',
                text: '承認',
                exact: undefined,
                export_as: 'conditional_click',
              },
            },
          ],
        },
      },
    ]);
  });

  it('rejects a blank selector instead of falling back to all elements', () => {
    expect(() =>
      buildBrowserElementPresentPipeline({
        condition: { selector: '   ' },
        then: [],
      })
    ).toThrow('non-empty selector');
  });
});
