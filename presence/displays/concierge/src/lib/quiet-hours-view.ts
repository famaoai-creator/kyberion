/** Client-only form and receipt helpers. The server remains the validation authority. */
export type QuietHoursValue = { start: string; end: string; timezone: string };
export type QuietHoursPreferences = {
  quiet_hours: QuietHoursValue | null;
  urgent_events: string[];
};
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
const eventKey = (events: readonly string[]) => JSON.stringify([...new Set(events)].sort());
/** Preserve saved custom choices, rather than silently replacing them with a preset. */
export function presetFromUrgentEvents(events: readonly string[]): UrgentPreset | 'custom' {
  const key = eventKey(events);
  for (const [preset, list] of Object.entries(URGENT_PRESET_EVENTS)) {
    if (eventKey(list) === key) return preset as UrgentPreset;
  }
  return 'custom';
}
/** The API always projects both fields. Absence or malformed data is never an "off" default. */
export function parseQuietHoursResponse(value: unknown): QuietHoursPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.ok !== true ||
    !record.preferences ||
    typeof record.preferences !== 'object' ||
    Array.isArray(record.preferences)
  )
    return undefined;
  const prefs = record.preferences as Record<string, unknown>;
  const q = prefs.quiet_hours;
  let quiet: QuietHoursValue | null = null;
  if (q !== null) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return undefined;
    const r = q as Record<string, unknown>;
    if (
      typeof r.start !== 'string' ||
      !HHMM.test(r.start) ||
      typeof r.end !== 'string' ||
      !HHMM.test(r.end) ||
      typeof r.timezone !== 'string' ||
      !r.timezone.trim()
    )
      return undefined;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: r.timezone });
    } catch {
      return undefined;
    }
    quiet = { start: r.start, end: r.end, timezone: r.timezone };
  }
  if (
    !Array.isArray(prefs.urgent_events) ||
    !prefs.urgent_events.every((event) => typeof event === 'string' && event.length > 0)
  )
    return undefined;
  return { quiet_hours: quiet, urgent_events: [...prefs.urgent_events] as string[] };
}
/** A 2xx receipt must describe the submitted settings before the UI can say "saved". */
export function matchesQuietHoursPreferences(
  actual: QuietHoursPreferences,
  expected: QuietHoursPreferences
): boolean {
  const a = actual.quiet_hours;
  const b = expected.quiet_hours;
  return (
    (a === null
      ? b === null
      : b !== null && a.start === b.start && a.end === b.end && a.timezone === b.timezone) &&
    eventKey(actual.urgent_events) === eventKey(expected.urgent_events)
  );
}
export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
