import { describe, expect, it } from 'vitest';
import { describeServiceExternalEffect } from './service-actuator-helpers.js';

// Operator decisions of 2026-11-22: calendar reads (MSN-CALENDAR-RISK-M365-20261122)
// and web search / map lookups (MSN-SEARCH-MAPS-READ-20261122) are declared
// `risk: read`, so an agent runs them without an approval decision. Writes,
// templated-resource operations and other undeclared routes stay gated.
const effect = (service_id: string, action: string) =>
  describeServiceExternalEffect({ service_id, mode: 'PRESET', action } as never);

describe('declared read effect classification', () => {
  it.each([
    ['google-workspace', 'calendar_agenda'],
    ['google-workspace', 'calendar_calendarList_list'],
    ['google-workspace', 'calendar_events_list'],
    ['google-workspace', 'calendar_freebusy_query'],
    ['m365', 'calendar_list'],
    ['m365', 'calendar_view_primary'],
    ['m365', 'calendar_freebusy_query'],
    ['brave-search', 'brave_web_search'],
    ['brave-search', 'brave_local_search'],
    ['google-maps', 'maps_search'],
    ['google-maps', 'maps_geocode'],
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
    // Any SQL, and a db_path the caller chooses (opening a missing file creates it).
    ['sqlite', 'query'],
    ['sqlite', 'list_tables'],
  ])('%s:%s still needs approval', (service, action) => {
    expect(effect(service, action).requiresApproval).toBe(true);
  });
});
