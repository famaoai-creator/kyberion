// SD-05: the decision ledger drawn as the hearing canvas — deterministic,
// never model-generated. A ledger hearing's canvas is a projection of the
// tenant's ledger (decided rows with their conformance verdict, open rows
// with the answer given so far). Every visual value — colors, fonts, type
// sizes, spacing — comes from the design-defaults cascade
// (`resolveCreativeDesign`), never from a literal chosen here: type sizes are
// the tenant's typography roles, gaps are multiples of the spacing base unit.
// Safe by construction: every value is escaped, there is no script, no link,
// no external resource, so it satisfies the same forbidden-pattern list the
// sanitizer applies to the model's output (proved in the test).
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  resolveCreativeDesign,
  type ResolvedCreativeDesign,
} from '@agent/core/creative-design-resolver';
import type {
  ProjectionBrief,
  ProjectionRow,
  ProjectionVerdict,
} from '@agent/core/decision-ledger';
import { designTokenCssVars } from './hearing-canvas.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveTokens(tenantSlug: string | undefined): ResolvedCreativeDesign {
  try {
    return resolveCreativeDesign({ surface: 'web', tenantSlug, mode: 'light' });
  } catch {
    return resolveCreativeDesign({ surface: 'web', mode: 'light' });
  }
}

const VERDICT_KEYS: Record<ProjectionVerdict, VocabularyKey> = {
  match: 'front_desk:hearing_ledger_verdict_match',
  conflict: 'front_desk:hearing_ledger_verdict_conflict',
  stale: 'front_desk:hearing_ledger_verdict_stale',
  unprobed: 'front_desk:hearing_ledger_verdict_unprobed',
  open: 'front_desk:hearing_ledger_verdict_open',
};

const COLUMN_KEYS: readonly VocabularyKey[] = [
  'front_desk:hearing_ledger_col_item',
  'front_desk:hearing_ledger_col_decision',
  'front_desk:hearing_ledger_col_implementation',
  'front_desk:hearing_ledger_col_status',
];

/** Which spacing steps (multiples of `spacing.base_pt`) the layout uses, by role. */
const SPACING_STEP_INDEX = { page: 4, cell: 2, gap: 1 } as const;

function spacingPt(tokens: ResolvedCreativeDesign, role: keyof typeof SPACING_STEP_INDEX): number {
  const steps = tokens.spacing.steps.length ? tokens.spacing.steps : [1, 2, 3, 4, 6, 8];
  const step = steps[Math.min(SPACING_STEP_INDEX[role], steps.length - 1)] ?? 1;
  return tokens.spacing.base_pt * step;
}

/** CSS derived only from tokens: type roles → sizes/weights/line heights, spacing steps → padding/gaps. */
function styleFromTokens(tokens: ResolvedCreativeDesign): string {
  const { title, body, caption, label } = tokens.typography.roles;
  const minBody = Math.max(body.size_pt, tokens.constraints.min_body_pt);
  const minCaption = Math.max(caption.size_pt, tokens.constraints.min_label_pt);
  return [
    `:root { ${designTokenCssVars(tokens)} }`,
    `body { margin: 0; padding: ${spacingPt(tokens, 'page')}pt; font-family: var(--font-body); font-size: ${minBody}pt; line-height: ${body.line_spacing_pct}%; color: var(--color-text); background: var(--color-background); }`,
    `h1 { font-family: var(--font-heading); font-size: ${title.size_pt}pt; font-weight: ${title.weight}; line-height: ${title.line_spacing_pct}%; margin: 0 0 ${spacingPt(tokens, 'gap')}pt; }`,
    `p.summary { margin: 0 0 ${spacingPt(tokens, 'page')}pt; color: var(--color-secondary); }`,
    `p.summary.red { color: var(--color-warning); font-weight: ${label.weight}; }`,
    `table { border-collapse: collapse; width: 100%; }`,
    `th, td { text-align: left; vertical-align: top; padding: ${spacingPt(tokens, 'cell')}pt; border-bottom: 1px solid var(--color-secondary); }`,
    `th { font-weight: ${label.weight}; color: var(--color-primary); }`,
    `small { color: var(--color-secondary); font-size: ${minCaption}pt; }`,
    `tr.verdict-conflict td, tr.verdict-stale td { background: color-mix(in srgb, var(--color-warning) 12%, var(--color-background)); }`,
    `tr.verdict-match td:last-child { color: var(--color-primary); }`,
    `tr.verdict-open td:last-child { color: var(--color-secondary); }`,
  ].join('\n');
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return escapeHtml(value);
  return escapeHtml(JSON.stringify(value));
}

function renderRow(row: ProjectionRow, locale: SupportedLocale): string {
  const status = catalogT(VERDICT_KEYS[row.verdict], undefined, locale);
  const decision =
    row.state === 'decided'
      ? renderValue(row.value)
      : row.answer
        ? `${renderValue(row.answer)} <small>${escapeHtml(
            catalogT('front_desk:hearing_ledger_answer_pending', undefined, locale)
          )}</small>`
        : '—';
  const implementation =
    row.observed !== undefined
      ? `${renderValue(row.observed)}${row.impl_ref ? ` <small>${escapeHtml(row.impl_ref)}</small>` : ''}`
      : '—';
  return `<tr class="verdict-${escapeHtml(row.verdict)}">
  <td><strong>${escapeHtml(row.item)}</strong><br><small>${escapeHtml(row.key)} · ${escapeHtml(row.level)}</small></td>
  <td>${decision}${row.basis_refs.length ? `<br><small>${escapeHtml(row.basis_refs.join(', '))}</small>` : ''}</td>
  <td>${implementation}</td>
  <td>${escapeHtml(status)}${row.pending_reason ? `<br><small>${escapeHtml(row.pending_reason)}</small>` : ''}</td>
</tr>`;
}

export interface LedgerCanvasOptions {
  locale: SupportedLocale;
  tenantSlug?: string;
}

export function renderLedgerProjectionCanvas(
  brief: ProjectionBrief,
  options: LedgerCanvasOptions
): string {
  const { locale } = options;
  const tokens = resolveTokens(options.tenantSlug);
  const title = catalogT('front_desk:hearing_ledger_canvas_title', undefined, locale);
  const summary = catalogT(
    'front_desk:hearing_ledger_summary',
    {
      decided: brief.tally.match + brief.tally.conflict + brief.tally.stale + brief.tally.unprobed,
      open: brief.tally.open,
      red: brief.tally.conflict + brief.tally.stale,
    },
    locale
  );
  const columns = COLUMN_KEYS.map(
    (key) => `<th>${escapeHtml(catalogT(key, undefined, locale))}</th>`
  ).join('');
  const rows = brief.rows.map((row) => renderRow(row, locale)).join('\n');
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
${styleFromTokens(tokens)}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><p class="summary${brief.red ? ' red' : ''}">${escapeHtml(summary)}${
    brief.impl ? ` <small>${escapeHtml(`${brief.impl.repo}@${brief.impl.commit}`)}</small>` : ''
  }</p></header>
<main><table><thead><tr>${columns}</tr></thead><tbody>
${rows}
</tbody></table></main>
</body></html>`;
}
