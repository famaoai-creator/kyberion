import { describe, expect, it, vi } from 'vitest';
import {
  buildBrowserElementPresentPipeline,
  createBrowserInteractionHelpers,
} from './browser-interaction-helpers.js';

describe('browser conditional interaction lowering', () => {
  it('captures requested observations after a mutating ref action', async () => {
    const executePipeline = vi.fn(async (steps) => ({
      status: 'succeeded',
      context: { observed: steps.at(-1).op },
    }));
    const helpers = createBrowserInteractionHelpers({
      executePipeline,
      emitComputerSurfacePatch: vi.fn(),
    });
    await helpers.handleComputerInteraction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'click_ref', ref: '@e1' },
      observation: {
        include_refs: true,
        include_screenshot: true,
        include_console: true,
        include_network: true,
      },
    });
    expect(executePipeline.mock.calls[0][0].map((step: { op: string }) => step.op)).toEqual([
      'click_ref',
      'snapshot',
      'screenshot',
      'console',
      'network',
    ]);
  });

  it('does not remint a snapshot before applying a live @eN', () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    const result = helpers.translateComputerInteractionToBrowserAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'keep-alive-session',
      action: { type: 'click_ref', ref: '@e1' },
    });
    expect(result.options?.keep_alive).toBe(true);
    expect(result.steps.map((step) => step.op)).toEqual(['click_ref']);
    expect(result.steps[0]?.params).toEqual({ ref: '@e1', timeout: undefined });
  });

  it('prefers a recorded selector over ephemeral @eN for click/fill/press', () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    const click = helpers.translateComputerInteractionToBrowserAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'click_ref',
        ref: '@e1',
        selector: 'button.submit',
        name: 'Submit',
        role: 'button',
      },
    });
    expect(click.steps).toEqual([
      {
        type: 'apply',
        op: 'click',
        params: { selector: 'button.submit', name: 'Submit', role: 'button', timeout: undefined },
      },
    ]);

    const fill = helpers.translateComputerInteractionToBrowserAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'fill_ref',
        ref: '@e1',
        selector: 'input[name="q"]',
        text: 'kyberion',
        name: 'Search',
        role: 'textbox',
      },
    });
    expect(fill.steps).toEqual([
      {
        type: 'apply',
        op: 'fill',
        params: {
          selector: 'input[name="q"]',
          text: 'kyberion',
          name: 'Search',
          role: 'textbox',
          timeout: undefined,
        },
      },
    ]);
  });

  it('emits fill_secret_ref with corroborating dom_path and never remints @eN', () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    const result = helpers.translateComputerInteractionToBrowserAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'fill_secret_ref',
        ref: '@e1',
        selector: 'input[name="token"]',
        secret_ref: 'GITHUB_TOKEN',
        name: 'API Key',
        role: 'textbox',
      },
    });
    expect(result.steps).toEqual([
      {
        type: 'apply',
        op: 'fill_secret_ref',
        params: {
          ref: '@e1',
          secret_ref: 'GITHUB_TOKEN',
          name: 'API Key',
          role: 'textbox',
          dom_path: 'input[name="token"]',
          timeout: undefined,
        },
      },
    ]);
    expect(result.steps.some((step) => step.op === 'snapshot')).toBe(false);
  });

  it('prefers explicit dom_path over selector for secret fills', () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    const result = helpers.translateComputerInteractionToBrowserAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'fill_secret_ref',
        ref: '@e1',
        selector: 'input[name="token"]',
        dom_path: '#approved-token-field',
        secret_ref: 'GITHUB_TOKEN',
      },
    });
    expect(result.steps[0]?.params).toMatchObject({
      dom_path: '#approved-token-field',
      secret_ref: 'GITHUB_TOKEN',
    });
  });

  it('fails closed on identity-insufficient secret fills instead of snapshot+@eN', () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    expect(() =>
      helpers.translateComputerInteractionToBrowserAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'fill_secret_ref', ref: '@e1', secret_ref: 'GITHUB_TOKEN' },
      })
    ).toThrow(/refusing snapshot\+@eN stand-in/);
    expect(() =>
      helpers.translateComputerInteractionToBrowserAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'fill_ref', ref: '@e1', secret_ref: 'GITHUB_TOKEN', text: 'ignored' },
      })
    ).toThrow(/refusing snapshot\+@eN stand-in/);
  });

  it.each(['snapshot', 'screenshot', 'capture_console', 'capture_network'] as const)(
    'does not duplicate the observation already performed by %s',
    (type) => {
      const helpers = createBrowserInteractionHelpers({
        executePipeline: vi.fn(),
        emitComputerSurfacePatch: vi.fn(),
      });
      const result = helpers.translateComputerInteractionToBrowserAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type },
        observation: { mode: 'mixed' },
      });
      for (const op of ['snapshot', 'screenshot', 'console', 'network']) {
        expect(result.steps.filter((step) => step.op === op)).toHaveLength(1);
      }
    }
  );

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
