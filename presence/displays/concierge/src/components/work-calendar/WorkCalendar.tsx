'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useWorkspaceResource } from '../../lib/use-workspace-resource';
import {
  entityHref,
  listQueryFromSearch,
  workspaceApiPath,
  type GraphNode,
} from '../../lib/workspace-view';
import { cardTitle } from '../work-board/work-item-board';
import { LoadErrorState, LoadingState, type Translate } from '../../app/w/workspace-parts';
import {
  addDays,
  buildCalendarGrid,
  localCalendarDate,
  shiftAnchor,
  startOfWeek,
  summarizeCalendar,
  type CalendarDay,
  type CalendarItem,
  type CalendarView,
} from './work-calendar';
import './work-calendar.css';

/** The list operation's ceiling; at this size the calendar says it may be partial. */
const LIST_LIMIT = 500;
/** Entries a month cell shows before "+N more". */
const MONTH_CELL_ENTRIES = 3;

function toCalendarItems(nodes: readonly GraphNode[]): CalendarItem[] {
  return nodes.map((node) => {
    const startDate = node.facts?.start_date;
    const dueDate = node.facts?.due_date;
    return {
      id: node.id,
      title: cardTitle(node.label, node.missionId),
      status: node.status ?? 'backlog',
      ...(typeof startDate === 'string' ? { startDate } : {}),
      ...(typeof dueDate === 'string' ? { dueDate } : {}),
      href: entityHref('work_item', node.id),
    };
  });
}

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
 * `/work?tab=calendar` — dated work items on a month or week grid. Items come
 * from the same viewer-scoped workspace list as the board (`dated=true`), so
 * the calendar never shows more than the viewer may see; scope narrowing in
 * the URL (tenant / organization / project / mission) applies here too.
 * Dates are set on the board card; the calendar only reads.
 */
export function WorkCalendar({ t }: { t: Translate }) {
  const { locale: uiLocale } = useConciergeI18n();
  const locale = localeToBcp47(uiLocale);
  const searchParams = useSearchParams();
  const scope = React.useMemo(() => {
    const {
      q: _q,
      status: _status,
      ...narrowing
    } = listQueryFromSearch(new URLSearchParams(searchParams?.toString() ?? ''));
    return narrowing;
  }, [searchParams]);
  const list = useWorkspaceResource<{ items: GraphNode[] }>(
    workspaceApiPath('list', { kind: 'work_item', dated: 'true', limit: LIST_LIMIT, ...scope })
  );

  const today = localCalendarDate();
  const [view, setView] = React.useState<CalendarView>('month');
  const [anchor, setAnchor] = React.useState(today);

  const items = React.useMemo(
    () => (list.state === 'ready' ? toCalendarItems(list.data.items) : []),
    [list]
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
                data-due={entry.role === 'due' ? entry.due.state : undefined}
              >
                <span className="wc-entry__role">
                  {entry.role === 'due'
                    ? t('ia_shell_work_cal_due')
                    : entry.role === 'start'
                      ? t('ia_shell_work_cal_start')
                      : t('ia_shell_work_cal_underway')}
                </span>
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

      {list.state === 'loading' ? <LoadingState t={t} /> : null}
      {list.state === 'error' ? (
        <LoadErrorState t={t} error={list.error} onRetry={list.reload} />
      ) : null}
      {list.state === 'ready' ? (
        <>
          <div className="wc-summary" role="status">
            {summary.overdue.length ? (
              <details className="wc-summary__group" data-tone="danger">
                <summary>
                  {t('ia_shell_work_cal_overdue', { count: summary.overdue.length })}
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
              <p className="wc-summary__clear">{t('ia_shell_work_cal_clear')}</p>
            )}
            {summary.dueSoon.length ? (
              <p className="wc-summary__soon" data-tone="warning">
                {t('ia_shell_work_cal_due_soon', { count: summary.dueSoon.length })}
              </p>
            ) : null}
          </div>
          {items.length === 0 ? <p className="wc-hint">{t('ia_shell_work_cal_empty')}</p> : null}
          <div className="wc-grid" data-view={view}>
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
          <p className="wc-hint">
            {items.length >= LIST_LIMIT
              ? t('ia_shell_work_cal_truncated', { count: LIST_LIMIT })
              : t('ia_shell_work_cal_undated_hint')}
          </p>
        </>
      ) : null}
    </section>
  );
}
