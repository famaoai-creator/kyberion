import { describe, expect, it } from 'vitest';
import { MarkTargetError } from '@agent/core/mark-target-resolver';
import { applyInteractionOutcome, stampInteractionError } from './system-computer-outcome.js';

describe('system computer_interaction outcome vocabulary', () => {
  it('marks a dispatched mutating action delivered_unverified and unsafe to repeat', () => {
    const result = applyInteractionOutcome(
      { status: 'succeeded', results: [{ op: 'mouse_click', status: 'success' }] },
      'left_click'
    ) as Record<string, unknown>;
    expect(result.disposition).toEqual({
      delivery: 'delivered_unverified',
      retry: 'unsafe',
    });
  });

  it('promotes a postcondition-verified mutating action to delivered_verified', () => {
    const result = applyInteractionOutcome(
      {
        status: 'succeeded',
        context: {
          verification: {
            kind: 'active_tab',
            expected: 'Docs',
            observed: 'Docs - Chrome',
            matched: true,
          },
        },
      },
      'activate_tab_by_title'
    ) as Record<string, unknown>;
    expect(result.disposition).toEqual({ delivery: 'delivered_verified', retry: 'unsafe' });
  });

  it('demotes a contradicted postcondition readback to delivery_uncertain', () => {
    const result = applyInteractionOutcome(
      {
        status: 'succeeded',
        context: {
          verification: {
            kind: 'frontmost_application',
            expected: 'Notes',
            observed: 'Finder',
            matched: false,
          },
        },
      },
      'activate_application'
    ) as Record<string, unknown>;
    expect(result.disposition).toEqual({ delivery: 'delivery_uncertain', retry: 'unsafe' });
  });

  it('leaves pure observation results without a disposition', () => {
    const result = applyInteractionOutcome(
      { status: 'succeeded', context: { focused_input: {} } },
      'detect_focused_input'
    ) as Record<string, unknown>;
    expect(result.disposition).toBeUndefined();
    expect(result.code).toBeUndefined();
  });

  it('maps approval-blocked results to a safe retry path through the request id', () => {
    const result = applyInteractionOutcome(
      {
        status: 'blocked',
        context: { approval_required: true, approval_request_id: 'req-1' },
      },
      'empty_trash'
    ) as Record<string, unknown>;
    expect(result.code).toBe('APPROVAL_REQUIRED');
    expect(result.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(result.recovery).toMatchObject({
      strategy: 'approve_then_retry_with_request_id',
      retryable: true,
    });
  });

  it('maps tab lookup failures to ELEMENT_NOT_FOUND with safe retry', () => {
    const result = applyInteractionOutcome(
      { status: 'failed', context: { tab_activation: { matched: false } } },
      'activate_tab_by_title'
    ) as Record<string, unknown>;
    expect(result.code).toBe('ELEMENT_NOT_FOUND');
    expect(result.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
  });

  it('keeps unclassified mutating failures unknown and unsafe to retry', () => {
    const result = applyInteractionOutcome(
      { status: 'failed', results: [{ op: 'keyboard', status: 'failed' }] },
      'type'
    ) as Record<string, unknown>;
    expect(result.code).toBe('ACTION_FAILED');
    expect(result.disposition).toEqual({ delivery: 'unknown', retry: 'unknown' });
  });

  it('passes the native MARK_STALE code through with a fresh-observation recovery', () => {
    const error = stampInteractionError(
      new MarkTargetError('MARK_STALE', 'marks expired'),
      'left_click'
    ) as Record<string, unknown>;
    expect(error.code).toBe('MARK_STALE');
    expect(error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(error.recovery).toMatchObject({ requires_fresh_observation: true });
  });

  it('classifies preflight denials as POLICY_DENIED with safe retry', () => {
    const error = stampInteractionError(
      new Error('[OP_PREFLIGHT_BLOCK] test denial'),
      'left_click'
    ) as Record<string, unknown>;
    expect(error.code).toBe('POLICY_DENIED');
    expect(error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
  });

  it('classifies a non-editable focused element as ACTION_NOT_SUPPORTED', () => {
    const error = stampInteractionError(
      new Error('Focused element is not editable (AXTextArea)'),
      'type_into_focused_input'
    ) as Record<string, unknown>;
    expect(error.code).toBe('ACTION_NOT_SUPPORTED');
  });

  it('passes a native permission denial through with a grant-permission recovery', () => {
    const error = stampInteractionError(
      new Error('macos_accessibility_denied'),
      'left_click'
    ) as Record<string, unknown>;
    expect(error.code).toBe('macos_accessibility_denied');
    expect(error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(error.recovery).toMatchObject({
      strategy: 'grant_permission_then_retry',
      retryable: true,
    });
  });

  it('passes a native unavailability through with a re-observe recovery', () => {
    const error = stampInteractionError(
      new Error('macos_focused_input_unavailable'),
      'detect_focused_input'
    ) as Record<string, unknown>;
    expect(error.code).toBe('macos_focused_input_unavailable');
    expect(error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' });
    expect(error.recovery).toMatchObject({ requires_fresh_observation: true });
  });

  it('maps native invalid-argument codes to INVALID_ARGS', () => {
    const error = stampInteractionError(
      new Error('invalid_mouse_coordinate'),
      'left_click'
    ) as Record<string, unknown>;
    expect(error.code).toBe('INVALID_ARGS');
  });

  it('keeps a native dispatch failure on a mutating op unproven', () => {
    const error = stampInteractionError(new Error('native_mouse_failed'), 'left_click') as Record<
      string,
      unknown
    >;
    expect(error.code).toBe('native_mouse_failed');
    expect(error.disposition).toEqual({ delivery: 'unknown', retry: 'unknown' });
  });

  it('does not overwrite an outcome a deeper layer already stamped', () => {
    const error = new MarkTargetError('MARK_STALE', 'marks expired');
    stampOutcomePreset(error);
    const stamped = stampInteractionError(error, 'left_click') as Record<string, unknown> & {
      disposition: { delivery: string };
    };
    expect(stamped.code).toBe('PRESET');
    expect(stamped.disposition.delivery).toBe('delivery_uncertain');
  });
});

function stampOutcomePreset(error: Error): void {
  (error as unknown as Record<string, unknown>).code = 'PRESET';
  (error as unknown as Record<string, unknown>).disposition = {
    delivery: 'delivery_uncertain',
    retry: 'unsafe',
  };
}
