import { describe, expect, it } from 'vitest';
import { buildContextualIntentFrame, validateContextualIntentFrame } from './contextual-intent-frame.js';

describe('contextual-intent-frame schema', () => {
  it('validates a representative read-only frame', () => {
    const frame = buildContextualIntentFrame('来週の予定教えて');
    const result = validateContextualIntentFrame(frame);
    expect(result.valid, JSON.stringify(result.errors || [])).toBe(true);
    expect(result.value?.kind).toBe('contextual_intent_frame');
  });

  it('rejects malformed frames with missing required fields', () => {
    const result = validateContextualIntentFrame({
      kind: 'contextual_intent_frame',
      source_text: '来週の予定教えて',
      locale: 'ja-JP',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
