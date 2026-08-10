import { describe, it, expect } from 'vitest';
import { isStimulusExpired, stimulusTtlSeconds } from './stimuli-journal.js';

/**
 * EV-04: TTL was declared on stimuli but never enforced. It mattered because
 * `dynamic-permission-guard` opens a temporary write grant while an "alert"
 * context is active — an unenforced TTL there is a grant that does not close.
 *
 * Two producers write different shapes to the same journal: nerve-bridge writes
 * `metadata.ttl`, the surface ingress path writes a top-level `ttl`. Enforcement
 * must not depend on which one wrote the record.
 */
describe('stimulus TTL (EV-04)', () => {
  const nowMs = Date.parse('2026-08-10T12:00:00Z');
  const at = (isoOffsetSeconds: number) => new Date(nowMs - isoOffsetSeconds * 1000).toISOString();

  it('両方の shape から TTL を読む', () => {
    expect(stimulusTtlSeconds({ metadata: { ttl: 60 } })).toBe(60);
    expect(stimulusTtlSeconds({ ttl: 3600 })).toBe(3600);
  });

  it('TTL 未宣言・非正値は「無期限」として扱う（nexus-daemon と同一規約）', () => {
    expect(stimulusTtlSeconds({})).toBe(0);
    expect(stimulusTtlSeconds({ ttl: 0 })).toBe(0);
    expect(stimulusTtlSeconds({ ttl: -5 })).toBe(0);
    expect(isStimulusExpired({ ts: at(99999) }, nowMs)).toBe(false);
  });

  it('宣言 TTL を過ぎた刺激は期限切れ', () => {
    expect(isStimulusExpired({ ts: at(120), metadata: { ttl: 60 } }, nowMs)).toBe(true);
    expect(isStimulusExpired({ ts: at(30), metadata: { ttl: 60 } }, nowMs)).toBe(false);
    expect(isStimulusExpired({ ts: at(7200), ttl: 3600 }, nowMs)).toBe(true);
    expect(isStimulusExpired({ ts: at(1800), ttl: 3600 }, nowMs)).toBe(false);
  });

  it('ts が解釈できない場合は期限切れにしない（判定不能を破棄にしない）', () => {
    expect(isStimulusExpired({ ts: 'not-a-date', ttl: 60 }, nowMs)).toBe(false);
    expect(isStimulusExpired({ ttl: 60 }, nowMs)).toBe(false);
  });

  it('null / 非オブジェクトでも例外にならない', () => {
    expect(isStimulusExpired(null, nowMs)).toBe(false);
    expect(isStimulusExpired(undefined, nowMs)).toBe(false);
    expect(stimulusTtlSeconds(null)).toBe(0);
  });
});
