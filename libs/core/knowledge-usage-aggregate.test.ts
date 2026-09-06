import { afterEach, describe, expect, it } from 'vitest';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  loadKnowledgeUsageAggregateAtPath,
  writeKnowledgeUsageAggregateAtPath,
  type KnowledgeUsageAggregateEntry,
} from './knowledge-usage-aggregate.js';

const TEST_ROOT = pathResolver.sharedTmp(`knowledge-usage-aggregate-test/${process.pid}`);
const TEST_PATH = `${TEST_ROOT}/usage.json`;

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('knowledge usage aggregate contract', () => {
  it('round-trips a schema-valid aggregate through the canonical writer and reader', () => {
    const entry: KnowledgeUsageAggregateEntry = {
      document_path: 'knowledge/product/runbook.md',
      delivered_count: 2,
      used_count: 1,
      not_used_count: 0,
      occurrences: 2,
      last_seen: '2026-09-03T00:00:00.000Z',
    };
    writeKnowledgeUsageAggregateAtPath(TEST_PATH, [entry]);
    expect(loadKnowledgeUsageAggregateAtPath(TEST_PATH)).toEqual([entry]);
  });

  it('returns an empty aggregate when the resource is missing', () => {
    expect(loadKnowledgeUsageAggregateAtPath(TEST_PATH)).toEqual([]);
  });

  it('rejects malformed entries and directories', () => {
    safeWriteFile(TEST_PATH, JSON.stringify([{ document_path: 'missing-counters' }]));
    expect(() => loadKnowledgeUsageAggregateAtPath(TEST_PATH)).toThrow('Invalid catalog');
    expect(() => loadKnowledgeUsageAggregateAtPath(TEST_ROOT)).toThrow(
      '[KNOWLEDGE_USAGE] aggregate must be a regular file'
    );
  });
});
