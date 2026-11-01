import {
  dispositionFor,
  stampOutcome,
  type ComputerInteractionOutcome,
} from '@agent/core/computer-interaction-outcome';

/**
 * Maps system-executor interaction types and failure classes onto the
 * `computer_interaction` outcome vocabulary (see
 * knowledge/product/architecture/computer-use-runtime-model.md).
 *
 * A mutating action that dispatched without a postcondition read is
 * `delivered_unverified`; an unclassified failure on one is `unknown` /
 * `unsafe` rather than safe to retry.
 */
const MUTATING_INTERACTION_TYPES = new Set([
  'left_click',
  'double_click',
  'right_click',
  'mouse_move',
  'activate_application',
  'type_into_focused_input',
  'submit_focused_input',
  'type',
  'key',
  'voice_input_toggle',
  'activate_tab_by_title',
  'activate_tab_by_url',
  'close_tab_by_title',
  'close_tab_by_url',
  'reveal_path',
  'open_path',
  'empty_trash',
  'llm_assist',
]);

export function applyInteractionOutcome(result: unknown, actionType: string): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, any>;
  const status = record.status;

  if (status === 'blocked' || record.context?.approval_required === true) {
    return stampOutcome(record, {
      code: 'APPROVAL_REQUIRED',
      disposition: dispositionFor('not_delivered'),
      recovery: { strategy: 'approve_then_retry_with_request_id', retryable: true },
    });
  }
  if (status === 'denied') {
    return stampOutcome(record, {
      code: 'POLICY_DENIED',
      disposition: dispositionFor('not_delivered'),
    });
  }
  if (status === 'failed') {
    const matchMiss =
      record.context?.tab_activation?.matched === false ||
      record.context?.tab_close?.matched === false;
    return stampOutcome(
      record,
      matchMiss
        ? { code: 'ELEMENT_NOT_FOUND', disposition: dispositionFor('not_delivered') }
        : {
            code: 'ACTION_FAILED',
            disposition: dispositionFor(
              MUTATING_INTERACTION_TYPES.has(actionType) ? 'unknown' : 'not_delivered'
            ),
          }
    );
  }
  if (status === 'succeeded' && MUTATING_INTERACTION_TYPES.has(actionType)) {
    // A postcondition readback can promote or demote the delivery claim:
    // matched → verified, contradicted → uncertain, unread → unverified.
    const verification = record.context?.verification;
    const delivery =
      verification?.matched === true
        ? 'delivered_verified'
        : verification?.matched === false
          ? 'delivery_uncertain'
          : 'delivered_unverified';
    return stampOutcome(record, { disposition: dispositionFor(delivery) });
  }
  return result;
}

const STALE_TARGET_OUTCOME: ComputerInteractionOutcome = {
  code: 'STALE_TARGET',
  disposition: dispositionFor('not_delivered'),
  recovery: {
    strategy: 're_observe_then_retry',
    retryable: true,
    requires_fresh_observation: true,
  },
};

function classifyInteractionError(error: unknown, actionType: string): ComputerInteractionOutcome {
  const record = error as { code?: string; message?: string };
  const message = typeof record?.message === 'string' ? record.message : String(error);
  const code = typeof record?.code === 'string' ? record.code : undefined;

  if (code === 'MARK_STALE') {
    return {
      code: 'MARK_STALE',
      disposition: dispositionFor('not_delivered'),
      recovery: {
        strategy: 're_observe_then_retry',
        retryable: true,
        requires_fresh_observation: true,
      },
    };
  }
  if (code === 'MARK_INVALID') {
    return { code: 'MARK_INVALID', disposition: dispositionFor('not_delivered') };
  }
  if (message.startsWith('[OP_PREFLIGHT_') || message.includes('[SAFETY_LIMIT]')) {
    return { code: 'POLICY_DENIED', disposition: dispositionFor('not_delivered') };
  }
  if (/not editable/i.test(message)) {
    return { code: 'ACTION_NOT_SUPPORTED', disposition: dispositionFor('not_delivered') };
  }
  if (/guard failed/i.test(message)) return STALE_TARGET_OUTCOME;
  // Native bridge errors are already stable snake_case codes (same convention
  // as MARK_*): pass them through rather than flattening to ACTION_FAILED.
  if (/^[a-z]+_(accessibility|screen_recording)_(denied|unavailable)$/.test(message)) {
    return {
      code: message,
      disposition: dispositionFor('not_delivered'),
      recovery: { strategy: 'grant_permission_then_retry', retryable: true },
    };
  }
  if (/^[a-z]+_[a-z0-9_]*_unavailable$/.test(message)) {
    return {
      code: message,
      disposition: dispositionFor('not_delivered'),
      recovery: {
        strategy: 're_observe_then_retry',
        retryable: true,
        requires_fresh_observation: true,
      },
    };
  }
  if (/^invalid_[a-z0-9_]+$/.test(message) || message.startsWith('[WINDOWS_POINTER]')) {
    return { code: 'INVALID_ARGS', disposition: dispositionFor('not_delivered') };
  }
  if (/^(native|macos|windows)_[a-z0-9_]+$/.test(message)) {
    // A native dispatch failure on a mutating op cannot prove non-delivery.
    return {
      code: message,
      disposition: dispositionFor(
        MUTATING_INTERACTION_TYPES.has(actionType) ? 'unknown' : 'not_delivered'
      ),
    };
  }
  if (/requires|required|Unsupported computer interaction/i.test(message)) {
    return { code: 'INVALID_ARGS', disposition: dispositionFor('not_delivered') };
  }
  return {
    code: 'ACTION_FAILED',
    disposition: dispositionFor(
      MUTATING_INTERACTION_TYPES.has(actionType) ? 'unknown' : 'not_delivered'
    ),
  };
}

/** Stamp the classified outcome onto a thrown Error; callers keep the throw. */
export function stampInteractionError(error: unknown, actionType: string): unknown {
  if (error instanceof Error) {
    stampOutcome(error, classifyInteractionError(error, actionType));
  }
  return error;
}
