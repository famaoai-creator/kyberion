import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalStoreRoots,
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
} from './approval-store.js';
import {
  approvalDeliveryCorrelationId,
  buildVetoWindow,
  computeVetoDeadline,
  evaluateVetoWindow,
  isWithinActiveHours,
  markApprovalNotificationDelivered,
  recordApprovalDeliveryReceipt,
  tickVetoWindows,
  VETO_WINDOW_DECIDER,
  type ActiveHours,
} from './approval-veto-window.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';

const TOKYO: ActiveHours = { start: '09:00', end: '22:00', timezone: 'Asia/Tokyo' };
const MINUTE = 60_000;
// 2026-09-28 12:00 JST
const NOON_JST = Date.parse('2026-09-28T03:00:00Z');
const CHANNEL = 'veto-window-suite';

describe('active hours and deadlines', () => {
  it('counts wall-clock minutes when no active hours are set', () => {
    expect(computeVetoDeadline(NOON_JST, 120)?.toISOString()).toBe('2026-09-28T05:00:00.000Z');
  });

  it('pauses the clock outside active hours', () => {
    // 21:30 JST + 120 active minutes = 30 min today, 90 min from 09:00 tomorrow.
    const start = Date.parse('2026-09-28T12:30:00Z');
    expect(computeVetoDeadline(start, 120, TOKYO)?.toISOString()).toBe('2026-09-29T01:30:00.000Z');
  });

  it('waits for the day to start before counting', () => {
    // 07:00 JST + 60 → 10:00 JST
    const start = Date.parse('2026-09-27T22:00:00Z');
    expect(computeVetoDeadline(start, 60, TOKYO)?.toISOString()).toBe('2026-09-28T01:00:00.000Z');
  });

  it('supports ranges that cross midnight and treats start == end as always active', () => {
    const night: ActiveHours = { start: '22:00', end: '06:00', timezone: 'Asia/Tokyo' };
    expect(isWithinActiveHours(Date.parse('2026-09-28T14:00:00Z'), night)).toBe(true); // 23:00
    expect(isWithinActiveHours(NOON_JST, night)).toBe(false);
    expect(isWithinActiveHours(NOON_JST, { ...night, end: '22:00' })).toBe(true);
  });

  it('rejects malformed active hours instead of guessing', () => {
    expect(() => isWithinActiveHours(NOON_JST, { ...TOKYO, start: '9am' })).toThrow(/active-hours/);
  });
});

describe('evaluateVetoWindow', () => {
  const base = buildVetoWindow({ windowMinutes: 60, now: NOON_JST });

  it('waits for delivery, then falls back to a decision once the grace passes', () => {
    expect(evaluateVetoWindow(base, NOON_JST + 10 * MINUTE)).toBe('awaiting_delivery');
    expect(evaluateVetoWindow(base, NOON_JST + 31 * MINUTE)).toBe('undelivered');
  });

  it('counts after delivery and elapses at proceedsAt', () => {
    const delivered = {
      ...base,
      deliveredAt: new Date(NOON_JST).toISOString(),
      proceedsAt: new Date(NOON_JST + 60 * MINUTE).toISOString(),
    };
    expect(evaluateVetoWindow(delivered, NOON_JST + 59 * MINUTE)).toBe('counting');
    expect(evaluateVetoWindow(delivered, NOON_JST + 60 * MINUTE)).toBe('elapsed');
    expect(evaluateVetoWindow({ ...delivered, shadow: true }, NOON_JST + 61 * MINUTE)).toBe(
      'elapsed_shadow'
    );
  });

  it('never reads a malformed deadline as elapsed', () => {
    const malformed = { ...base, deliveredAt: 'x', proceedsAt: 'not-a-date' };
    expect(evaluateVetoWindow(malformed, NOON_JST + 1000 * MINUTE)).toBe('counting');
  });

  it('keeps a fallen-back window a decision forever', () => {
    expect(evaluateVetoWindow({ ...base, fallback: 'undelivered' }, NOON_JST)).toBe('undelivered');
  });

  it('refuses a non-positive window', () => {
    expect(() => buildVetoWindow({ windowMinutes: 0 })).toThrow(/positive/);
  });
});

describe('veto windows on the approval store', () => {
  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/${CHANNEL}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  function createVetoRequest(options: { shadow?: boolean; now?: number } = {}) {
    return createApprovalRequest('mission_controller', {
      channel: 'chat-1',
      storageChannel: CHANNEL,
      threadTs: '',
      correlationId: 'veto-suite',
      requestedBy: 'agent:test',
      draft: { title: 'Merge PR 42', summary: 'Merge a medium-risk PR' },
      veto: buildVetoWindow({
        windowMinutes: 120,
        shadow: options.shadow,
        now: options.now ?? NOON_JST,
      }),
    });
  }

  function tick(now: number) {
    return tickVetoWindows('mission_controller', { now, storageChannels: [CHANNEL] });
  }

  it('refuses a veto window on a human-only decision', () => {
    expect(() =>
      createApprovalRequest('mission_controller', {
        channel: 'chat-1',
        storageChannel: CHANNEL,
        threadTs: '',
        correlationId: 'veto-suite',
        requestedBy: 'agent:test',
        draft: { title: 't', summary: 's' },
        accountability: { finalDecision: 'human_only' },
        veto: buildVetoWindow({ windowMinutes: 10 }),
      })
    ).toThrow(/human-only/);
  });

  it('starts the clock on delivery and proceeds as the policy, not as a human', () => {
    const record = createVetoRequest();
    recordApprovalDeliveryReceipt(
      { correlation_id: approvalDeliveryCorrelationId(record) },
      new Date(NOON_JST + 5 * MINUTE).toISOString()
    );
    const delivered = loadApprovalRequest(CHANNEL, record.id);
    expect(delivered?.veto?.proceedsAt).toBe(new Date(NOON_JST + 125 * MINUTE).toISOString());

    // A duplicate receipt does not restart the clock.
    markApprovalNotificationDelivered('mission_controller', {
      storageChannel: CHANNEL,
      requestId: record.id,
      deliveredAt: new Date(NOON_JST + 60 * MINUTE).toISOString(),
    });
    expect(loadApprovalRequest(CHANNEL, record.id)?.veto?.proceedsAt).toBe(
      delivered?.veto?.proceedsAt
    );

    expect(tick(NOON_JST + 124 * MINUTE).proceeded).toHaveLength(0);
    const result = tick(NOON_JST + 125 * MINUTE);
    expect(result.proceeded.map((entry) => entry.id)).toEqual([record.id]);
    const settled = loadApprovalRequest(CHANNEL, record.id);
    expect(settled).toMatchObject({
      status: 'approved',
      decidedBy: VETO_WINDOW_DECIDER,
      decidedByType: 'service',
      authenticated: false,
    });
  });

  it('never proceeds when the notice was not delivered in time', () => {
    const record = createVetoRequest();
    expect(tick(NOON_JST + 31 * MINUTE).fellBack.map((entry) => entry.id)).toEqual([record.id]);
    // A late delivery cannot revive the veto clock.
    recordApprovalDeliveryReceipt({ correlation_id: approvalDeliveryCorrelationId(record) });
    const later = tick(NOON_JST + 10 * 24 * 60 * MINUTE);
    expect(later.proceeded).toHaveLength(0);
    expect(later.fellBack).toHaveLength(0);
    const stored = loadApprovalRequest(CHANNEL, record.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.veto?.fallback).toBe('undelivered');
    expect(stored?.veto?.proceedsAt).toBeUndefined();
  });

  it('records shadow windows once and leaves the request to a human', () => {
    const record = createVetoRequest({ shadow: true });
    markApprovalNotificationDelivered('mission_controller', {
      storageChannel: CHANNEL,
      requestId: record.id,
      deliveredAt: new Date(NOON_JST).toISOString(),
    });
    expect(tick(NOON_JST + 121 * MINUTE).shadowElapsed).toHaveLength(1);
    expect(tick(NOON_JST + 122 * MINUTE).shadowElapsed).toHaveLength(0);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });

  it('respects an objection made before the deadline', () => {
    const record = createVetoRequest();
    markApprovalNotificationDelivered('mission_controller', {
      storageChannel: CHANNEL,
      requestId: record.id,
      deliveredAt: new Date(NOON_JST).toISOString(),
    });
    decideApprovalRequest('mission_controller', {
      channel: record.channel,
      storageChannel: CHANNEL,
      requestId: record.id,
      decision: 'rejected',
      decidedBy: 'operator',
      decidedByType: 'human',
      authenticated: true,
    });
    const result = tick(NOON_JST + 500 * MINUTE);
    expect(result.proceeded).toHaveLength(0);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('rejected');
  });

  it('ignores receipts that do not name an approval', () => {
    expect(() => recordApprovalDeliveryReceipt({ correlation_id: 'notify:x:1' })).not.toThrow();
    expect(() =>
      recordApprovalDeliveryReceipt({
        correlation_id: `approval:${CHANNEL}:00000000-0000-4000-8000-000000000000`,
      })
    ).not.toThrow();
  });
});
