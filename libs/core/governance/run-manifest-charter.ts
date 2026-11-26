/**
 * Run-manifest charter issuance at run start (pipeline-run-manifest-model.md
 * §3.1). The runner calls ensureRunManifestCharter once per run, lazily:
 * the trust decision is re-checked against the CURRENT file (content hash,
 * separation of duties, revocation), then the registry issues — or returns
 * the already-issued — charter bound to that approval and manifest.
 *
 * Nothing here accepts a charter on anyone's behalf: the registry derives the
 * charter from the stored human decision and refuses without one.
 */
import {
  countRunManifestScopeRunsToday,
  issueRunManifestCharter,
  readIssuedRunManifestCharter,
  readRunManifestRunUsage,
  type CharterPathOptions,
  type IssuedRunManifestCharter,
  type RunManifestRunUsage,
} from './accountability-charter-registry.js';
import { loadApprovalRequest } from './approval-store-reader.js';
import { DEFAULT_RUN_MANIFEST_RUNS_PER_DAY, runManifestRunDay } from './run-manifest-grant.js';
import type { MemberRegistryPathOptions } from '../organization/member-registry.js';
import type { RunManifest } from '../pipeline/run-manifest.js';
import { assertProjectTrustApproval } from '../project/project-trust.js';
import {
  PROJECT_TRUST_APPROVAL_CHANNEL,
  projectTrustBindingOf,
} from '../project/project-trust-binding.js';

export interface EnsureRunManifestCharterInput {
  /** Approved v2 project-trust request (see findValidRunManifestTrustApproval). */
  approvalRequestId: string;
  /** Manifest the runner compiled from the current file, repository-relative input_path. */
  manifest: RunManifest;
  now?: Date;
  pathOptions?: CharterPathOptions;
  memberOptions?: MemberRegistryPathOptions;
}

export function ensureRunManifestCharter(
  input: EnsureRunManifestCharterInput
): IssuedRunManifestCharter {
  // Current-content trust, human decision and separation-of-duties usability.
  assertProjectTrustApproval(input.approvalRequestId, input.manifest.source.input_path);
  return issueRunManifestCharter(
    {
      approvalRequestId: input.approvalRequestId,
      manifest: input.manifest,
      ...(input.now ? { now: input.now } : {}),
      ...(input.memberOptions ? { memberOptions: input.memberOptions } : {}),
    },
    input.pathOptions ?? {}
  );
}

/**
 * Read-only daily usage for `pnpm pipeline check`: today's (UTC) bound runs
 * across every charter of this tenant + manifest, against the cap of the
 * charter this approval issued. Before the first bound run issued it, the cap
 * is the one the approval binds (or the default for approvals from before the
 * cap). Never issues.
 */
export function runManifestApprovalRunUsage(
  input: { approvalRequestId: string; manifest: RunManifest; now?: Date },
  pathOptions: CharterPathOptions = {}
): RunManifestRunUsage {
  const now = input.now ?? new Date();
  const tenantSlug = input.manifest.scope.tenant_slug;
  const scope = tenantSlug
    ? { tenant_slug: tenantSlug, manifest_hash: input.manifest.manifest_hash }
    : undefined;
  const charter = scope
    ? readIssuedRunManifestCharter(
        { ...scope, approval_request_id: input.approvalRequestId },
        pathOptions
      )
    : null;
  if (charter) return readRunManifestRunUsage(charter, pathOptions, now);
  const record = loadApprovalRequest(PROJECT_TRUST_APPROVAL_CHANNEL, input.approvalRequestId);
  const binding = record ? projectTrustBindingOf(record) : undefined;
  return {
    day: runManifestRunDay(now),
    runs_today: scope ? countRunManifestScopeRunsToday(scope, pathOptions, now) : 0,
    runs_per_day:
      (binding?.version === 2 ? binding.runs_per_day : undefined) ??
      DEFAULT_RUN_MANIFEST_RUNS_PER_DAY,
  };
}
