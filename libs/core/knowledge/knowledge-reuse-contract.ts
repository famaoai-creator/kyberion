/** Observation is evidence, never permission to execute or publish. Browser-safe. */
import type { ScopeContext } from '../scope-context.js';

export interface KnowledgeReuseReceipt {
  receipt_id: string;
  source_sha256: string;
  kind: 'delivered' | 'worker_report_complete' | 'incomplete' | 'verified' | 'verification_failed';
  scope?: ScopeContext;
  at: string;
  human_intervention?: boolean;
}

export interface KnowledgeReuseSummary {
  source_sha256: string;
  state: 'unverified' | 'observed' | 'worker_reported' | 'verified';
  deliveries: number;
  attempts: number;
  verified_successes: number;
  worker_reported_successes: number;
  failed_checks: number;
  unconfirmed: number;
  interventions: number;
  intervention_unknown: number;
  /** Independent checks only; load and worker self-report are not success checks. */
  verified_success_rate: number | null;
}

export function parseKnowledgeReuseSummary(value: unknown): KnowledgeReuseSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as KnowledgeReuseSummary;
  if (
    typeof row.source_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.source_sha256) ||
    !['unverified', 'observed', 'worker_reported', 'verified'].includes(row.state)
  )
    return undefined;
  const counters = [
    'deliveries',
    'attempts',
    'verified_successes',
    'worker_reported_successes',
    'failed_checks',
    'unconfirmed',
    'interventions',
    'intervention_unknown',
  ] as const;
  if (counters.some((key) => !Number.isSafeInteger(row[key]) || row[key] < 0)) return undefined;
  const checked = row.verified_successes + row.failed_checks;
  if (row.verified_success_rate !== (checked ? row.verified_successes / checked : null))
    return undefined;
  if (
    row.state !==
    (row.verified_successes
      ? 'verified'
      : row.worker_reported_successes
        ? 'worker_reported'
        : row.deliveries || row.attempts
          ? 'observed'
          : 'unverified')
  )
    return undefined;
  return Object.fromEntries(
    ['source_sha256', 'state', ...counters, 'verified_success_rate'].map((key) => [
      key,
      (row as unknown as Record<string, unknown>)[key],
    ])
  ) as unknown as KnowledgeReuseSummary;
}

export function validKnowledgeReuseReceipt(value: unknown): value is KnowledgeReuseReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as KnowledgeReuseReceipt;
  return (
    typeof row.receipt_id === 'string' &&
    /^[a-f0-9]{64}$/.test(row.receipt_id) &&
    typeof row.source_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(row.source_sha256) &&
    [
      'delivered',
      'worker_report_complete',
      'incomplete',
      'verified',
      'verification_failed',
    ].includes(row.kind) &&
    typeof row.at === 'string' &&
    Number.isFinite(Date.parse(row.at)) &&
    (row.human_intervention === undefined || typeof row.human_intervention === 'boolean') &&
    (row.scope === undefined ||
      (!!row.scope &&
        typeof row.scope === 'object' &&
        ['public', 'confidential', 'personal'].includes(row.scope.tier)))
  );
}

/** Only a selected scope's descendants contribute; never merge projects or tenants. */
export function summarizeKnowledgeReuse(
  receipts: readonly KnowledgeReuseReceipt[],
  sourceSha256: string,
  scope?: ScopeContext
): KnowledgeReuseSummary {
  const selected = new Map<string, KnowledgeReuseReceipt>();
  for (const receipt of receipts) {
    if (!validKnowledgeReuseReceipt(receipt) || receipt.source_sha256 !== sourceSha256) continue;
    if (
      scope
        ? !receipt.scope ||
          Object.entries(scope).some(
            ([key, value]) =>
              value !== undefined &&
              (receipt.scope as unknown as Record<string, unknown>)[key] !== value
          )
        : receipt.scope !== undefined
    )
      continue;
    selected.set(receipt.receipt_id + ':' + receipt.kind, receipt);
  }
  const rows = [...selected.values()];
  const count = (kind: KnowledgeReuseReceipt['kind']) =>
    rows.filter((row) => row.kind === kind).length;
  const attempts = new Map(
    rows.filter((row) => row.kind !== 'delivered').map((row) => [row.receipt_id, row])
  );
  const verified = count('verified');
  const failed = count('verification_failed');
  const reported = count('worker_report_complete');
  return {
    source_sha256: sourceSha256,
    state: verified
      ? 'verified'
      : reported
        ? 'worker_reported'
        : rows.length
          ? 'observed'
          : 'unverified',
    deliveries: count('delivered'),
    attempts: attempts.size,
    verified_successes: verified,
    worker_reported_successes: reported,
    failed_checks: failed,
    unconfirmed: count('incomplete'),
    interventions: [...attempts.values()].filter((row) => row.human_intervention === true).length,
    intervention_unknown: [...attempts.values()].filter(
      (row) => row.human_intervention === undefined
    ).length,
    verified_success_rate: verified + failed ? verified / (verified + failed) : null,
  };
}
