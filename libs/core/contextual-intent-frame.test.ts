import { beforeEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import {
  recordSchedulePreference,
  saveContextualIntentMemory,
} from './contextual-intent-memory.js';

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

  it('rejects an external memory path override before writing', () => {
    process.env.KYBERION_CONTEXTUAL_INTENT_MEMORY_PATH = '/tmp/contextual-intent-memory.json';
    expect(() =>
      recordSchedulePreference({ source: 'google_calendar', calendarName: 'Personal' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('fails closed for schema-invalid and non-regular memory files', () => {
    safeWriteFile(
      memoryPath,
      JSON.stringify({ version: '1.0.0', schedule: { default_calendar_source: 'unknown' } }),
      { encoding: 'utf8' }
    );
    expect(buildContextualIntentFrame('来週の予定教えて').source_binding.selected).toBe(
      'browser_calendar'
    );

    safeRmSync(memoryPath, { recursive: true, force: true });
    safeMkdir(memoryPath, { recursive: true });
    expect(buildContextualIntentFrame('来週の予定教えて').source_binding.selected).toBe(
      'browser_calendar'
    );
  });

  it('rejects schema-invalid memory before persisting it', () => {
    expect(() =>
      saveContextualIntentMemory({
        version: '1.0.0',
        schedule: {
          default_calendar_source: 'unknown' as 'google_calendar',
        },
      })
    ).toThrow(/Invalid catalog contextual-intent-memory/);
  });
});
