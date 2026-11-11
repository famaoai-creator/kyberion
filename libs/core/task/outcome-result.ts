/**
 * Result is a derived view of an Outcome, outputs, criterion evidence and delivery.
 * It is not another work ledger or a permission/completion decision.
 * Callers supply already authorized records; this module performs no I/O.
 */
import type { OutcomeContract } from './outcome-contract.js';
import type { TaskResultBlock } from '../surface/channel-surface-types.js';
import type { ArtifactRecord } from '../workforce/artifact-record.js';

export type OutcomeEvidenceStatus = 'unassessed' | 'reported_passed' | 'reported_failed';

export interface OutcomeResult {
  model_version: 1;
  outcome_id: string;
  requested_result: string;
  summary: string;
  /** References describe outputs, without claiming that bytes were checked. */
  artifacts: Array<{ ref: string; kind?: string }>;
  verification: {
    status: OutcomeEvidenceStatus | 'partial';
    /** The requested method; not proof that the method was performed. */
    method: OutcomeContract['verification_method'];
    criteria: Array<{ criterion: string; status: OutcomeEvidenceStatus; evidence: string[] }>;
    reported_checks: string[];
  };
  delivery: {
    status: 'unknown' | 'pending' | 'delivered' | 'failed' | 'partial';
    untracked_artifact_refs: string[];
    /** Current source states; delivered does not mean read or accepted by a human. */
    bindings: Array<{
      artifact_ref: string;
      binding_id: string;
      status: 'pending' | 'delivered' | 'failed';
      external_url?: string;
    }>;
  };
  gaps: string[];
  needs: string[];
}

export interface OutcomeResultInput {
  contract: OutcomeContract;
  summary?: string;
  /** A validated worker report, never independent verification. */
  taskResult?: TaskResultBlock;
  artifactRefs?: Array<string | null | undefined>;
  /** Existing scope-authorized records, not IDs to resolve across scopes. */
  artifactRecords?: readonly ArtifactRecord[];
}

function distinctText(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim() || '').filter(Boolean))];
}

/** Project facts without promoting artifact existence, prose checks or delivery into success. */
export function projectOutcomeResult(input: OutcomeResultInput): OutcomeResult {
  const report = input.taskResult;
  const artifacts = new Map<string, { ref: string; kind?: string }>();
  const addArtifact = (ref: string | undefined | null, kind?: string): void => {
    const normalized = ref?.trim();
    if (normalized) artifacts.set(normalized, { ref: normalized, ...(kind ? { kind } : {}) });
  };
  for (const ref of input.artifactRefs || []) addArtifact(ref);
  for (const artifact of report?.artifacts || []) addArtifact(artifact.path, artifact.kind);
  const bindings: OutcomeResult['delivery']['bindings'] = [];
  const trackedArtifactRefs = new Set<string>();
  for (const artifact of input.artifactRecords || []) {
    const ref = `artifact:${artifact.artifact_id}`;
    addArtifact(ref, artifact.kind);
    if (artifact.delivered_to?.length) {
      for (const alias of [ref, artifact.path, artifact.external_ref]) {
        if (alias?.trim()) trackedArtifactRefs.add(alias.trim());
      }
    }
    for (const binding of artifact.delivered_to || []) {
      bindings.push({ artifact_ref: ref, ...binding });
    }
  }

  const criteria = distinctText(input.contract.success_criteria).map((criterion) => {
    const reports = (report?.acceptance_evidence || []).filter(
      (entry) => entry.criterion.trim() === criterion
    );
    const status: OutcomeEvidenceStatus = reports.some((entry) => entry.status === 'failed')
      ? 'reported_failed'
      : reports.some((entry) => entry.status === 'passed' && entry.evidence.trim())
        ? 'reported_passed'
        : 'unassessed';
    return { criterion, status, evidence: distinctText(reports.map((entry) => entry.evidence)) };
  });
  const verificationStatus: OutcomeResult['verification']['status'] = criteria.some(
    (entry) => entry.status === 'reported_failed'
  )
    ? 'reported_failed'
    : criteria.length > 0 && criteria.every((entry) => entry.status === 'reported_passed')
      ? 'reported_passed'
      : criteria.some((entry) => entry.status !== 'unassessed')
        ? 'partial'
        : 'unassessed';
  const untrackedArtifactRefs = [...artifacts.keys()].filter(
    (ref) => !trackedArtifactRefs.has(ref)
  );
  const deliveryStatus: OutcomeResult['delivery']['status'] =
    bindings.length === 0
      ? 'unknown'
      : bindings.some((entry) => entry.status === 'failed')
        ? 'failed'
        : untrackedArtifactRefs.length > 0
          ? 'partial'
          : bindings.every((entry) => entry.status === 'delivered')
            ? 'delivered'
            : bindings.every((entry) => entry.status === 'pending')
              ? 'pending'
              : 'partial';

  return {
    model_version: 1,
    outcome_id: input.contract.outcome_id,
    requested_result: input.contract.requested_result,
    summary: input.summary ?? report?.summary ?? input.contract.requested_result,
    artifacts: [...artifacts.values()],
    verification: {
      status: verificationStatus,
      method: input.contract.verification_method,
      criteria,
      reported_checks: distinctText(report?.verification_done || []),
    },
    delivery: { status: deliveryStatus, bindings, untracked_artifact_refs: untrackedArtifactRefs },
    gaps: distinctText(report?.gaps || []),
    needs: distinctText(report?.needs || []),
  };
}
