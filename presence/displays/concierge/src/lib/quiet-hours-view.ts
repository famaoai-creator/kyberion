/**
 * Pure helpers behind the settings "おやすみ時間" (quiet hours) pane.
 * No I/O and no `t()` — the pane component owns fetching and translation.
 * The server (`/api/notification-preferences` → operator-notifications) is the
 * single validation authority; this only shapes the form and does a cheap
 * pre-check so an obviously malformed value never leaves the browser.
 */

export type QuietHoursValue = { start: string; end: string; timezone: string };

export type UrgentPreset = 'alerts_only' | 'alerts_approvals' | 'alerts_approvals_questions';

export const URGENT_PRESET_EVENTS: Record<UrgentPreset, string[]> = {
  alerts_only: ['ops_alert'],
  alerts_approvals: ['ops_alert', 'approval_required'],
  alerts_approvals_questions: ['ops_alert', 'approval_required', 'question'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidQuietHoursInput(value: QuietHoursValue): boolean {
  return (
    HHMM.test(value.start) &&
    HHMM.test(value.end) &&
    value.start !== value.end &&
    value.timezone.trim().length > 0 &&
    !/\s/.test(value.timezone.trim())
  );
}

/** Maps a saved event list back to a preset; an unrecognized list falls back to the safest (alerts only). */
export function presetFromUrgentEvents(events: readonly string[]): UrgentPreset {
  const key = [...new Set(events)].sort().join(',');
  for (const [preset, list] of Object.entries(URGENT_PRESET_EVENTS)) {
    if ([...list].sort().join(',') === key) return preset as UrgentPreset;
  }
  return 'alerts_only';
}

export function parseQuietHoursResponse(
  value: unknown
): { quiet_hours: QuietHoursValue | null; urgent_events: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !record.preferences || typeof record.preferences !== 'object') {
    return undefined;
  }
  const prefs = record.preferences as Record<string, unknown>;
  const q = prefs.quiet_hours;
  let quiet: QuietHoursValue | null = null;
  if (q !== null && q !== undefined) {
    const r = q as Record<string, unknown>;
    if (
      typeof q !== 'object' ||
      typeof r.start !== 'string' ||
      typeof r.end !== 'string' ||
      typeof r.timezone !== 'string'
    ) {
      return undefined;
    }
    quiet = { start: r.start, end: r.end, timezone: r.timezone };
  }
  const urgent = Array.isArray(prefs.urgent_events)
    ? prefs.urgent_events.filter((e): e is string => typeof e === 'string')
    : ['ops_alert'];
  return { quiet_hours: quiet, urgent_events: urgent };
}

/** The browser's own IANA zone, used only to prefill a new window. */
export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
