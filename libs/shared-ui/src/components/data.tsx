'use client';

import { Fragment, type KeyboardEvent } from 'react';
import type {
  KbKvProps,
  KbListProps,
  KbMetricProps,
  KbTableProps,
  KbTextProps,
} from '@agent/core/a2ui-catalog';
import { defaultNavigate, useA2UIActions } from '../actions.js';
import { isKbStatus } from '../catalog.js';
import { KbIcon } from '../icons.js';
import { asArray, formatScalar, safeCssLength, safeHref } from '../safety.js';
import { KbLink } from './controls.js';
import { StatusPill, toneAttr } from './feedback.js';

const TREND_ICONS = { up: 'arrow-up', down: 'arrow-down', flat: 'arrow-right' } as const;

/** `ui:metric` → `.kb-metric[data-tone][data-trend]` with `__label`, `__value`, `__unit`, `__delta`, `__description`. */
export function Metric({ label, value, unit, delta, trend, tone, description }: KbMetricProps) {
  const trendIcon =
    trend && Object.prototype.hasOwnProperty.call(TREND_ICONS, trend)
      ? TREND_ICONS[trend]
      : undefined;
  return (
    <div
      className="kb-metric"
      data-tone={toneAttr(tone)}
      data-trend={trendIcon ? trend : undefined}
    >
      <span className="kb-metric__label">{label}</span>
      <span className="kb-metric__value">
        {formatScalar(value)}
        {unit ? <span className="kb-metric__unit">{unit}</span> : null}
      </span>
      {delta ? (
        <span className="kb-metric__delta">
          <KbIcon name={trendIcon} size={12} />
          {delta}
        </span>
      ) : null}
      {description ? <span className="kb-metric__description">{description}</span> : null}
    </div>
  );
}

/** `ui:kv` → `<dl class="kb-kv">` of `__label` / `__value[data-mono]` pairs. */
export function KeyValue({ items }: KbKvProps) {
  return (
    <dl className="kb-kv">
      {asArray(items).map((item, index) => (
        <Fragment key={`${item.label}-${index}`}>
          <dt className="kb-kv__label">{item.label}</dt>
          <dd className="kb-kv__value" data-mono={item.mono ? 'true' : undefined}>
            {formatScalar(item.value)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

const ALIGNS: ReadonlySet<string> = new Set(['start', 'center', 'end']);

function alignAttr(align: unknown): string | undefined {
  return typeof align === 'string' && ALIGNS.has(align) && align !== 'start' ? align : undefined;
}

/**
 * `ui:table` → `.kb-table-wrap > table.kb-table`. Rows whose `row_href_key`
 * value is a safe href get `data-href`, become focusable and navigate on
 * click / Enter; unsafe values are dropped. Empty → `.kb-table__empty` cell.
 */
export function Table({ caption, columns, rows, row_href_key, empty }: KbTableProps) {
  const { navigate = defaultNavigate } = useA2UIActions();
  const cols = asArray(columns);
  const body = asArray(rows);
  return (
    <div className="kb-table-wrap">
      <table className="kb-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {cols.map((column) => {
              const width = safeCssLength(column.width);
              return (
                <th
                  key={column.key}
                  scope="col"
                  data-align={alignAttr(column.align)}
                  style={width ? { width } : undefined}
                >
                  {column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {body.length === 0 ? (
            <tr>
              <td className="kb-table__empty" colSpan={Math.max(1, cols.length)}>
                {empty || 'データがありません'}
              </td>
            </tr>
          ) : (
            body.map((row, rowIndex) => {
              const href = row_href_key ? safeHref(row?.[row_href_key]) : undefined;
              const open = href ? () => navigate(href) : undefined;
              return (
                <tr
                  key={rowIndex}
                  data-href={href}
                  tabIndex={href ? 0 : undefined}
                  onClick={open}
                  onKeyDown={
                    open
                      ? (event: KeyboardEvent<HTMLTableRowElement>) => {
                          if (event.key === 'Enter') open();
                        }
                      : undefined
                  }
                >
                  {cols.map((column) => {
                    const value = row?.[column.key];
                    // Convention: a `status` / `*_status` column holding a
                    // canonical status value renders as a status pill.
                    const isStatusColumn =
                      column.key === 'status' || column.key.endsWith('_status');
                    return (
                      <td
                        key={column.key}
                        data-align={alignAttr(column.align)}
                        data-mono={column.mono ? 'true' : undefined}
                      >
                        {isStatusColumn && isKbStatus(value) ? (
                          <StatusPill status={value} />
                        ) : (
                          formatScalar(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** `ui:list` → `ul.kb-list[data-variant]` of `__item[data-status]` (`__body` > `__title` + `__meta`, optional status pill). */
export function List({ items, variant }: KbListProps) {
  return (
    <ul className="kb-list" data-variant={variant === 'timeline' ? 'timeline' : 'plain'}>
      {asArray(items).map((item, index) => {
        const href = safeHref(item.href);
        return (
          <li key={`${item.title}-${index}`} className="kb-list__item" data-status={item.status}>
            <div className="kb-list__body">
              {href ? (
                <KbLink href={href} className="kb-list__title">
                  {item.title}
                </KbLink>
              ) : (
                <span className="kb-list__title">{item.title}</span>
              )}
              {item.meta ? <span className="kb-list__meta">{item.meta}</span> : null}
            </div>
            {isKbStatus(item.status) ? <StatusPill status={item.status} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

const TEXT_VARIANTS: ReadonlySet<string> = new Set(['body', 'muted', 'caption', 'mono', 'title']);

/** `ui:text` → `p.kb-text.kb-text--{variant}`. */
export function Text({ text, variant }: KbTextProps) {
  const resolved = typeof variant === 'string' && TEXT_VARIANTS.has(variant) ? variant : 'body';
  return <p className={`kb-text kb-text--${resolved}`}>{text}</p>;
}
