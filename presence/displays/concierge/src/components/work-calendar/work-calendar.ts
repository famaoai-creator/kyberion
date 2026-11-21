/**
 * Pure model of the `/work?tab=calendar` work calendar (MSN-WORK-CALENDAR-20261121,
 * MSN-CALENDAR-SOURCES-20261121): month / week grids of calendar days and the
 * dated entries that fall on them — work items, organization operation runs
 * and deadlines, and meeting action items (`workspace.calendar`). Dates are `YYYY-MM-DD` calendar days (WorkItem `start_date` /
 * `due_date`), so every computation runs on UTC day numbers — no timezone can
 * move an item to a neighbouring day. "Today" is the viewer's local day.
 *
 * Client-safe: no imports beyond the board's due-state rules.
 */
import { dueState, type DueState } from '../work-board/work-item-board';

export type CalendarView = 'month' | 'week';

export type CalendarSource =
  | 'work_item'
  | 'operation_run'
  | 'operation_deadline'
  | 'action_item'
  /** An event in the installation owner's own (Google / Microsoft 365) calendar. */
  | 'external_event';

/** Toggle groups: an operation's runs and deadlines show or hide together. */
export type CalendarSourceGroup = 'work_item' | 'operation' | 'action_item' | 'external';

export const CALENDAR_SOURCE_GROUPS: readonly CalendarSourceGroup[] = [
  'work_item',
  'operation',
  'action_item',
  'external',
];

export function sourceGroup(source: CalendarSource | undefined): CalendarSourceGroup {
  return source === 'operation_run' || source === 'operation_deadline'
    ? 'operation'
    : source === 'action_item'
      ? 'action_item'
      : source === 'external_event'
        ? 'external'
        : 'work_item';
}

/** An appointment, not a task: it is never due, overdue or counted in the summary. */
export function isAppointment(item: Pick<CalendarItem, 'source'>): boolean {
  return item.source === 'external_event';
}

/** One event from `/api/calendar/external`. */
export interface ExternalCalendarEvent {
  id: string;
  title: string;
  /** ISO instant, or `YYYY-MM-DD` for an all-day event. */
  start: string;
  end?: string;
  allDay: boolean;
  link?: string;
}

/** External events as calendar items, on the viewer's local start day. */
/**
 * The command that signs the provider's CLI in again, shown when the stored
 * login expired. Only `gws` reports an expired login today; another provider
 * shows none.
 */
export function providerReloginCommand(provider: string | null | undefined): string | null {
  if (provider === 'google-workspace') return 'gws auth login';
  return null;
}

export function fromExternalEvents(events: readonly ExternalCalendarEvent[]): CalendarItem[] {
  return events.flatMap((event) => {
    const day = event.allDay ? event.start.slice(0, 10) : localDayOfInstant(event.start);
    if (!day) return [];
    return [
      {
        id: `external_event:${event.id}`,
        title: event.title,
        status: 'open',
        dueDate: day,
        ...(event.link ? { href: event.link } : {}),
        source: 'external_event' as const,
      },
    ];
  });
}

function localDayOfInstant(instant: string): string | undefined {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? undefined : localCalendarDate(date);
}

export interface CalendarItem {
  id: string;
  title: string;
  status: string;
  startDate?: string;
  dueDate?: string;
  href?: string;
  /** Where the entry comes from (absent: a work item). */
  source?: CalendarSource;
  /** A deadline that was missed. */
  missed?: boolean;
}

/** One `workspace.calendar` entry, as the API returns it. */
export interface CalendarApiEntry {
  source: CalendarSource;
  id: string;
  title: string;
  date: string;
  startDate?: string;
  /** Work items: the due day (a start-only item has none). */
  dueDate?: string;
  /** Timed action items: the instant; its local day is the viewer's own. */
  dueAt?: string;
  done: boolean;
  missed?: boolean;
  link: { kind: 'work_item' | 'organization' | 'mission'; id: string };
  tenantSlug?: string;
}

/** The viewer's local day of an instant, or undefined for an invalid one. */
function localDayOf(instant: string): string | undefined {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? undefined : localCalendarDate(date);
}

/**
 * API entries as calendar items. A work item keeps its own start / due days (a
 * start-only item is never due); a timed action item falls on the viewer's
 * local day; everything else is due on its day. Done entries read as finished.
 */
export function fromCalendarEntries(
  entries: readonly CalendarApiEntry[],
  hrefFor: (link: CalendarApiEntry['link'], tenantSlug?: string) => string | undefined
): CalendarItem[] {
  return entries.map((entry) => {
    const href = hrefFor(entry.link, entry.tenantSlug);
    const dueDate =
      entry.source === 'work_item'
        ? entry.dueDate
        : entry.dueAt
          ? (localDayOf(entry.dueAt) ?? entry.date)
          : entry.date;
    return {
      id: entry.id,
      title: entry.title,
      status: entry.done ? 'done' : 'open',
      ...(dueDate ? { dueDate } : {}),
      ...(entry.startDate ? { startDate: entry.startDate } : {}),
      ...(href ? { href } : {}),
      source: entry.source,
      ...(entry.missed ? { missed: true } : {}),
    };
  });
}

export interface CalendarEntry<T extends CalendarItem = CalendarItem> {
  item: T;
  /** `due`: the item is due this day. `span`: a day between its start and due (week view). */
  role: 'due' | 'start' | 'span';
  due: DueState;
}

export interface CalendarDay<T extends CalendarItem = CalendarItem> {
  date: string;
  day: number;
  /** False for the leading / trailing days of a month grid. */
  inRange: boolean;
  isToday: boolean;
  isWeekend: boolean;
  entries: CalendarEntry<T>[];
}

export interface CalendarGrid<T extends CalendarItem = CalendarItem> {
  view: CalendarView;
  /** The anchor day the grid was built around (`YYYY-MM-DD`). */
  anchor: string;
  weeks: CalendarDay<T>[][];
  /** First and last day shown. */
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

function toDayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function fromDayNumber(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

/** The viewer's local calendar day as `YYYY-MM-DD`. */
export function localCalendarDate(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Same day of month `months` later, clamped to that month's last day. */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Monday-first weekday index (0 = Monday … 6 = Sunday). */
function mondayIndex(date: string): number {
  return (new Date(toDayNumber(date) * DAY_MS).getUTCDay() + 6) % 7;
}

export function startOfWeek(date: string): string {
  return addDays(date, -mondayIndex(date));
}

/** One grid step back (-1) or forward (+1) in the given view. */
export function shiftAnchor(anchor: string, view: CalendarView, step: -1 | 1): string {
  return view === 'month' ? addMonths(anchor, step) : addDays(anchor, 7 * step);
}

function entriesFor<T extends CalendarItem>(
  items: readonly T[],
  date: string,
  view: CalendarView,
  today: string
): CalendarEntry<T>[] {
  const entries: CalendarEntry<T>[] = [];
  for (const item of items) {
    const due: DueState = isAppointment(item)
      ? { state: 'none' }
      : dueState(item.dueDate, item.status, today);
    if (item.dueDate === date) {
      entries.push({ item, role: 'due', due });
    } else if (item.startDate === date) {
      entries.push({ item, role: 'start', due });
    } else if (
      view === 'week' &&
      item.startDate &&
      item.dueDate &&
      item.startDate < date &&
      date < item.dueDate
    ) {
      entries.push({ item, role: 'span', due });
    }
  }
  const rank: Record<CalendarEntry['role'], number> = { due: 0, start: 1, span: 2 };
  const urgency: Record<DueState['state'], number> = {
    overdue: 0,
    due_today: 1,
    due_soon: 2,
    upcoming: 3,
    none: 4,
    done: 5,
  };
  return entries.sort(
    (left, right) =>
      rank[left.role] - rank[right.role] ||
      urgency[left.due.state] - urgency[right.due.state] ||
      left.item.title.localeCompare(right.item.title)
  );
}

/**
 * A month grid (whole Monday-first weeks covering the anchor's month) or a
 * single week, with each day's entries. Month cells list due and start days;
 * the week view also marks the days an item is underway.
 */
/** First and last day a grid shows: whole Monday-first weeks of the month, or one week. */
export function calendarGridRange(
  view: CalendarView,
  anchor: string
): { from: string; to: string } {
  const monthPrefix = anchor.slice(0, 7);
  const from = view === 'month' ? startOfWeek(`${monthPrefix}-01`) : startOfWeek(anchor);
  const to =
    view === 'month'
      ? addDays(startOfWeek(addDays(addMonths(`${monthPrefix}-01`, 1), -1)), 6)
      : addDays(from, 6);
  return { from, to };
}

export function buildCalendarGrid<T extends CalendarItem>(
  items: readonly T[],
  options: { view: CalendarView; anchor: string; today: string }
): CalendarGrid<T> {
  const { view, anchor, today } = options;
  const monthPrefix = anchor.slice(0, 7);
  const { from: first, to: last } = calendarGridRange(view, anchor);
  const dated = items.filter((item) => item.dueDate || item.startDate);
  const weeks: CalendarDay<T>[][] = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 1)) {
    if (mondayIndex(cursor) === 0) weeks.push([]);
    const weekday = mondayIndex(cursor);
    weeks[weeks.length - 1].push({
      date: cursor,
      day: Number(cursor.slice(8, 10)),
      inRange: view === 'week' || cursor.startsWith(monthPrefix),
      isToday: cursor === today,
      isWeekend: weekday >= 5,
      entries: entriesFor(dated, cursor, view, today),
    });
  }
  return { view, anchor, weeks, from: first, to: last };
}

export interface CalendarSummary<T extends CalendarItem = CalendarItem> {
  /** Open items whose due day has passed, oldest first. */
  overdue: T[];
  /** Open items due today or in the next two days. */
  dueSoon: T[];
}

export function summarizeCalendar<T extends CalendarItem>(
  items: readonly T[],
  today: string
): CalendarSummary<T> {
  const overdue: T[] = [];
  const dueSoon: T[] = [];
  for (const item of items) {
    if (isAppointment(item)) continue;
    const state = dueState(item.dueDate, item.status, today).state;
    if (state === 'overdue') overdue.push(item);
    else if (state === 'due_today' || state === 'due_soon') dueSoon.push(item);
  }
  const byDue = (left: T, right: T) => (left.dueDate ?? '').localeCompare(right.dueDate ?? '');
  return { overdue: overdue.sort(byDue), dueSoon: dueSoon.sort(byDue) };
}
