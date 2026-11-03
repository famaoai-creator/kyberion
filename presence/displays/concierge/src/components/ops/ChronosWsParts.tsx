'use client';

import * as React from 'react';

/**
 * UI-07: small building blocks shared by the Work / Decisions workspaces
 * (work items, deliverables, approvals, knowledge). They only emit the
 * shared `.kb-*` contract plus the existing `chronos-*` classes — no
 * Tailwind colors, no nested boxes.
 */

export type WsColumn = {
  key: string;
  label: string;
  width?: string;
  align?: 'start' | 'end';
};

/**
 * A `kb-table` whose rows select an item (master list of a master–detail
 * view). The first cell of each row carries the select button so the row
 * stays keyboard reachable; the selected row is marked `aria-selected` and
 * tinted with the accent-soft token.
 */
export function WsSelectTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  selectedKey,
  onSelect,
  renderCell,
  empty,
}: {
  caption?: string;
  columns: WsColumn[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  renderCell: (row: T, columnKey: string, select: () => void) => React.ReactNode;
  empty: React.ReactNode;
}) {
  return (
    <div className="kb-table-wrap">
      <table className="kb-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-align={column.align === 'end' ? 'end' : undefined}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="kb-table__empty" colSpan={Math.max(1, columns.length)}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const key = rowKey(row);
              const selected = key === selectedKey;
              const select = () => onSelect(key);
              return (
                <tr
                  key={key}
                  aria-selected={selected}
                  style={selected ? { background: 'var(--kb-ui-accent-soft)' } : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.key} data-align={column.align === 'end' ? 'end' : undefined}>
                      {renderCell(row, column.key, select)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Human title (select button) with the machine id as a mono secondary line. */
export function WsTitleCell({
  title,
  id,
  onSelect,
  selected,
}: {
  title: string;
  id?: string | null;
  onSelect?: () => void;
  selected?: boolean;
}) {
  return (
    <div className="chronos-mission-cell">
      {onSelect ? (
        <button
          type="button"
          className="chronos-mission-cell__title"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {title}
        </button>
      ) : (
        <span className="chronos-mission-cell__title">{title}</span>
      )}
      {id ? <span className="chronos-mission-cell__id">{id}</span> : null}
    </div>
  );
}

/** Controlled textarea in the shared `kb-field` markup. */
export function WsTextareaField({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="kb-field" data-control="textarea">
      <label className="kb-field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="kb-input kb-textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** A monospace, wrapping preview block (`ui:code` markup). */
export function WsPreformatted({ text, title }: { text: string; title?: string }) {
  return (
    <figure className="kb-code">
      {title ? (
        <figcaption className="kb-code__header">
          <span className="kb-code__title">{title}</span>
        </figcaption>
      ) : null}
      <pre className="kb-code__body" style={{ maxHeight: '28rem', overflow: 'auto' }}>
        <code>{text}</code>
      </pre>
    </figure>
  );
}
