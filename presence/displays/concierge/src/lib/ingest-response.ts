const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INGEST_OUTCOMES = new Set(['committed', 'would_commit', 'duplicate']);

export type ConciergeIngestSummary = {
  dry_run: boolean;
  outcome: 'committed' | 'would_commit' | 'duplicate';
  target_path?: string;
  file_name: string;
  tenant: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

export function parseConciergeIngestResponse(
  value: unknown,
  expected?: { tenant: string; dryRun: boolean }
):
  | {
      summary: ConciergeIngestSummary;
      message: string;
    }
  | undefined {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !hasSafeTree(value) ||
    !isRecord(value.summary) ||
    typeof value.message !== 'string'
  ) {
    return undefined;
  }
  const summary = value.summary;
  if (
    typeof summary.dry_run !== 'boolean' ||
    typeof summary.outcome !== 'string' ||
    !INGEST_OUTCOMES.has(summary.outcome) ||
    (summary.dry_run && summary.outcome === 'committed') ||
    (!summary.dry_run && summary.outcome === 'would_commit') ||
    (expected !== undefined &&
      (summary.tenant !== expected.tenant || summary.dry_run !== expected.dryRun)) ||
    (summary.target_path !== undefined && typeof summary.target_path !== 'string') ||
    typeof summary.file_name !== 'string' ||
    typeof summary.tenant !== 'string'
  ) {
    return undefined;
  }
  return {
    summary: {
      dry_run: summary.dry_run,
      outcome: summary.outcome as ConciergeIngestSummary['outcome'],
      ...(summary.target_path === undefined ? {} : { target_path: summary.target_path as string }),
      file_name: summary.file_name,
      tenant: summary.tenant,
    },
    message: value.message,
  };
}

/** Only known pre-execution rejection statuses use this bounded, text-only detail. */
export function parseConciergeIngestError(value: unknown): string | undefined {
  return isRecord(value) &&
    value.ok === false &&
    hasSafeTree(value) &&
    typeof value.error === 'string' &&
    value.error.trim().length > 0 &&
    value.error.length <= 500
    ? value.error
    : undefined;
}
