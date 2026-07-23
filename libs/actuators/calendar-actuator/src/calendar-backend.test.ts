import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readGwsAuthStatus: vi.fn(),
  listCalendars: vi.fn(),
  listCalendarAgenda: vi.fn(),
  queryCalendarFreeBusy: vi.fn(),
  createCalendarEvent: vi.fn(),
}));

vi.mock('@agent/core/calendar-workflow', () => ({
  readGwsAuthStatus: mocks.readGwsAuthStatus,
  listCalendars: mocks.listCalendars,
  listCalendarAgenda: mocks.listCalendarAgenda,
  queryCalendarFreeBusy: mocks.queryCalendarFreeBusy,
  createCalendarEvent: mocks.createCalendarEvent,
}));

import {
  CalendarBackendRegistry,
  createDefaultCalendarBackendRegistry,
  type CalendarBackendAdapter,
  selectCalendarBackend,
} from './calendar-backend.js';

describe('calendar backend selection', () => {
  it('prefers JXA on macOS when backend is automatic', () => {
    expect(selectCalendarBackend('auto', 'darwin')).toBe('jxa');
  });

  it('selects gws on non-macOS when it is authenticated', () => {
    expect(selectCalendarBackend('auto', 'linux', { jxa: false, gws: true })).toBe('gws');
  });

  it('returns a setup instruction when gws is unavailable', () => {
    expect(() => selectCalendarBackend('auto', 'linux', { jxa: false, gws: false })).toThrow(
      /gws auth setup.*gws auth login/i
    );
  });

  it('rejects explicit JXA on non-macOS', () => {
    expect(() => selectCalendarBackend('jxa', 'linux', { jxa: false })).toThrow(
      /requires macOS Calendar.app/i
    );
  });

  it('rejects explicit gws when the adapter is unavailable', () => {
    expect(() => selectCalendarBackend('gws', 'linux', { gws: false })).toThrow(
      /gws auth setup.*gws auth login/i
    );
  });

  it('selects a newly registered adapter without changing dispatch code', () => {
    const outlookAdapter: CalendarBackendAdapter = {
      id: 'outlook',
      priority: 1,
      isAvailable: () => true,
      unavailableMessage: () => 'outlook unavailable',
      listCalendars: vi.fn().mockResolvedValue([]),
      listEvents: vi.fn().mockResolvedValue([]),
      queryFreeBusy: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue({ status: 'success', title: 'x' }),
    };
    const registry = new CalendarBackendRegistry([outlookAdapter]);
    expect(registry.resolve('outlook')).toBe(outlookAdapter);
  });
});

describe('gws calendar backend adapter', () => {
  it('maps the existing calendar workflow into the actuator contract', async () => {
    mocks.listCalendars.mockResolvedValue({
      calendars: [{ id: 'primary', summary: 'Work', time_zone: 'Asia/Tokyo' }],
    });
    mocks.listCalendarAgenda.mockResolvedValue({
      calendar_id: 'primary',
      events: [
        {
          summary: 'Planning',
          start: '2026-07-25T10:00:00+09:00',
          end: '2026-07-25T11:00:00+09:00',
          location: '',
        },
      ],
    });
    mocks.queryCalendarFreeBusy.mockResolvedValue({
      calendars: [{ calendar_id: 'primary', busy: [], errors: [] }],
    });
    mocks.createCalendarEvent.mockResolvedValue({
      ok: true,
      created_event: { id: 'event-1', summary: 'Planning' },
    });

    const backend = createDefaultCalendarBackendRegistry().get('gws');
    await expect(backend.listCalendars()).resolves.toEqual([
      { name: 'Work', id: 'primary', time_zone: 'Asia/Tokyo' },
    ]);
    await expect(
      backend.listEvents({
        calendar_id: 'primary',
        start_date: '2026-07-25T00:00:00+09:00',
        end_date: '2026-07-26T00:00:00+09:00',
      })
    ).resolves.toEqual([
      {
        title: 'Planning',
        start: '2026-07-25T10:00:00+09:00',
        end: '2026-07-25T11:00:00+09:00',
        calendar: 'primary',
        location: '',
        description: '',
      },
    ]);
    await expect(
      backend.queryFreeBusy({
        calendar_names: ['primary'],
        start_date: '2026-07-25T09:00:00+09:00',
        end_date: '2026-07-25T18:00:00+09:00',
      })
    ).resolves.toEqual([{ calendar_id: 'primary', busy: [], errors: [] }]);
    await expect(
      backend.createEvent({
        title: 'Planning',
        calendar_id: 'primary',
        start_date: '2026-07-25T10:00:00+09:00',
        end_date: '2026-07-25T11:00:00+09:00',
      })
    ).resolves.toEqual({ status: 'success', title: 'Planning', id: 'event-1' });
  });
});
