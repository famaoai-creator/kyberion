'use client';

import * as React from 'react';
import { useA2UIActions } from '@agent/shared-ui';

/**
 * `ui:table` markup (`.kb-table-wrap > table.kb-table`, same class / data
 * attribute contract as the shared `Table`) for cells that carry components
 * — status pills, tier badges, a title over a mono id. Rows with `href` are
 * clickable and keyboard-activatable (Enter) like the shared table; the
 * navigation goes through the shell's router. Presentation only.
 */
export interface DataTableColumn {
  key: string;
  label: string;
  align?: 'start' | 'center' | 'end';
  mono?: boolean;
}

export interface DataTableRow {
  id: string;
  href?: string;
  cells: Record<string, React.ReactNode>;
}

export function DataTable({
  columns,
  rows,
  caption,
  empty,
}: {
  columns: DataTableColumn[];
  rows: DataTableRow[];
  caption?: string;
  empty: string;
}) {
  const { navigate } = useA2UIActions();
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
                data-align={column.align && column.align !== 'start' ? column.align : undefined}
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
              const open = row.href && navigate ? () => navigate(row.href as string) : undefined;
              return (
                <tr
                  key={row.id}
                  data-href={row.href}
                  tabIndex={open ? 0 : undefined}
                  onClick={
                    open
                      ? (event) => {
                          // Links inside the row navigate themselves.
                          if ((event.target as HTMLElement).closest('a')) return;
                          open();
                        }
                      : undefined
                  }
                  onKeyDown={
                    open
                      ? (event) => {
                          if (event.key === 'Enter' && event.target === event.currentTarget) open();
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-align={
                        column.align && column.align !== 'start' ? column.align : undefined
                      }
                      data-mono={column.mono ? 'true' : undefined}
                    >
                      {row.cells[column.key] ?? '—'}
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
