'use client';

import {
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  KbCodeProps,
  KbKvProps,
  KbListProps,
  KbMetricProps,
  KbTableBadgeCell,
  KbTableCell,
  KbTableColumn,
  KbTableProps,
  KbTableStatusCell,
  KbTableTitleCell,
  KbTextProps,
} from '@agent/core/a2ui-catalog';
import { defaultNavigate, useA2UIActions } from '../actions.js';
import { isKbStatus } from '../catalog.js';
import { KB_UI_MESSAGE_KEYS, useKbI18n } from '../i18n.js';
import { KbIcon } from '../icons.js';
import {
  codeLanguage,
  isInteractiveTarget,
  listProgressPercent,
  tableCellKind,
} from '../../vanilla/kyberion-ui.js';
import { asArray, formatScalar, safeCssLength, safeHref } from '../safety.js';
import { KbLink } from './controls.js';
import { Badge, StatusPill, toneAttr } from './feedback.js';

const TREND_ICONS = { up: 'arrow-up', down: 'arrow-down', flat: 'arrow-right' } as const;
const TREND_MESSAGE_KEYS = {
  up: KB_UI_MESSAGE_KEYS.trendUp,
  down: KB_UI_MESSAGE_KEYS.trendDown,
  flat: KB_UI_MESSAGE_KEYS.trendFlat,
} as const;

/** `ui:metric` → `.kb-metric[data-tone][data-trend]` with `__label`, `__value`, `__unit`, `__delta`, `__description`. */
export function Metric({ label, value, unit, delta, trend, tone, description }: KbMetricProps) {
  const { t } = useKbI18n();
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
        {formatScalar(value, t)}
        {unit ? <span className="kb-metric__unit">{unit}</span> : null}
      </span>
      {delta ? (
        <span className="kb-metric__delta">
          <KbIcon
            name={trendIcon}
            size={12}
            label={trendIcon && trend ? t(TREND_MESSAGE_KEYS[trend]) : undefined}
          />
          {delta}
        </span>
      ) : null}
      {description ? <span className="kb-metric__description">{description}</span> : null}
    </div>
  );
}

/** `ui:kv` → `<dl class="kb-kv">` of `__label` / `__value[data-mono]` pairs. */
export function KeyValue({ items }: KbKvProps) {
  const { t } = useKbI18n();
  return (
    <dl className="kb-kv">
      {asArray(items).map((item, index) => (
        <Fragment key={`${item.label}-${index}`}>
          <dt className="kb-kv__label">{item.label}</dt>
          <dd className="kb-kv__value" data-mono={item.mono ? 'true' : undefined}>
            {formatScalar(item.value, t)}
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

/** Context handed to `Table`'s `renderCell`. */
export interface TableCellContext {
  row: Readonly<Record<string, unknown>>;
  column: KbTableColumn;
  value: unknown;
  rowIndex: number;
}

/**
 * Props for `Table`: the catalog `ui:table` contract plus React-only
 * conveniences. A cell value may also be a React element (rendered as-is —
 * usable from a Server Component, since elements serialize), and
 * `renderCell` may render any cell (return `undefined` to keep the default).
 */
export type TableProps = Omit<KbTableProps, 'rows'> & {
  rows: ReadonlyArray<Readonly<Record<string, KbTableCell | ReactNode>>>;
  /** React-only (not in the catalog schema): custom cell rendering. */
  renderCell?: (context: TableCellContext) => ReactNode | undefined;
  /** Row field used as the React key (default: the row index). */
  row_key?: string;
};

/** `{title, id?, href?}` → `.kb-table__cell` > `__title` (link when `href` is safe) + `__id` (mono). */
function TableTitleCell({ cell }: { cell: KbTableTitleCell }) {
  const href = safeHref(cell.href);
  return (
    <span className="kb-table__cell">
      {href ? (
        <KbLink href={href} className="kb-table__title">
          {cell.title}
        </KbLink>
      ) : (
        <span className="kb-table__title">{cell.title}</span>
      )}
      {typeof cell.id === 'string' && cell.id ? (
        <span className="kb-table__id">{cell.id}</span>
      ) : null}
    </span>
  );
}

/**
 * `ui:table` → `.kb-table-wrap > table.kb-table`. Rows whose `row_href_key`
 * value is a safe href get `data-href`, become focusable and navigate on
 * click / Enter (a click on a link or control inside the row acts on its
 * own); unsafe values are dropped. Rich cells: `{title, id?, href?}`,
 * `{status, label?, domain?}` (status pill), `{badge, tone?}` (badge).
 * Empty → `.kb-table__empty` cell.
 */
export function Table({
  caption,
  columns,
  rows,
  row_href_key,
  empty,
  renderCell,
  row_key,
}: TableProps) {
  const { navigate = defaultNavigate } = useA2UIActions();
  const { t } = useKbI18n();
  const cols = asArray(columns);
  const body = Array.isArray(rows) ? rows : [];

  const cellContent = (value: unknown, column: KbTableColumn): ReactNode => {
    if (isValidElement(value)) return value;
    const kind = tableCellKind(value);
    if (kind === 'title') return <TableTitleCell cell={value as KbTableTitleCell} />;
    if (kind === 'status') {
      const cell = value as KbTableStatusCell;
      return <StatusPill status={cell.status} domain={cell.domain} label={cell.label} />;
    }
    if (kind === 'badge') {
      const cell = value as KbTableBadgeCell;
      return <Badge label={cell.badge} tone={cell.tone} />;
    }
    // Convention: a `status` / `*_status` column holding a canonical status
    // value renders as a status pill.
    const isStatusColumn = column.key === 'status' || column.key.endsWith('_status');
    if (isStatusColumn && isKbStatus(value)) return <StatusPill status={value} />;
    return formatScalar(value, t);
  };

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
                {empty || t(KB_UI_MESSAGE_KEYS.tableEmpty)}
              </td>
            </tr>
          ) : (
            body.map((row, rowIndex) => {
              const href = row_href_key ? safeHref(row?.[row_href_key]) : undefined;
              const open = href ? () => navigate(href) : undefined;
              const keyValue = row_key ? row?.[row_key] : undefined;
              const key =
                typeof keyValue === 'string' || typeof keyValue === 'number' ? keyValue : rowIndex;
              return (
                <tr
                  key={key}
                  data-href={href}
                  tabIndex={href ? 0 : undefined}
                  onClick={
                    open
                      ? (event: MouseEvent<HTMLTableRowElement>) => {
                          // Links / controls inside the row act on their own.
                          if (isInteractiveTarget(event.target, event.currentTarget)) return;
                          open();
                        }
                      : undefined
                  }
                  onKeyDown={
                    open
                      ? (event: KeyboardEvent<HTMLTableRowElement>) => {
                          if (event.key === 'Enter' && event.target === event.currentTarget) open();
                        }
                      : undefined
                  }
                >
                  {cols.map((column) => {
                    const value = row?.[column.key];
                    const custom = renderCell
                      ? renderCell({ row: row ?? {}, column, value, rowIndex })
                      : undefined;
                    const content = custom !== undefined ? custom : cellContent(value, column);
                    const text = typeof content === 'string' ? content : undefined;
                    return (
                      <td
                        key={column.key}
                        data-align={alignAttr(column.align)}
                        data-mono={column.mono ? 'true' : undefined}
                        // Mono columns (ids, hashes) never wrap mid-token
                        // (see the source CSS); the title gives the full
                        // value back when the column stays narrower than it.
                        title={column.mono && text ? text : undefined}
                      >
                        {content}
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

// Compile-time guarantee that the catalog props are accepted as-is.
const _catalogTableIsAccepted = (props: KbTableProps): TableProps => props;
void _catalogTableIsAccepted;

/**
 * `ui:list` item `progress` → `.kb-list__progress`: a `role="progressbar"`
 * track (accessible name + value text from the vocabulary) and the visible
 * percentage.
 */
function ListProgress({ value }: { value: unknown }) {
  const { t } = useKbI18n();
  const percent = listProgressPercent(value);
  if (percent === null) return null;
  return (
    <div className="kb-list__progress">
      <span
        className="kb-list__progress-track"
        role="progressbar"
        aria-label={t(KB_UI_MESSAGE_KEYS.listProgress)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t(KB_UI_MESSAGE_KEYS.listProgressValue, { percent })}
      >
        <span className="kb-list__progress-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="kb-list__progress-value" aria-hidden="true">
        {`${percent}%`}
      </span>
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
              <ListProgress value={item.progress} />
            </div>
            {isKbStatus(item.status) ? (
              <StatusPill status={item.status} label={item.status_label} />
            ) : null}
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

/**
 * `ui:code` → `figure.kb-code[data-language]` (optional `figcaption.__header`
 * with `__title` / `__language`) and `pre.__body > code` (pre-wrap, never
 * interpreted).
 */
export function Code({ code, language, title }: KbCodeProps) {
  const lang = codeLanguage(language);
  return (
    <figure className="kb-code" data-language={lang ?? undefined}>
      {title || lang ? (
        <figcaption className="kb-code__header">
          {title ? <span className="kb-code__title">{title}</span> : null}
          {lang ? <span className="kb-code__language">{lang}</span> : null}
        </figcaption>
      ) : null}
      <pre className="kb-code__body">
        <code>{typeof code === 'string' ? code : ''}</code>
      </pre>
    </figure>
  );
}
