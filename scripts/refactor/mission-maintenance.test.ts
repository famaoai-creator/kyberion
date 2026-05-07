import { describe, it, expect } from 'vitest';
import { shouldSkipResumeEntry, RESUME_IDEMPOTENCY_WINDOW_MS } from './mission-maintenance.js';

describe('shouldSkipResumeEntry (Phase B-3 idempotency)', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');

  it('returns false for empty history', () => {
    expect(shouldSkipResumeEntry([], now)).toBe(false);
  });

  it('returns false when last event is not RESUME', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:50.000Z', event: 'CHECKPOINT' }],
        now,
      ),
    ).toBe(false);
  });

  it('returns true when last RESUME is within window', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:30.000Z', event: 'RESUME' }], // 30s ago
        now,
      ),
    ).toBe(true);
  });

  it('returns false when last RESUME is past the window', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:58:00.000Z', event: 'RESUME' }], // 2 min ago
        now,
      ),
    ).toBe(false);
  });

  it('returns false at exact window boundary (strictly less than)', () => {
    const exactlyOnBoundary = new Date(now.getTime() - RESUME_IDEMPOTENCY_WINDOW_MS).toISOString();
    expect(
      shouldSkipResumeEntry([{ ts: exactlyOnBoundary, event: 'RESUME' }], now),
    ).toBe(false);
  });

  it('returns false on malformed timestamp', () => {
    expect(
      shouldSkipResumeEntry([{ ts: 'not-a-date', event: 'RESUME' }], now),
    ).toBe(false);
  });

  it('only inspects the LAST entry, not earlier RESUMEs', () => {
    expect(
      shouldSkipResumeEntry(
        [
          { ts: '2026-05-07T11:59:30.000Z', event: 'RESUME' },
          { ts: '2026-05-07T11:59:31.000Z', event: 'CHECKPOINT' },
        ],
        now,
      ),
    ).toBe(false);
  });

  it('coalesces a chain of rapid RESUMEs into one', () => {
    // Simulate: orchestrator restarted 3 times in quick succession.
    // The actual call site only adds an entry when this returns false,
    // so the second and third calls would both see "last is RESUME within window".
    const history: Array<{ ts: string; event: string }> = [];
    const ts1 = new Date(now.getTime() - 50_000).toISOString();
    history.push({ ts: ts1, event: 'RESUME' }); // first one was added

    expect(shouldSkipResumeEntry(history, now)).toBe(true); // 50s ago, within window

    const muchLater = new Date(now.getTime() + 70_000); // 70s later, past window
    expect(shouldSkipResumeEntry(history, muchLater)).toBe(false);
  });

  it('honors a custom window override', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:55.000Z', event: 'RESUME' }], // 5s ago
        now,
        2_000, // 2s window
      ),
    ).toBe(false);
  });
});
