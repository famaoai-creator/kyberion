import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  clearPendingIntent,
  getPendingIntentPath,
  loadPendingIntent,
  savePendingIntent,
} from './pending-intent-store.js';
import { isCorrectionUtterance } from './correction-detection.js';

function cleanupPendingIntentStore() {
  const dir = pathResolver.sharedTmp('pending-intents');
  if (safeExistsSync(dir)) {
    safeRmSync(dir, { recursive: true, force: true });
  }
}

describe('pending-intent-store', () => {
  beforeEach(() => {
    cleanupPendingIntentStore();
  });

  it('saves, loads, and clears pending intents by correlation id', () => {
    const record = savePendingIntent({
      correlation_id: 'corr-pending-001',
      source_text: 'この依頼をまとめて',
      intent_id: 'summarize-request',
      required_inputs: ['audience', 'format'],
      source_surface: 'presence',
      thread_context: 'Prior context',
    });

    expect(getPendingIntentPath('corr-pending-001')).toContain('pending-intents');
    expect(loadPendingIntent('corr-pending-001')?.source_text).toBe(record.source_text);
    expect(loadPendingIntent('corr-pending-001')?.required_inputs).toEqual(['audience', 'format']);

    clearPendingIntent('corr-pending-001');
    expect(loadPendingIntent('corr-pending-001')).toBeNull();
  });

  it('expires stale pending intents on read', () => {
    savePendingIntent({
      correlation_id: 'corr-pending-expired',
      source_text: '古い依頼',
      required_inputs: [],
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(loadPendingIntent('corr-pending-expired')).toBeNull();
  });

  it('removes malformed pending intents when read fails normalization', () => {
    const correlationId = 'corr-pending-invalid';
    safeWriteFile(
      getPendingIntentPath(correlationId),
      JSON.stringify({
        kind: 'pending-intent',
        correlation_id: correlationId,
      })
    );

    expect(loadPendingIntent(correlationId)).toBeNull();
    expect(safeExistsSync(getPendingIntentPath(correlationId))).toBe(false);
  });

  it('treats strong correction utterances as corrections', () => {
    expect(isCorrectionUtterance('違う、そこじゃない')).toBe(true);
    expect(isCorrectionUtterance('No, not like that')).toBe(true);
    expect(isCorrectionUtterance('ありがとう')).toBe(false);
  });
});
