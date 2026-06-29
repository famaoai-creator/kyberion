/**
 * Token-efficient projection for `media:xlsx_extract`.
 *
 * `distillXlsxDesign` returns the full workbook including per-cell styles — heavy to
 * pass into a `reasoning:*` step. This projects it to a slim, values-only shape,
 * optionally filtered to one sheet and an A1 range, so a pipeline can narrow the data
 * deterministically (zero LLM tokens) before any reasoning step.
 *
 * Input row shape (from `@agent/core` distillXlsxDesign / XlsxRow):
 *   { index: number, cells: Array<{ ref: "C5", value: any, ... }> }
 * Output (values_only):
 *   { version, extracted:{…}, sheets:[ { name, rows:[ { row: <1-based>, cells: { "C": value, … } } ] } ] }
 */

export interface XlsxProjectionOptions {
  sheet?: string;
  range?: string;
  /** Strip styles → emit only cell values keyed by column letter. Default true. */
  valuesOnly?: boolean;
  /** Also drop cells whose value is exactly 0 (useful for sparse amortization-style tables). */
  skipZero?: boolean;
}

interface RangeBounds {
  colStart?: number;
  colEnd?: number;
  rowStart?: number;
  rowEnd?: number;
}

export function colLettersToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseA1Cell(token: string): { col?: number; row?: number } {
  const m = /^([A-Za-z]*)(\d*)$/.exec((token || '').trim());
  if (!m) return {};
  return {
    col: m[1] ? colLettersToNum(m[1]) : undefined,
    row: m[2] ? parseInt(m[2], 10) : undefined,
  };
}

export function parseA1Range(range?: string): RangeBounds | null {
  if (!range || typeof range !== 'string') return null;
  const [a, b] = range.split(':');
  const start = parseA1Cell(a);
  const end = parseA1Cell(b ?? a);
  const cols = [start.col, end.col].filter((x): x is number => x != null);
  const rows = [start.row, end.row].filter((x): x is number => x != null);
  return {
    colStart: cols.length ? Math.min(...cols) : undefined,
    colEnd: cols.length ? Math.max(...cols) : undefined,
    rowStart: rows.length ? Math.min(...rows) : undefined,
    rowEnd: rows.length ? Math.max(...rows) : undefined,
  };
}

/** Reduce a formula/richText/hyperlink cell value to a plain scalar where possible. */
export function unwrapCellValue(v: any): any {
  if (v == null || typeof v !== 'object') return v;
  if ('result' in v) return v.result; // formula cell → computed result
  if (Array.isArray(v.richText)) return v.richText.map((t: any) => t?.text ?? '').join('');
  if ('text' in v) return v.text; // hyperlink / text wrapper
  return v;
}

export function projectXlsxDesign(design: any, opts: XlsxProjectionOptions = {}): any {
  const valuesOnly = opts.valuesOnly !== false;
  const rng = parseA1Range(opts.range);
  const inRows = (idx: number) =>
    !rng || rng.rowStart == null || (idx >= rng.rowStart && idx <= (rng.rowEnd ?? rng.rowStart));
  const inCols = (col: number) =>
    !rng || rng.colStart == null || (col >= rng.colStart && col <= (rng.colEnd ?? rng.colStart));

  const sheets = (design?.sheets ?? [])
    .filter((s: any) => !opts.sheet || s.name === opts.sheet)
    .map((s: any) => ({
      name: s.name,
      rows: (s.rows ?? [])
        .filter((r: any) => inRows(r.index))
        .map((r: any) => {
          const cells: Record<string, any> = {};
          for (const c of r.cells ?? []) {
            const m = /^([A-Za-z]+)(\d+)$/.exec(c.ref || '');
            if (!m) continue;
            const colLetter = m[1].toUpperCase();
            if (!inCols(colLettersToNum(colLetter))) continue;
            const value = unwrapCellValue(c.value);
            if (value === null || value === undefined || value === '') continue;
            if (opts.skipZero && value === 0) continue;
            cells[colLetter] = valuesOnly ? value : c;
          }
          return { row: r.index, cells };
        })
        .filter((row: any) => Object.keys(row.cells).length > 0),
    }));

  return {
    version: design?.version,
    extracted: {
      sheet: opts.sheet ?? null,
      range: opts.range ?? null,
      values_only: valuesOnly,
      skip_zero: opts.skipZero === true,
    },
    sheets,
  };
}
