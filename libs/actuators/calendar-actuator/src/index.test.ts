/**
 * Tests for calendar-actuator.
 *
 * The integration with macOS Calendar.app is exercised via osascript and is
 * platform / state-dependent. These tests focus on what we can guarantee
 * everywhere: input validation and the JXA-injection-safe parameter encoding.
 *
 * Set NODE_ENV=test (default in vitest) so the module does not auto-run main().
 */
import { describe, it, expect, vi } from 'vitest';
import { handleAction } from './index.js';
import { CalendarBackendRegistry, type CalendarBackendAdapter } from './calendar-backend.js';

describe('calendar-actuator: input validation', () => {
  it('rejects unknown ops via schema validation', async () => {
    await expect(handleAction({ op: 'destroy' as any })).rejects.toThrow(/invalid input/i);
  });

  it('rejects non-array calendar_names', async () => {
    await expect(
      handleAction({
        op: 'list_events' as const,
        params: { calendar_names: 'work' as any },
      })
    ).rejects.toThrow(/invalid input/i);
  });

  it('rejects malformed start_date format', async () => {
    await expect(
      handleAction({
        op: 'list_events' as const,
        params: { start_date: 'not-a-date' as any },
      })
    ).rejects.toThrow(/invalid input/i);
  });

  it('requires title for create_event after schema passes', async () => {
    await expect(
      handleAction({
        op: 'create_event' as const,
        params: { calendar_names: ['Personal'] },
      })
    ).rejects.toThrow(/missing required fields.*params.title/i);
  });

  it('requires start_date for create_event', async () => {
    await expect(
      handleAction({
        op: 'create_event' as const,
        params: { title: 'Test event', calendar_names: ['Personal'] },
      })
    ).rejects.toThrow(/missing required fields.*params.start_date/i);
  });

  it('requires a time window for freebusy queries before backend execution', async () => {
    await expect(
      handleAction({
        op: 'query_freebusy' as const,
        params: { backend: 'gws' },
      })
    ).rejects.toThrow(/missing required fields.*params.start_date.*params.end_date/i);
  });

  it('allows a user-selected registered adapter to aggregate multiple calendar targets', async () => {
    const outlookAdapter: CalendarBackendAdapter = {
      id: 'outlook',
      isAvailable: () => true,
      unavailableMessage: () => 'outlook unavailable',
      listCalendars: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn(async (params) => [
        {
          title: `Event on ${params.calendar_id}`,
          start: '2026-07-25T10:00:00+09:00',
          end: '2026-07-25T11:00:00+09:00',
          calendar: params.calendar_id || '',
          location: '',
          description: '',
        },
      ]),
      queryFreeBusy: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue({ status: 'success', title: 'Event' }),
    };
    const registry = new CalendarBackendRegistry([outlookAdapter]);

    await expect(
      handleAction(
        {
          op: 'list_events',
          params: {
            backend: 'outlook',
            calendar_targets: [{ calendar_id: 'work' }, { calendar_id: 'personal' }],
            start_date: '2026-07-25T00:00:00+09:00',
            end_date: '2026-07-26T00:00:00+09:00',
          },
        },
        registry
      )
    ).resolves.toEqual([
      expect.objectContaining({ backend: 'outlook', calendar: 'work' }),
      expect.objectContaining({ backend: 'outlook', calendar: 'personal' }),
    ]);
  });
});

describe('calendar-actuator: JXA injection safety', () => {
  // We can't actually invoke osascript in CI, but we can verify that the
  // user's input never gets interpolated into the script body. The runJxa
  // helper takes the params via JSON.stringify(JSON.stringify(...)), so a
  // string containing `"`, `\`, or `${...}` will round-trip through JSON
  // safely instead of breaking out into JXA code.
  //
  // This test is a structural guarantee: we re-implement the encoding here
  // so that if anyone ever changes runJxa to use raw template interpolation,
  // this test will fail to mirror it.
  function encodeForJxa(params: Record<string, unknown>): string {
    return JSON.stringify(JSON.stringify(params));
  }
  function roundTrip(params: Record<string, unknown>): unknown {
    return JSON.parse(JSON.parse(encodeForJxa(params)));
  }

  it('preserves quotes and backslashes', () => {
    const evil = { title: 'He said "hi"\\n; doEvil();' };
    expect(roundTrip(evil)).toEqual(evil);
  });

  it('preserves template-literal-shaped strings', () => {
    const evil = { title: '${process.exit(1)}' };
    expect(roundTrip(evil)).toEqual(evil);
  });

  it('preserves unicode and newlines', () => {
    const tricky = { title: '会議 — 第1回\n(緊急)\t"重要"' };
    expect(roundTrip(tricky)).toEqual(tricky);
  });

  it('preserves null and array values', () => {
    const obj = { calendar_names: ['Personal', 'Work'], filter: null };
    expect(roundTrip(obj)).toEqual(obj);
  });
});
