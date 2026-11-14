import { describe, expect, it } from 'vitest';
import { evaluateLegacyQuarantine } from './watch_knowledge_scope_health.js';

describe('knowledge scope health legacy quarantine policy', () => {
  it('raises a TTL breach for an old unscoped file', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    const result = evaluateLegacyQuarantine(
      [{ path: 'legacy.jsonl', mtime_ms: now - 15 * 86_400_000 }],
      now,
      14
    );
    expect(result).toMatchObject({ count: 1, oldest_age_days: 15, ttl_breached: true });
  });

  it('does not alert when no legacy file exceeds the configured TTL', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    const result = evaluateLegacyQuarantine(
      [{ path: 'legacy.jsonl', mtime_ms: now - 14 * 86_400_000 }],
      now,
      14
    );
    expect(result.ttl_breached).toBe(false);
  });
});
