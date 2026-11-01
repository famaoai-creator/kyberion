import { describe, expect, it, vi } from 'vitest';
import {
  applyBrowserInteractionOutcome,
  createBrowserInteractionHelpers,
} from './browser-interaction-helpers.js';

function helpersReturning(result: unknown) {
  return createBrowserInteractionHelpers({
    executePipeline: vi.fn(async () => result),
    emitComputerSurfacePatch: vi.fn(),
  });
}

describe('browser computer_interaction outcome vocabulary', () => {
  it('marks a dispatched ref action delivered_unverified and unsafe to repeat', async () => {
    const helpers = helpersReturning({ status: 'succeeded', context: {} });
    const result = (await helpers.handleComputerInteraction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'click_ref', ref: '@e1' },
    })) as Record<string, unknown>;
    expect(result.disposition).toEqual({
      delivery: 'delivered_unverified',
      retry: 'unsafe',
    });
  });

  it('promotes a fill verified by value readback to delivered_verified', async () => {
    const helpers = helpersReturning({
      status: 'succeeded',
      context: {
        action_trail: [{ kind: 'apply', op: 'fill_ref', verified: true }],
      },
    });
    const result = (await helpers.handleComputerInteraction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'fill_ref', ref: '@e1', text: 'a@b.com' },
    })) as Record<string, unknown>;
    expect(result.disposition).toEqual({ delivery: 'delivered_verified', retry: 'unsafe' });
  });

  it('demotes a contradicted fill readback to delivery_uncertain', async () => {
    const helpers = helpersReturning({
      status: 'succeeded',
      context: {
        action_trail: [{ kind: 'apply', op: 'fill_ref', verified: false }],
      },
    });
    const result = (await helpers.handleComputerInteraction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'fill_ref', ref: '@e1', text: 'x' },
    })) as Record<string, unknown>;
    expect(result.disposition).toEqual({ delivery: 'delivery_uncertain', retry: 'unsafe' });
  });

  it('leaves pure observation results without a disposition', async () => {
    const helpers = helpersReturning({ status: 'succeeded', context: {} });
    const result = (await helpers.handleComputerInteraction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'snapshot' },
    })) as Record<string, unknown>;
    expect(result.disposition).toBeUndefined();
  });

  it('maps an unknown browser ref failure to STALE_REF with fresh-observation recovery', () => {
    const result = applyBrowserInteractionOutcome(
      {
        status: 'failed',
        results: [
          {
            op: 'click_ref',
            status: 'failed',
            error: 'Unknown browser ref: @e7. Capture a snapshot',
          },
        ],
      },
      'click_ref'
    ) as Record<string, unknown>;
    expect(result.code).toBe('STALE_REF');
    expect(result.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(result.recovery).toMatchObject({ requires_fresh_observation: true });
  });

  it('maps an unresolved recorded ref to STALE_REF with re-observe recovery', () => {
    const result = applyBrowserInteractionOutcome(
      {
        status: 'failed',
        results: [
          {
            op: 'click_ref',
            status: 'failed',
            error: 'Could not resolve recorded ref (role=button, name=Save) against the live page.',
          },
        ],
      },
      'click_ref'
    ) as Record<string, unknown>;
    expect(result.code).toBe('STALE_REF');
    expect(result.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(result.recovery).toMatchObject({
      strategy: 're_observe_then_retry',
      requires_fresh_observation: true,
    });
  });

  it('maps a multi-match recorded ref to AMBIGUOUS_TARGET', () => {
    const result = applyBrowserInteractionOutcome(
      {
        status: 'failed',
        error:
          'Recorded ref (role=button, name=Submit) matched 3 elements on the live page; refusing to guess.',
      },
      'click_ref'
    ) as Record<string, unknown>;
    expect(result.code).toBe('AMBIGUOUS_TARGET');
    expect(result.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(result.recovery).toMatchObject({ strategy: 'narrow_target_or_fresh_observation' });
  });

  it('maps a spoof-suspected recorded ref to TARGET_MISMATCH and non-retryable', () => {
    const result = applyBrowserInteractionOutcome(
      {
        status: 'failed',
        error:
          'Refusing to resolve recorded ref (role=textbox, name=Password): role/name matched "input" but dom_path resolves to a different element.',
      },
      'fill_secret_ref'
    ) as Record<string, unknown>;
    expect(result.code).toBe('TARGET_MISMATCH');
    expect(result.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(result.recovery).toMatchObject({
      strategy: 're_record_or_reapprove_target',
      retryable: false,
    });
  });

  it('keeps unclassified mutating failures unknown and unsafe to retry', () => {
    const result = applyBrowserInteractionOutcome(
      { status: 'failed', error: 'navigation exploded' },
      'click_ref'
    ) as Record<string, unknown>;
    expect(result.code).toBe('ACTION_FAILED');
    expect(result.disposition).toEqual({ delivery: 'unknown', retry: 'unknown' });
  });

  it('stamps the snapshot+@eN refusal as POLICY_DENIED and safe to retry', async () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    const error = (await helpers
      .handleComputerInteraction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'fill_secret_ref', ref: '@e1', secret_ref: 'TOKEN' },
      })
      .catch((caught: unknown) => caught)) as Record<string, unknown>;
    expect(error.code).toBe('POLICY_DENIED');
    expect(error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
  });

  it('stamps a missing-ref contract violation as INVALID_ARGS', async () => {
    const helpers = createBrowserInteractionHelpers({
      executePipeline: vi.fn(),
      emitComputerSurfacePatch: vi.fn(),
    });
    const error = (await helpers
      .handleComputerInteraction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'click_ref' },
      })
      .catch((caught: unknown) => caught)) as Record<string, unknown>;
    expect(error.code).toBe('INVALID_ARGS');
    expect(error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
  });
});
