'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useWorkspaceResource } from '../../lib/use-workspace-resource';
import { entityHref, listQueryFromSearch, workspaceApiPath } from '../../lib/workspace-view';
import { LoadErrorState, LoadingState, type Translate } from '../../app/w/workspace-parts';
import {
  CALENDAR_SOURCE_GROUPS,
  addDays,
  buildCalendarGrid,
  calendarGridRange,
  fromCalendarEntries,
  localCalendarDate,
  shiftAnchor,
  sourceGroup,
  startOfWeek,
  summarizeCalendar,
  type CalendarApiEntry,
  type CalendarDay,
  type CalendarEntry,
  type CalendarSourceGroup,
  type CalendarView,
} from './work-calendar';
import './work-calendar.css';

/** Entries a month cell shows before "+N more". */
const MONTH_CELL_ENTRIES = 3;

type CalendarData = { entries: CalendarApiEntry[]; degraded: string[] };

function utcDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' });
  }
}

/**
 * `/work?tab=calendar` — every dated thing the viewer may see, on a month or
 * week grid: work-item start / due days, organization operation runs and
 * monthly deadlines, and meeting action items. Entries come from
 * `workspace.calendar` for exactly the days on screen; that operation reads
 * only organizations and missions in the viewer's graph, and URL scope
 * narrowing (tenant / organization / project / mission) applies too. The
 * calendar only reads: dates are set where each entry is managed.
 */
export function WorkCalendar({ t }: { t: Translate }) {
  const { locale: uiLocale } = useConciergeI18n();
  const locale = localeToBcp47(uiLocale);
  const searchParams = useSearchParams();
  const scope = React.useMemo(() => {
    const {
      q: _q,
      status: _status,
      actor_id: _actor,
      ...narrowing
    } = listQueryFromSearch(new URLSearchParams(searchParams?.toString() ?? ''));
    return narrowing;
  }, [searchParams]);

  const today = localCalendarDate();
  const [view, setView] = React.useState<CalendarView>('month');
  const [anchor, setAnchor] = React.useState(today);
  const [shownGroups, setShownGroups] = React.useState<ReadonlySet<CalendarSourceGroup>>(
    () => new Set(CALENDAR_SOURCE_GROUPS)
  );
  const range = calendarGridRange(view, anchor);
  const resource = useWorkspaceResource<CalendarData>(
    workspaceApiPath('calendar', { from: range.from, to: range.to, ...scope })
  );
  // Moving to the next month keeps the last grid on screen while it loads.
  const lastReady = React.useRef<CalendarData | null>(null);
  if (resource.state === 'ready') lastReady.current = resource.data;
  // After a failed load the old range's entries would sit under the new grid: show none.
  const data =
    resource.state === 'ready'
      ? resource.data
      : resource.state === 'error'
        ? null
        : lastReady.current;

  const items = React.useMemo(
    () =>
      fromCalendarEntries(data?.entries ?? [], (link) => entityHref(link.kind, link.id)).filter(
        (item) => shownGroups.has(sourceGroup(item.source))
      ),
    [data, shownGroups]
  );
  const grid = React.useMemo(
    () => buildCalendarGrid(items, { view, anchor, today }),
    [items, view, anchor, today]
  );
  const summary = React.useMemo(() => summarizeCalendar(items, today), [items, today]);

  const monthTitle = formatter(locale, { year: 'numeric', month: 'long' });
  const shortDay = formatter(locale, { month: 'short', day: 'numeric' });
  const longDay = formatter(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  const weekdayName = formatter(locale, { weekday: 'short' });
  const weekStart = startOfWeek(anchor);
  const title =
    view === 'month'
      ? monthTitle.format(utcDate(anchor))
      : `${shortDay.format(utcDate(weekStart))} – ${shortDay.format(utcDate(addDays(weekStart, 6)))}`;
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    weekdayName.format(utcDate(addDays(weekStart, index)))
  );

  const roleLabel = (entry: CalendarEntry) => {
    if (entry.role === 'start') return t('ia_shell_work_cal_start');
    if (entry.role === 'span') return t('ia_shell_work_cal_underway');
    switch (entry.item.source) {
      case 'operation_run':
        return t('ia_shell_work_cal_run');
      case 'operation_deadline':
        return t('ia_shell_work_cal_deadline');
      case 'action_item':
        return t('ia_shell_work_cal_action');
      default:
        return t('ia_shell_work_cal_due');
    }
  };

  const toggleGroup = (group: CalendarSourceGroup) =>
    setShownGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  const renderDay = (day: CalendarDay) => {
    const limit = view === 'month' ? MONTH_CELL_ENTRIES : Infinity;
    const shown = day.entries.slice(0, limit);
    const hidden = day.entries.length - shown.length;
    return (
      <li
        key={day.date}
        className="wc-day"
        data-in-range={day.inRange ? undefined : 'false'}
        data-today={day.isToday ? 'true' : undefined}
        data-weekend={day.isWeekend ? 'true' : undefined}
        data-empty={day.entries.length === 0 ? 'true' : undefined}
        aria-label={t('ia_shell_work_cal_day_label', {
          date: longDay.format(utcDate(day.date)),
          count: day.entries.length,
        })}
      >
        <p className="wc-day__head" aria-hidden="true">
          <span className="wc-day__weekday">{weekdayName.format(utcDate(day.date))}</span>
          <span className="wc-day__number">{day.day}</span>
        </p>
        {shown.length ? (
          <ul className="wc-day__entries">
            {shown.map((entry) => (
              <li
                key={`${entry.item.id}:${entry.role}`}
                className="wc-entry"
                data-role={entry.role}
                data-source={sourceGroup(entry.item.source)}
                data-due={entry.role === 'due' ? entry.due.state : undefined}
              >
                <span className="wc-entry__role">{roleLabel(entry)}</span>
                {entry.item.href ? (
                  <a href={entry.item.href} title={entry.item.title}>
                    {entry.item.title}
                  </a>
                ) : (
                  <span title={entry.item.title}>{entry.item.title}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {hidden > 0 ? (
          <button
            type="button"
            className="wc-day__more"
            onClick={() => {
              setAnchor(day.date);
              setView('week');
            }}
          >
            {t('ia_shell_work_cal_more', { count: hidden })}
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <section className="wc" aria-label={t('ia_shell_work_cal_label')}>
      <div className="wc-toolbar">
        <div className="wc-toolbar__nav">
          <Button
            label={t('ia_shell_work_cal_prev')}
            onClick={() => setAnchor((current) => shiftAnchor(current, view, -1))}
          />
          <Button label={t('ia_shell_work_cal_today')} onClick={() => setAnchor(today)} />
          <Button
            label={t('ia_shell_work_cal_next')}
            onClick={() => setAnchor((current) => shiftAnchor(current, view, 1))}
          />
        </div>
        <h2 className="wc-toolbar__title" aria-live="polite">
          {title}
        </h2>
        <div className="wc-toggle" role="group" aria-label={t('ia_shell_work_cal_view_label')}>
          {(['month', 'week'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="wc-toggle__option"
              aria-pressed={view === mode}
              onClick={() => setView(mode)}
            >
              {t(`ia_shell_work_cal_view_${mode}`)}
            </button>
          ))}
        </div>
      </div>

      <fieldset className="wc-sources">
        <legend>{t('ia_shell_work_cal_sources_label')}</legend>
        {CALENDAR_SOURCE_GROUPS.map((group) => (
          <label key={group} className="wc-sources__option" data-source={group}>
            <input
              type="checkbox"
              checked={shownGroups.has(group)}
              onChange={() => toggleGroup(group)}
            />
            <span>{t(`ia_shell_work_cal_source_${group}`)}</span>
          </label>
        ))}
      </fieldset>

      {!data && resource.state === 'loading' ? <LoadingState t={t} /> : null}
      {resource.state === 'error' ? (
        <LoadErrorState t={t} error={resource.error} onRetry={resource.reload} />
      ) : null}
      {data ? (
        <>
          <div className="wc-summary">
            {summary.overdue.length ? (
              <details className="wc-summary__group" data-tone="danger">
                <summary>
                  <span role="status">
                    {t('ia_shell_work_cal_overdue', { count: summary.overdue.length })}
                  </span>
                </summary>
                <ul>
                  {summary.overdue.map((item) => (
                    <li key={item.id}>
                      <a href={item.href}>{item.title}</a>
                      <span className="wc-summary__date">
                        {item.dueDate ? shortDay.format(utcDate(item.dueDate)) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="wc-summary__clear" role="status">
                {t('ia_shell_work_cal_clear')}
              </p>
            )}
            {summary.dueSoon.length ? (
              <p className="wc-summary__soon" data-tone="warning" role="status">
                {t('ia_shell_work_cal_due_soon', { count: summary.dueSoon.length })}
              </p>
            ) : null}
          </div>
          {data.degraded.length ? (
            <p className="wc-hint" role="status">
              {t('ia_shell_work_cal_degraded')}
            </p>
          ) : null}
          {items.length === 0 ? <p className="wc-hint">{t('ia_shell_work_cal_empty')}</p> : null}
          <div className="wc-grid" data-view={view} aria-busy={resource.state === 'loading'}>
            <ol className="wc-weekdays" aria-hidden="true">
              {weekdays.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ol>
            {grid.weeks.map((week) => (
              <ol key={week[0].date} className="wc-week">
                {week.map(renderDay)}
              </ol>
            ))}
          </div>
          <p className="wc-hint">{t('ia_shell_work_cal_undated_hint')}</p>
        </>
      ) : null}
    </section>
  );
}
