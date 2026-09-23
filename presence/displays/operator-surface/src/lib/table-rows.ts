import type { ReactNode } from 'react';
import type { KbTableCell } from '@agent/core/a2ui-catalog';

/**
 * One operator table row for the shared `Table` (`@agent/shared-ui`): a
 * stable id, an optional row link and the cells — catalog cells (scalars,
 * `{title, id?, href?}`, `{status, label?, domain?}`, `{badge, tone?}`) or
 * server-rendered React elements for the few composite cells.
 */
export interface OperatorTableRow {
  id: string;
  href?: string;
  cells: Record<string, KbTableCell | ReactNode>;
}

/** Row field the shared `Table` uses as the React key (`row_key`). */
export const ROW_KEY = '_row_key';
/** Row field the shared `Table` navigates to on row click / Enter (`row_href_key`). */
export const ROW_HREF = '_row_href';

/** Flatten operator rows into the shared `Table`'s `rows` (id / href under reserved keys). */
export function tableRows(
  rows: readonly OperatorTableRow[]
): Array<Record<string, KbTableCell | ReactNode>> {
  return rows.map((row) => ({
    ...row.cells,
    [ROW_KEY]: row.id,
    ...(row.href ? { [ROW_HREF]: row.href } : {}),
  }));
}
