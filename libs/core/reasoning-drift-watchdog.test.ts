import { describe, expect, it } from 'vitest';

import {
  advanceReasoningDriftWatchdog,
  buildReasoningDriftSignature,
  createReasoningDriftWatchdogState,
  encodeReasoningDriftWatchdogState,
  hydrateReasoningDriftWatchdogState,
} from './reasoning-drift-watchdog.js';

describe('reasoning drift watchdog', () => {
  it('normalizes repeated observations into the same signature', () => {
    const first = buildReasoningDriftSignature({
      mission_id: 'MSN-DRIFT-001',
      item_id: 'WIT-DRIFT-001',
      cognitive_route_summary: 'tier=fast_llm; backend=fast_reasoning; deterministic=no',
      response_text: 'Completed the summary.',
      notes: ['First note'],
    });
    const second = buildReasoningDriftSignature({
      mission_id: ' msn-drift-001 ',
      item_id: 'wit-drift-001',
      cognitive_route_summary: 'tier=fast_llm; backend=fast_reasoning; deterministic=no',
      response_text: 'Completed the summary. ',
      notes: ['first note'],
    });

    expect(first).toBe(second);
  });

  it('stops after repeated identical results', () => {
    const initial = createReasoningDriftWatchdogState();
    const first = advanceReasoningDriftWatchdog(initial, {
      mission_id: 'MSN-DRIFT-002',
      item_id: 'WIT-DRIFT-002',
      response_text: 'same result',
      cognitive_route_summary: 'tier=fast_llm',
    });
    const second = advanceReasoningDriftWatchdog(first.state, {
      mission_id: 'MSN-DRIFT-002',
      item_id: 'WIT-DRIFT-002',
      response_text: 'same result',
      cognitive_route_summary: 'tier=fast_llm',
    });
    const third = advanceReasoningDriftWatchdog(second.state, {
      mission_id: 'MSN-DRIFT-002',
      item_id: 'WIT-DRIFT-002',
      response_text: 'same result',
      cognitive_route_summary: 'tier=fast_llm',
    });

    expect(first.should_stop).toBe(false);
    expect(second.should_stop).toBe(true);
    expect(third.should_stop).toBe(true);
    expect(third.needs_attention).toBe(true);
    expect(third.reason).toContain('repeated results');
  });

  it('stops when the response budget is exceeded', () => {
    const decision = advanceReasoningDriftWatchdog(createReasoningDriftWatchdogState(), {
      mission_id: 'MSN-DRIFT-003',
      item_id: 'WIT-DRIFT-003',
      prompt: 'x'.repeat(100),
      response_text: 'y'.repeat(100),
      cognitive_route_summary: 'tier=heavy_reasoning',
    }, {
      maxCombinedChars: 50,
    });

    expect(decision.should_stop).toBe(true);
    expect(decision.budget_exceeded).toBe(true);
    expect(decision.reason).toContain('budget');
  });

  it('hydrates and encodes persisted watchdog metadata', () => {
    const state = hydrateReasoningDriftWatchdogState({
      drift_watchdog_total_attempts: 4,
      drift_watchdog_consecutive_same_signature: 2,
      drift_watchdog_last_signature: 'sig',
      drift_watchdog_last_observed_at: '2026-06-20T00:00:00.000Z',
      drift_watchdog_last_reason: 'repeated signature',
    });

    expect(state.total_attempts).toBe(4);
    expect(encodeReasoningDriftWatchdogState(state)).toMatchObject({
      drift_watchdog_total_attempts: 4,
      drift_watchdog_consecutive_same_signature: 2,
      drift_watchdog_last_signature: 'sig',
    });
  });
});
