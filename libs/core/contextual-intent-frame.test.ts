import { beforeEach, describe, expect, it } from 'vitest';
import { safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { recordSchedulePreference } from './contextual-intent-memory.js';

describe('contextual-intent-frame', () => {
  const memoryPath = pathResolver.shared('runtime/test-contextual-intent-memory.json');

  beforeEach(() => {
    process.env.KYBERION_CONTEXTUAL_INTENT_MEMORY_PATH = memoryPath;
    safeRmSync(memoryPath);
  });

  it('infers a read-only agenda frame from a terse Japanese utterance', () => {
    const frame = buildContextualIntentFrame('来週の予定教えて');
    expect(frame.kind).toBe('contextual_intent_frame');
    expect(frame.action).toBe('read');
    expect(frame.object).toBe('calendar_events');
    expect(frame.subject).toBe('operator_self');
    expect(frame.date_range?.value).toBe('next_week');
    expect(frame.source_binding.selected).toBe('browser_calendar');
    expect(frame.missing).toEqual([]);
  });

  it('reuses a learned default calendar source when it has been recorded', () => {
    recordSchedulePreference({
      source: 'google_calendar',
      calendarName: 'Personal',
      utterance: '来週の予定教えて',
      confirmed: true,
    });

    const frame = buildContextualIntentFrame('来週の予定教えて');
    expect(frame.source_binding.selected).toBe('google_calendar');
    expect(frame.missing).not.toContain('calendar_source');
  });
});
