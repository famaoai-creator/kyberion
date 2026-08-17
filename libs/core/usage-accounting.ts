/** PI-01: stable usage-cause vocabulary and accounting helpers. */
export const USAGE_CAUSES = [
  'assistant',
  'tool',
  'hook',
  'compaction',
  'branch_summary',
  'deferred_fetch',
  'judge',
  'subagent',
  'repair',
  'adjustment',
] as const;

export type UsageCause = (typeof USAGE_CAUSES)[number];

export function normalizeUsageCause(value: unknown): UsageCause {
  return typeof value === 'string' && (USAGE_CAUSES as readonly string[]).includes(value)
    ? (value as UsageCause)
    : 'assistant';
}
