import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  configureConversationSignalRoot,
  listConversationSignals,
  resetConversationSignalDedupe,
} from '../intent/conversation-signals.js';
import {
  recordClarificationSignal,
  recordFeedbackSignal,
  recordTurnOutcomeSignal,
} from './surface-conversation-signals.js';
import type { SurfaceConversationInput } from './channel-surface-types.js';

function turn(overrides: Partial<SurfaceConversationInput> = {}): SurfaceConversationInput {
  return {
    query: '来週の予定を教えて',
    correlationId: 'corr-1',
    surface: 'slack',
    locale: 'ja',
    ...overrides,
  } as SurfaceConversationInput;
}

describe('surface conversation signal producers', () => {
  let root = '';

  beforeEach(() => {
    root = pathResolver.sharedTmp(`surface-signals-${process.pid}-${Date.now()}`);
    configureConversationSignalRoot(root);
    resetConversationSignalDedupe();
  });

  afterEach(() => {
    configureConversationSignalRoot(undefined);
    safeRmSync(root, { recursive: true, force: true });
  });

  it('records a turn outcome with the intent, shape and contract', () => {
    recordTurnOutcomeSignal(turn(), {
      intent_id: 'schedule-read-agenda',
      success: false,
      execution_shape: 'direct_reply',
      contract_ref: { kind: 'pipeline' },
      error: 'calendar read failed',
    });
    expect(listConversationSignals()).toEqual([
      expect.objectContaining({
        kind: 'turn_failed',
        intent_id: 'schedule-read-agenda',
        surface: 'slack',
        correlation_id: 'corr-1',
        excerpt: '来週の予定を教えて',
        detail: expect.objectContaining({ shape: 'direct_reply', error: 'calendar read failed' }),
      }),
    ]);
  });

  it('records an outcome that carries no contract, and never throws', () => {
    expect(() =>
      recordTurnOutcomeSignal(undefined, {
        intent_id: 'x',
        success: true,
        execution_shape: 'direct_reply',
      })
    ).not.toThrow();
    expect(listConversationSignals()).toHaveLength(1);
  });

  it('maps operator feedback to a signal and ignores unknown outcomes', () => {
    recordFeedbackSignal(turn(), {
      outcome: 'dissatisfied',
      intent_id: 'x',
      scenario_id: 's',
      correction: 'そうじゃない',
    });
    recordFeedbackSignal(turn(), { outcome: 'unknown', intent_id: 'x', scenario_id: 's' });
    const signals = listConversationSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'feedback_dissatisfied', intent_id: 'x' });
    expect(signals[0].detail).toMatchObject({ has_correction: true });
  });

  it('pairs a question and its answer through the same hashed key', () => {
    recordClarificationSignal('asked', turn(), { key: 'surface-pending-abc', intentId: 'i' });
    recordClarificationSignal('answered', turn(), { key: 'surface-pending-abc', intentId: 'i' });
    const [asked, answered] = listConversationSignals();
    expect(asked.kind).toBe('clarification_asked');
    expect(answered.kind).toBe('clarification_answered');
    expect(asked.detail?.pending_key).toBe(answered.detail?.pending_key);
    expect(String(asked.detail?.pending_key)).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(asked)).not.toContain('surface-pending-abc');
  });

  it('never records a tenant-scoped or isolated turn', () => {
    const tenantTurn = turn({
      scope: { tenant_slug: 'acme' },
    } as Partial<SurfaceConversationInput>);
    recordTurnOutcomeSignal(tenantTurn, {
      intent_id: 'x',
      success: true,
      execution_shape: 'direct_reply',
      contract_ref: { kind: 'pipeline' },
    });
    recordClarificationSignal('asked', tenantTurn, { key: 'k' });
    recordTurnOutcomeSignal(
      turn({ isolation: { mode: 'tenant' } } as unknown as Partial<SurfaceConversationInput>),
      {
        intent_id: 'x',
        success: true,
        execution_shape: 'direct_reply',
        contract_ref: { kind: 'pipeline' },
      }
    );
    expect(listConversationSignals()).toEqual([]);
  });
});
