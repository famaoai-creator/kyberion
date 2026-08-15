import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('protocol service boundary registry', () => {
  it('keeps non-surface services explicitly classified and scoped', () => {
    const registry = JSON.parse(
      safeReadFile('knowledge/product/governance/protocol-service-registry.json', {
        encoding: 'utf8',
      }) as string
    ) as { entries: Array<Record<string, unknown>> };
    const entries = new Map(registry.entries.map((entry) => [String(entry.id), entry]));
    expect(entries.get('peer-messaging')?.classification).toBe('protocol-gateway');
    expect(entries.get('mcp-server-cowork')?.classification).toBe('protocol-gateway');
    expect(entries.get('review-checks')?.classification).toBe('control-plane-worker');
    expect(entries.get('report-review')?.classification).toBe('artifact-review-port');
    for (const entry of entries.values()) {
      expect(entry.process_scope).toBeTruthy();
      expect(entry.request_scope_mode).toBeTruthy();
      expect(entry.binding).toBeTruthy();
      expect(Array.isArray(entry.data_paths)).toBe(true);
    }
  });
});
