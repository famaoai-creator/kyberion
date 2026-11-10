import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as io from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import type { KnowledgeUsageAggregateEntry } from './knowledge-usage-aggregate.js';
import { computeMemoryLoopHealth, formatMemoryLoopHealthLine } from './memory-loop-health.js';

const ROOT = pathResolver.sharedTmp(`memory-loop-health-${process.pid}`);
const NOW = new Date('2026-11-10T00:00:00.000Z');
const PRODUCT = 'knowledge/product/evolution/wisdom/generated/mem-A.md';
const PRODUCT_B = 'knowledge/product/evolution/operations/generated/mem-B.md';

function write(relPath: string): void {
  const abs = path.join(ROOT, relPath);
  io.safeMkdir(path.dirname(abs), { recursive: true });
  io.safeWriteFile(abs, '# lesson\n');
}

function entry(
  document_path: string,
  fields: Partial<KnowledgeUsageAggregateEntry>
): KnowledgeUsageAggregateEntry {
  return {
    document_path,
    delivered_count: 0,
    used_count: 0,
    not_used_count: 0,
    occurrences: 1,
    last_seen: NOW.toISOString(),
    ...fields,
  };
}

beforeAll(() => {
  write(PRODUCT);
  write(PRODUCT_B);
  write('knowledge/product/evolution/distill_legacy_2026_01_01.md');
});
afterAll(() => io.safeRmSync(ROOT, { recursive: true, force: true }));

describe('memory loop health', () => {
  it('counts promoted → retrieved → used within the window, ignoring non-promoted docs', () => {
    const health = computeMemoryLoopHealth({
      now: NOW,
      rootDir: ROOT,
      loadAggregate: () => [
        entry(PRODUCT, {
          delivered_count: 3,
          used_count: 1,
          last_delivered_at: '2026-11-09T00:00:00.000Z',
          last_used_at: '2026-11-09T00:00:00.000Z',
        }),
        // Delivered long ago: outside the window.
        entry(PRODUCT_B, { delivered_count: 2, last_delivered_at: '2026-01-01T00:00:00.000Z' }),
        entry('knowledge/product/governance/working-philosophy.md', { delivered_count: 9 }),
      ],
    });
    expect(health).toMatchObject({ promoted: 2, retrieved: 1, used: 1, window_days: 28 });
    expect(health.warning).toBeUndefined();
    expect(formatMemoryLoopHealthLine(health)).toBe(
      'memory_loop: promoted 2 → retrieved 1 → used 1 (last 28 days)'
    );
  });

  it('warns (without failing) when promoted records never reach a context pack', () => {
    const health = computeMemoryLoopHealth({ now: NOW, rootDir: ROOT, loadAggregate: () => [] });
    expect(health).toMatchObject({ promoted: 2, retrieved: 0, used: 0 });
    expect(health.warning).toMatch(/^memory loop open — 2 promoted record\(s\)/);
  });

  it('stays quiet when nothing has been promoted', () => {
    const empty = pathResolver.sharedTmp(`memory-loop-health-empty-${process.pid}`);
    const health = computeMemoryLoopHealth({ now: NOW, rootDir: empty, loadAggregate: () => [] });
    expect(health).toMatchObject({ promoted: 0, retrieved: 0, used: 0 });
    expect(health.warning).toBeUndefined();
  });
});
