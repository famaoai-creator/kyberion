import { createHash } from 'node:crypto';
import { currentScope } from '../scope-context.js';
import {
  recordConversationSignal,
  type ConversationSignalKind,
} from '../intent/conversation-signals.js';
import type { SurfaceConversationInput } from './channel-surface-types.js';

/**
 * The surface conversation's producers for the conversation signal ledger
 * (libs/core/intent/conversation-signals.ts). They live here, not in the
 * orchestrator, so the turn code only names the moment ("this turn failed")
 * and the ledger's privacy rules are applied in one place.
 *
 * A turn is recorded only when it is neither isolated nor tenant-scoped; the
 * ledger enforces that, these helpers only pass the turn's scope along.
 */

function turnScope(input: SurfaceConversationInput | undefined): { tenant_slug?: string } {
  const tenant = input?.scope?.tenant_slug;
  if (tenant) return { tenant_slug: tenant };
  try {
    return { tenant_slug: currentScope().tenant_slug };
  } catch {
    return {};
  }
}

function base(input: SurfaceConversationInput | undefined) {
  return {
    utterance: input?.surfaceText || input?.query,
    correlationId: input?.correlationId,
    surface: input?.surface,
    locale: input?.locale,
    scope: turnScope(input),
    isolated: Boolean(input?.isolation),
  };
}

/**
 * A governed turn reached an outcome for its intent and contract. Takes the same
 * parameters as `recordIntentContractOutcome` and never throws, so recording it
 * cannot disturb the learning update that follows.
 */
export function recordTurnOutcomeSignal(
  input: SurfaceConversationInput | undefined,
  outcome: {
    intent_id: string;
    success: boolean;
    execution_shape: string;
    contract_ref?: { kind: string };
    error?: string;
  }
): void {
  try {
    recordConversationSignal({
      ...base(input),
      kind: outcome.success ? 'turn_succeeded' : 'turn_failed',
      intentId: outcome.intent_id,
      detail: {
        shape: outcome.execution_shape,
        ...(outcome.contract_ref?.kind ? { contract: outcome.contract_ref.kind } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    });
  } catch {
    // Best effort: the ledger must never block a turn's own learning update.
  }
}

const FEEDBACK_KIND: Record<string, ConversationSignalKind> = {
  satisfied: 'feedback_satisfied',
  partially_satisfied: 'feedback_partial',
  dissatisfied: 'feedback_dissatisfied',
};

/** The operator told us how a turn went. */
export function recordFeedbackSignal(
  input: SurfaceConversationInput,
  record: { outcome: string; intent_id: string; scenario_id: string; correction?: string }
): void {
  const kind = FEEDBACK_KIND[record.outcome];
  if (!kind) return;
  recordConversationSignal({
    ...base(input),
    kind,
    intentId: record.intent_id,
    detail: {
      scenario_id: record.scenario_id,
      ...(record.correction ? { has_correction: true } : {}),
    },
  });
}

/**
 * A clarification question went out (`asked`) or its answer came back
 * (`answered`). Both carry the same hashed pending key; a question with no
 * answer after the pending-intent TTL is read as abandoned by the summary.
 */
export function recordClarificationSignal(
  moment: 'asked' | 'answered',
  input: SurfaceConversationInput,
  pending: { key: string; intentId?: string }
): void {
  recordConversationSignal({
    ...base(input),
    kind: moment === 'asked' ? 'clarification_asked' : 'clarification_answered',
    intentId: pending.intentId,
    detail: { pending_key: createHash('sha256').update(pending.key).digest('hex').slice(0, 16) },
  });
}
