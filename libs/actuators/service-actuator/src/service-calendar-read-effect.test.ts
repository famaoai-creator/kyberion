import { describe, expect, it } from 'vitest';
import { describeServiceExternalEffect } from './service-actuator-helpers.js';

// Operator decision 2026-11-22 (MSN-CALENDAR-RISK-M365-20261122): calendar
// reads are declared `risk: read`, so an agent reads a calendar without an
// approval decision. Calendar writes and other CLI operations stay gated.
const effect = (service_id: string, action: string) =>
  describeServiceExternalEffect({ service_id, mode: 'PRESET', action } as never);

describe('calendar read effect classification', () => {
  it.each([
    ['google-workspace', 'calendar_agenda'],
    ['google-workspace', 'calendar_calendarList_list'],
    ['google-workspace', 'calendar_events_list'],
    ['google-workspace', 'calendar_freebusy_query'],
    ['m365', 'calendar_list'],
    ['m365', 'calendar_view_primary'],
    ['m365', 'calendar_freebusy_query'],
  ])('%s:%s needs no approval', (service, action) => {
    expect(effect(service, action).requiresApproval).toBe(false);
  });

  it.each([
    ['google-workspace', 'calendar_events_insert'],
    ['google-workspace', 'calendar_events_delete'],
    ['google-workspace', 'drive_files_list'],
    ['google-workspace', 'gmail_send'],
    ['m365', 'calendar_events_update'],
    // Its Graph path is a parameter (`me/messages?x=` would read mail): gated.
    ['m365', 'calendar_events_list'],
    ['m365', 'outlook_messages_list'],
  ])('%s:%s still needs approval', (service, action) => {
    expect(effect(service, action).requiresApproval).toBe(true);
  });
});
