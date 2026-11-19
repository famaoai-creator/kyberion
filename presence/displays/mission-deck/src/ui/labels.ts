/**
 * Plain-language labels for machine values that reach the screen.
 * Intent shapes / outcomes reuse the terminal HUD's cockpit vocabulary
 * (one definition per concept); anything unknown is humanised rather than
 * shown as a raw identifier.
 */
import type { VocabularyKey } from '@agent/core/t';

type Tr = (key: VocabularyKey, params?: Record<string, string | number>) => string;

const SHAPES = new Set(['direct_answer', 'task_session', 'mission', 'project_bootstrap']);
const OUTCOMES = new Set([
  'answer',
  'artifact',
  'approval_ready_plan',
  'service_change',
  'status_report',
]);

/** `generate-report` / `task_session` → `generate report` / `task session`. */
export function humanize(value: string | undefined): string {
  return String(value ?? '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function shapeLabel(shape: string | undefined, tr: Tr): string {
  if (!shape) return '';
  return SHAPES.has(shape)
    ? tr(`tui:tui_cockpit_shape_${shape}` as VocabularyKey)
    : humanize(shape);
}

export function outcomeLabel(outcome: string | undefined, tr: Tr): string {
  if (!outcome) return '';
  return OUTCOMES.has(outcome)
    ? tr(`tui:tui_cockpit_outcome_${outcome}` as VocabularyKey)
    : humanize(outcome);
}

/** `evidence/implementation-report.md` → `implementation report`. */
export function artifactTitle(file: string): string {
  const base = file.split(/[\\/]/u).pop() ?? file;
  return humanize(base.replace(/\.[a-z0-9]+$/iu, ''));
}
