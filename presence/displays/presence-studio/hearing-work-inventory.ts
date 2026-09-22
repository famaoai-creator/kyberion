/**
 * hearing-work-inventory.ts — WI-08: the `work_inventory` hearing scenario's
 * own pieces — free-text parsing of its answers into work-inventory fields,
 * the deterministic (no model call) `work_inventory_table` canvas preview,
 * and the pure input builder the `POST /api/hearing/:session/inventory`
 * route (`hearing-routes.ts`) hands to `proposeWorkDecomposition`.
 *
 * Mirrors `hearing-mission.ts`'s split for the `mission` handoff: this
 * module only builds values from an already-loaded `HearingRecord`, it never
 * touches disk itself — `hearing-routes.ts` is the only place that calls
 * `proposeWorkDecomposition` with a real reasoning backend or
 * `saveWorkInventoryEntry`.
 */
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  proposeWorkDecomposition,
  type ProposeWorkDecompositionInput,
} from '@agent/core/work-inventory-decompose';
import type {
  WorkInventoryFrequency,
  WorkInventoryScope,
  WorkInventoryStep,
  WorkTriggerKind,
} from '@agent/core/work-inventory';
import type { HearingRecord } from './hearing.js';
import { sanitizeGeneratedCanvasHtml } from './hearing-canvas.js';

// ---------------------------------------------------------------------------
// Requirement answer helpers
// ---------------------------------------------------------------------------

export function workInventoryRequirementAnswer(
  record: HearingRecord,
  requirementId: string
): string {
  return record.requirements.find((item) => item.id === requirementId)?.answer?.trim() || '';
}

// ---------------------------------------------------------------------------
// Free-text parsing (task 4 of WI-08)
// ---------------------------------------------------------------------------

const SCHEDULE_KEYWORDS = ['毎日', '毎週', '毎月', 'daily', 'weekly', 'monthly'];
const EVENT_KEYWORDS = ['メール', '受信', '届いたら', 'email', 'received'];

/** Combines the `trigger` and `frequency` answers per WI-08 §4: "schedule if
 * frequency/trigger mention 毎日/毎週/毎月/daily/weekly/monthly, event if
 * メール/受信/届いたら, else request." */
export function inferWorkInventoryTriggerKind(
  triggerAnswer: string,
  frequencyAnswer: string
): WorkTriggerKind {
  const combined = `${triggerAnswer} ${frequencyAnswer}`;
  const lower = combined.toLowerCase();
  if (SCHEDULE_KEYWORDS.some((keyword) => combined.includes(keyword) || lower.includes(keyword))) {
    return 'schedule';
  }
  if (EVENT_KEYWORDS.some((keyword) => combined.includes(keyword) || lower.includes(keyword))) {
    return 'event';
  }
  return 'request';
}

const WEEK_COUNT_PATTERN = /週\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:回)?\s*\/\s*週/;

/** Best-effort `WorkInventoryFrequency` from a free-text answer; `undefined`
 * when nothing obvious is present (per WI-08 §4, the field stays omitted
 * rather than guessed). */
export function parseWorkInventoryFrequency(text: string): WorkInventoryFrequency | undefined {
  if (/四半期/.test(text)) return { per: 'quarter', count: 1 };
  if (/毎月|月次/.test(text)) return { per: 'month', count: 1 };
  const weekMatch = text.match(WEEK_COUNT_PATTERN);
  if (weekMatch) {
    const count = Number(weekMatch[1] ?? weekMatch[2]);
    if (Number.isFinite(count) && count > 0) return { per: 'week', count };
  }
  if (/毎週/.test(text)) return { per: 'week', count: 1 };
  if (/毎日/.test(text)) return { per: 'day', count: 1 };
  return undefined;
}

// `\b` only guards the ASCII alternatives (h/hour/hours, min/minute/minutes)
// — 時間/分 are not `\w` characters, so `\b` would never match right after
// them and silently fail to match "30分"/"1時間" at all.
const HOUR_PATTERN = /(\d+(?:\.\d+)?)\s*(?:時間|(?:hours?|h)\b)/i;
const MINUTE_PATTERN = /(\d+(?:\.\d+)?)\s*(?:分|(?:minutes?|min)\b)/i;

/** Best-effort effort minutes from a free-text answer ("30分" -> 30,
 * "1時間" -> 60, "1.5h" -> 90); `undefined` when nothing obvious matches. */
export function parseWorkInventoryEffortMinutes(text: string): number | undefined {
  const hourMatch = text.match(HOUR_PATTERN);
  if (hourMatch) return Math.round(Number(hourMatch[1]) * 60);
  const minuteMatch = text.match(MINUTE_PATTERN);
  if (minuteMatch) return Math.round(Number(minuteMatch[1]));
  return undefined;
}

/** Splits a free-text systems/tools answer on 、, or / (WI-08 §4). */
export function splitWorkInventorySystems(text: string): string[] {
  return text
    .split(/[、,／/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Decomposition input builder (used by both the canvas preview and the
// `/inventory` route — `useModel` is the only thing that differs between
// them).
// ---------------------------------------------------------------------------

export interface WorkInventoryDecompositionInputOptions {
  scope: WorkInventoryScope;
}

/** Pure mapping from a `work_inventory` hearing record's answers onto
 * `proposeWorkDecomposition`'s input shape. Never calls the reasoning
 * backend itself — the caller passes `useModel` to `proposeWorkDecomposition`. */
export function buildWorkInventoryDecompositionInput(
  record: HearingRecord,
  options: WorkInventoryDecompositionInputOptions
): ProposeWorkDecompositionInput {
  const taskName = workInventoryRequirementAnswer(record, 'task_name');
  const triggerAnswer = workInventoryRequirementAnswer(record, 'trigger');
  const frequencyAnswer = workInventoryRequirementAnswer(record, 'frequency');
  const effortAnswer = workInventoryRequirementAnswer(record, 'effort');
  const stepsAnswer = workInventoryRequirementAnswer(record, 'steps');
  const systemsAnswer = workInventoryRequirementAnswer(record, 'systems');
  const decisionsAnswer = workInventoryRequirementAnswer(record, 'decisions');

  const frequency = parseWorkInventoryFrequency(frequencyAnswer);
  const effortMinutes = parseWorkInventoryEffortMinutes(effortAnswer);
  const systems = splitWorkInventorySystems(systemsAnswer);
  const triggerKind = inferWorkInventoryTriggerKind(triggerAnswer, frequencyAnswer);

  return {
    title: taskName || record.session_id,
    description: [stepsAnswer, decisionsAnswer].filter(Boolean).join('\n'),
    scope: options.scope,
    ...(systems.length > 0 ? { systems } : {}),
    trigger: { kind: triggerKind, description: triggerAnswer || frequencyAnswer || taskName },
    ...(frequency ? { frequency } : {}),
    ...(effortMinutes !== undefined ? { effort_minutes_per_run: effortMinutes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Deterministic canvas preview (`canvas: 'work_inventory_table'`, no model call)
// ---------------------------------------------------------------------------

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStepRow(step: WorkInventoryStep): string {
  return `<tr><td>${escapeHtml(step.step_id)}</td><td>${escapeHtml(step.description)}</td><td>${escapeHtml(step.stage)}</td><td>${escapeHtml(step.verb)}</td><td>${escapeHtml(step.method.assigned)}</td></tr>`;
}

/**
 * Builds the `work_inventory_table` canvas: a deterministic HTML table of
 * every requirement + its answer, plus — once `steps` is answered — a
 * heuristic-only (`useModel: false`, per WI-08 §3) decomposition preview
 * table. Never calls a reasoning backend. Runs the result through
 * `hearing-canvas.ts`'s `sanitizeGeneratedCanvasHtml` the same as the
 * model-drawn `web_app_preview` canvas, as defense in depth, even though
 * every value here is our own escaped markup.
 */
export async function renderWorkInventoryCanvasHtml(
  record: HearingRecord,
  locale: SupportedLocale
): Promise<string> {
  const unanswered = catalogT('front_desk:hearing_canvas_unanswered', undefined, locale);
  const rows = record.requirements
    .map(
      (item) =>
        `<tr><th scope="row">${escapeHtml(catalogT(item.label_key as VocabularyKey, undefined, locale))}</th><td>${escapeHtml(item.answer || unanswered)}</td></tr>`
    )
    .join('\n');

  const stepsAnswer = workInventoryRequirementAnswer(record, 'steps');
  let stepsSection: string;
  if (stepsAnswer) {
    const scope: WorkInventoryScope = {};
    const input = buildWorkInventoryDecompositionInput(record, { scope });
    const result = await proposeWorkDecomposition(input, { useModel: false });
    const stepRows = result.entry.steps.map(renderStepRow).join('\n');
    stepsSection = `<section><h2>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_steps_heading', undefined, locale))}</h2><table><thead><tr><th>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_col_step', undefined, locale))}</th><th>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_col_question', undefined, locale))}</th><th>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_col_stage', undefined, locale))}</th><th>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_col_verb', undefined, locale))}</th><th>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_col_method', undefined, locale))}</th></tr></thead><tbody>${stepRows}</tbody></table></section>`;
  } else {
    stepsSection = `<section><p>${escapeHtml(catalogT('front_desk:hearing_canvas_work_inventory_steps_empty', undefined, locale))}</p></section>`;
  }

  const pageTitle = catalogT(
    'front_desk:hearing_canvas_work_inventory_page_title',
    undefined,
    locale
  );
  const heading = catalogT('front_desk:hearing_canvas_work_inventory_heading', undefined, locale);
  const colQuestion = catalogT(
    'front_desk:hearing_canvas_work_inventory_col_question',
    undefined,
    locale
  );
  const colAnswer = catalogT(
    'front_desk:hearing_canvas_work_inventory_col_answer',
    undefined,
    locale
  );

  const html = `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pageTitle)}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#faf9f6;color:#26231d}h1{font-size:22px;margin:0 0 16px}h2{font-size:15px;margin:20px 0 8px}table{width:100%;border-collapse:collapse;margin:0 0 16px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e3ddd1;font-size:13px;vertical-align:top}th[scope="row"]{width:28%;color:#706b60;font-weight:600}</style></head><body><h1>${escapeHtml(heading)}</h1><table><thead><tr><th>${escapeHtml(colQuestion)}</th><th>${escapeHtml(colAnswer)}</th></tr></thead><tbody>${rows}</tbody></table>${stepsSection}</body></html>`;

  const sanitized = sanitizeGeneratedCanvasHtml(html);
  if (sanitized.ok) return sanitized.html;
  // Defense in depth only — every value above is our own escaped markup, so
  // the sanitizer should always accept it. If it somehow does not, fail
  // closed to a minimal chrome-only page rather than ever returning
  // unsanitized content.
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><title>${escapeHtml(pageTitle)}</title></head><body><h1>${escapeHtml(heading)}</h1></body></html>`;
}
