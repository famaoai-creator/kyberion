import { logger } from './core.js';

export const CANONICAL_OP_FAMILIES = {
  io: ['read', 'write', 'append', 'copy', 'move', 'delete', 'mkdir', 'stat', 'exists', 'glob'],
  capture: ['screen', 'page', 'window'],
  net: ['fetch'],
  transform: ['regex', 'json_query', 'json_parse', 'template'],
  core: ['if', 'foreach', 'while', 'include', 'wait', 'transform', 'set', 'log', 'notify'],
} as const;

export const BROWSER_RECORDING_OP_ALIASES: Record<string, string> = {
  click_ref: 'click',
  fill_ref: 'fill',
  select_ref: 'click',
  submit_form: 'click',
};

export const BROWSER_PIPELINE_OP_ALIASES: Record<string, string> = {
  snapshot: 'snapshot',
  screenshot: 'screenshot',
  click_ref: 'click',
  fill_ref: 'fill',
  select_ref: 'click',
  submit_form: 'click',
  press_ref: 'press',
  wait_ref: 'wait',
};

const warnedBrowserOpAliases = new Set<string>();

function warnDeprecatedBrowserOpAlias(
  domain: 'recording' | 'pipeline',
  op: string,
  canonical: string
): void {
  if (op === canonical) return;
  const warningKey = `${domain}:${op}`;
  if (warnedBrowserOpAliases.has(warningKey)) return;
  warnedBrowserOpAliases.add(warningKey);
  logger.warn(`[op-vocabulary] ${domain} alias "${op}" is deprecated; use "${canonical}" instead.`);
}

export function resolveBrowserRecordingPipelineOp(op: string): string {
  const canonical = BROWSER_RECORDING_OP_ALIASES[op] || op;
  warnDeprecatedBrowserOpAlias('recording', op, canonical);
  return canonical;
}

export function normalizeBrowserPipelineOp(op: string): string {
  const canonical = BROWSER_PIPELINE_OP_ALIASES[op] || op;
  warnDeprecatedBrowserOpAlias('pipeline', op, canonical);
  return canonical;
}

export function listCanonicalOpFamilies(): Record<string, readonly string[]> {
  return CANONICAL_OP_FAMILIES;
}
