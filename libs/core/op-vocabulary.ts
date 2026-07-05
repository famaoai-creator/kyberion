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

export function resolveBrowserRecordingPipelineOp(op: string): string {
  return BROWSER_RECORDING_OP_ALIASES[op] || op;
}

export function listCanonicalOpFamilies(): Record<string, readonly string[]> {
  return CANONICAL_OP_FAMILIES;
}
