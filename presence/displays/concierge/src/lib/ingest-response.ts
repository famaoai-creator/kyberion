import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INGEST_OUTCOMES = new Set(['committed', 'would_commit', 'duplicate']);

export type ConciergeIngestSummary = {
  dry_run: boolean;
  outcome: 'committed' | 'would_commit' | 'duplicate';
  target_path?: string;
  file_name: string;
  tenant: string;
  scope?: WorkspaceSelection;
  selectedWorkspace?: WorkspaceSelection;
  inheritedScope?: 'organization';
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

function parseScope(value: unknown): WorkspaceSelection | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const key of ['tenant_slug', 'organization_id', 'project_id', 'operation_id', 'tier']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim()) return undefined;
    result[key] = value[key];
  }
  if (result.tier && !['public', 'confidential', 'personal'].includes(result.tier))
    return undefined;
  if (result.project_id && result.operation_id) return undefined;
  return result as WorkspaceSelection;
}

export function parseConciergeIngestResponse(
  value: unknown,
  expected?: {
    tenant: string;
    dryRun: boolean;
    selection?: Partial<Record<keyof WorkspaceSelection, string>>;
  }
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
  const scope = summary.scope === undefined ? undefined : parseScope(summary.scope);
  const selectedWorkspace =
    summary.selectedWorkspace === undefined ? undefined : parseScope(summary.selectedWorkspace);
  if (
    (summary.scope !== undefined && !scope) ||
    (summary.selectedWorkspace !== undefined && !selectedWorkspace) ||
    (summary.inheritedScope !== undefined && summary.inheritedScope !== 'organization')
  )
    return undefined;
  if (selectedWorkspace) {
    if ((selectedWorkspace.tenant_slug || '') !== summary.tenant) return undefined;
    for (const [key, requested] of Object.entries(expected?.selection || {})) {
      if (requested && selectedWorkspace[key as keyof WorkspaceSelection] !== requested)
        return undefined;
    }
    if (
      scope &&
      ['tenant_slug', 'organization_id', 'project_id', 'tier'].some(
        (key) =>
          scope[key as keyof WorkspaceSelection] !==
          selectedWorkspace[key as keyof WorkspaceSelection]
      )
    )
      return undefined;
  }
  if (
    typeof summary.dry_run !== 'boolean' ||
    typeof summary.outcome !== 'string' ||
    !INGEST_OUTCOMES.has(summary.outcome) ||
    (summary.dry_run && summary.outcome === 'committed') ||
    (!summary.dry_run && summary.outcome === 'would_commit') ||
    (expected !== undefined &&
      (((expected.tenant || !selectedWorkspace) && summary.tenant !== expected.tenant) ||
        summary.dry_run !== expected.dryRun)) ||
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
      ...(scope ? { scope } : {}),
      ...(selectedWorkspace ? { selectedWorkspace } : {}),
      ...(summary.inheritedScope === 'organization'
        ? { inheritedScope: 'organization' as const }
        : {}),
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
