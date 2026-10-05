import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import {
  EXCERPT_LENGTH,
  configureConversationSignalRoot,
  listConversationSignals,
  recordConversationSignal,
  resetConversationSignalDedupe,
  summarizeConversationSignals,
} from './conversation-signals.js';

describe('conversation signal ledger', () => {
  let root = '';

  beforeEach(() => {
    root = pathResolver.sharedTmp(`conversation-signals-${process.pid}-${Date.now()}`);
    configureConversationSignalRoot(root);
    resetConversationSignalDedupe();
  });

  afterEach(() => {
    configureConversationSignalRoot(undefined);
    safeRmSync(root, { recursive: true, force: true });
  });

  it('writes nothing under vitest unless a root is configured', () => {
    configureConversationSignalRoot(undefined);
    expect(recordConversationSignal({ kind: 'turn_succeeded', intentId: 'x' })).toBeNull();
    expect(listConversationSignals()).toEqual([]);
  });

  it('stores metadata, a hash and a short excerpt, in a monthly file', () => {
    const long = `${'あ'.repeat(EXCERPT_LENGTH)}いう`;
    const signal = recordConversationSignal({
      kind: 'route_unrecognized',
      utterance: `  ${long}\n  `,
      intentId: 'schedule-read-agenda',
      correlationId: 'corr-1',
      surface: 'slack',
      now: new Date('2026-10-05T10:00:00Z'),
    });
    expect(signal).toMatchObject({
      kind: 'route_unrecognized',
      intent_id: 'schedule-read-agenda',
      correlation_id: 'corr-1',
      surface: 'slack',
      utterance_length: EXCERPT_LENGTH + 2,
    });
    expect(signal?.excerpt).toHaveLength(EXCERPT_LENGTH);
    expect(signal?.utterance_hash).toMatch(/^[0-9a-f]{16}$/u);
    const raw = safeReadFile(path.join(root, '2026-10.jsonl'), { encoding: 'utf8' }) as string;
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(raw).not.toContain('あ'.repeat(EXCERPT_LENGTH + 1));
  });

  it('never records a tenant or isolated turn', () => {
    expect(
      recordConversationSignal({
        kind: 'turn_failed',
        utterance: 'tenant secret plan',
        scope: { tenant_slug: 'acme' },
      })
    ).toBeNull();
    expect(
      recordConversationSignal({ kind: 'turn_failed', utterance: 'x', isolated: true })
    ).toBeNull();
    expect(listConversationSignals()).toEqual([]);
  });

  it('collapses the same route miss written twice within a turn', () => {
    const miss = { kind: 'route_unrouted' as const, utterance: '資料を出して', intentId: 'x' };
    expect(recordConversationSignal(miss)).not.toBeNull();
    expect(recordConversationSignal(miss)).toBeNull();
    expect(recordConversationSignal({ ...miss, intentId: 'y' })).not.toBeNull();
    expect(recordConversationSignal({ kind: 'turn_failed', intentId: 'x' })).not.toBeNull();
    expect(recordConversationSignal({ kind: 'turn_failed', intentId: 'x' })).not.toBeNull();
  });

  it('keeps detail small and flat', () => {
    const signal = recordConversationSignal({
      kind: 'turn_succeeded',
      detail: { note: 'n'.repeat(500), confirmed: true, shape: 'direct_reply' },
    });
    expect(signal?.detail?.note).toHaveLength(120);
    expect(signal?.detail).toMatchObject({ confirmed: true, shape: 'direct_reply' });
  });

  it('lists by time and kind, skipping malformed lines', () => {
    recordConversationSignal({ kind: 'turn_succeeded', now: new Date('2026-10-01T00:00:00Z') });
    recordConversationSignal({ kind: 'turn_failed', now: new Date('2026-10-05T00:00:00Z') });
    expect(listConversationSignals()).toHaveLength(2);
    expect(listConversationSignals({ sinceMs: Date.parse('2026-10-03T00:00:00Z') })).toHaveLength(
      1
    );
    expect(listConversationSignals({ kinds: ['turn_succeeded'] })).toHaveLength(1);
  });

  describe('summarizeConversationSignals', () => {
    it('rolls signals up per intent, clarification rate and repeated misses', () => {
      const miss = 'いつもの資料を出して';
      recordConversationSignal({ kind: 'turn_succeeded', intentId: 'a' });
      recordConversationSignal({ kind: 'turn_failed', intentId: 'a', utterance: 'x1' });
      recordConversationSignal({ kind: 'route_unrecognized', utterance: miss });
      recordConversationSignal({ kind: 'feedback_dissatisfied', intentId: 'a', utterance: miss });
      const old = new Date('2026-10-01T00:00:00Z');
      recordConversationSignal({
        kind: 'clarification_asked',
        intentId: 'a',
        detail: { pending_key: 'k1' },
        now: old,
      });
      recordConversationSignal({
        kind: 'clarification_asked',
        intentId: 'a',
        detail: { pending_key: 'k2' },
        now: old,
      });
      recordConversationSignal({
        kind: 'clarification_answered',
        intentId: 'a',
        detail: { pending_key: 'k1' },
        now: new Date('2026-10-01T01:00:00Z'),
      });
      const summary = summarizeConversationSignals(listConversationSignals(), {
        nowMs: Date.parse('2026-10-05T00:00:00Z'),
      });
      expect(summary.total).toBe(7);
      expect(summary.by_kind.route_unrecognized).toBe(1);
      expect(summary.by_intent[0]).toMatchObject({
        intent_id: 'a',
        turns: 2,
        succeeded: 1,
        failed: 1,
        dissatisfied: 1,
        clarification_asked: 2,
        clarification_abandoned: 1,
      });
      expect(summary.clarification).toEqual({ asked: 2, abandoned: 1, abandon_rate: 0.5 });
      expect(summary.miss_clusters[0]).toMatchObject({ count: 2, excerpt: miss });
      expect(summary.miss_clusters[0].kinds).toEqual(
        expect.arrayContaining(['route_unrecognized', 'feedback_dissatisfied'])
      );
    });

    it('judges a repeated question on the same key by the answer that followed it', () => {
      const key = { pending_key: 'chain' };
      const at = (hour: number) => new Date(`2026-10-01T0${hour}:00:00Z`);
      recordConversationSignal({ kind: 'clarification_asked', detail: key, now: at(1) });
      recordConversationSignal({ kind: 'clarification_answered', detail: key, now: at(2) });
      recordConversationSignal({ kind: 'clarification_asked', detail: key, now: at(3) });
      const summary = summarizeConversationSignals(listConversationSignals(), {
        nowMs: Date.parse('2026-10-05T00:00:00Z'),
      });
      expect(summary.clarification).toEqual({ asked: 2, abandoned: 1, abandon_rate: 0.5 });
    });

    it('does not call a recent unanswered question abandoned yet', () => {
      recordConversationSignal({
        kind: 'clarification_asked',
        detail: { pending_key: 'k9' },
        now: new Date('2026-10-05T00:00:00Z'),
      });
      const summary = summarizeConversationSignals(listConversationSignals(), {
        nowMs: Date.parse('2026-10-05T10:00:00Z'),
      });
      expect(summary.clarification).toEqual({ asked: 1, abandoned: 0, abandon_rate: 0 });
    });

    it('reports no abandon rate when nothing was asked', () => {
      expect(summarizeConversationSignals([]).clarification).toEqual({
        asked: 0,
        abandoned: 0,
        abandon_rate: null,
      });
    });
  });
});
