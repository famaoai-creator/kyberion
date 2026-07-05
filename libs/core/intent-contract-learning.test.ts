import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadIntentContractMemorySnapshot,
  refreshIntentContractMemorySnapshot,
  resolveIntentContractMemoryPaths,
  saveIntentContractMemory,
  recordIntentContractOutcome,
} from './intent-contract-learning.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('intent-contract-learning memory snapshot', () => {
  const { runtime: runtimePath } = resolveIntentContractMemoryPaths();
  let originalRuntimeRaw: string | null = null;
  let originalRuntimeExists = false;

  beforeAll(() => {
    originalRuntimeExists = safeExistsSync(runtimePath);
    originalRuntimeRaw = originalRuntimeExists
      ? (safeReadFile(runtimePath, { encoding: 'utf8' }) as string)
      : null;
  });

  beforeEach(() => {
    if (originalRuntimeExists && originalRuntimeRaw !== null) {
      safeWriteFile(runtimePath, originalRuntimeRaw);
    } else if (safeExistsSync(runtimePath)) {
      safeRmSync(runtimePath);
    }
    refreshIntentContractMemorySnapshot();
  });

  afterAll(() => {
    if (originalRuntimeExists && originalRuntimeRaw !== null) {
      safeWriteFile(runtimePath, originalRuntimeRaw);
    } else if (safeExistsSync(runtimePath)) {
      safeRmSync(runtimePath);
    }
    refreshIntentContractMemorySnapshot();
  });

  it('keeps the loaded snapshot stable until an explicit refresh', () => {
    const baseline = loadIntentContractMemorySnapshot();
    const markerIntentId = `snapshot-import-${Date.now().toString(36)}`;
    const nextMemory = {
      version: '1.0.0',
      entries: [
        {
          intent_id: markerIntentId,
          context_fingerprint: { surface: 'cli' },
          contract_ref: { kind: 'direct_reply' as const, ref: 'snapshot-import-test' },
          execution_shape: 'direct_reply',
          success_rate: 1,
          sample_count: 1,
          last_seen: new Date().toISOString(),
        },
      ],
    };

    saveIntentContractMemory(nextMemory);

    const stale = loadIntentContractMemorySnapshot();
    expect(stale).toBe(baseline);
    expect(stale.entries.some((entry) => entry.intent_id === markerIntentId)).toBe(false);

    const refreshed = refreshIntentContractMemorySnapshot();
    expect(refreshed.entries.some((entry) => entry.intent_id === markerIntentId)).toBe(true);
  });

  it('records correlation and mission ids when learning from an outcome', () => {
    const entry = recordIntentContractOutcome({
      intent_id: `learn-${Date.now().toString(36)}`,
      execution_shape: 'task_session',
      contract_ref: { kind: 'direct_reply', ref: 'learn-test' },
      success: true,
      correlation_id: 'corr-learn-001',
      mission_id: 'MSN-LEARN-001',
      context_fingerprint: { surface: 'cli', execution_shape: 'task_session' },
      completion_summary: {
        satisfied: true,
        delivered: ['done'],
        gaps: [],
        next_step: 'none',
        confidence: 1,
        evidence_refs: ['evidence://learn-test'],
      },
    });

    expect(entry.correlation_id).toBe('corr-learn-001');
    expect(entry.mission_id).toBe('MSN-LEARN-001');
    expect(entry.last_seen).toBeTruthy();

    const refreshed = refreshIntentContractMemorySnapshot();
    const stored = refreshed.entries.find((item) => item.intent_id === entry.intent_id);
    expect(stored?.correlation_id).toBe('corr-learn-001');
    expect(stored?.mission_id).toBe('MSN-LEARN-001');
    expect(stored?.completion_summary?.satisfied).toBe(true);
  });
});
