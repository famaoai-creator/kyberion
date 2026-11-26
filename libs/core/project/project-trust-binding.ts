/**
 * Project-trust binding payloads (pipeline-run-manifest-model.md §3.1).
 *
 * v1 binds one exact file: `{input_path, content_hash}`.
 * v2 additionally binds the compiled Run Manifest and the run principals the
 * approver allowed: `{version: 2, input_path, content_hash, manifest_hash,
 * principal_modes, runs_per_day}` (`runs_per_day` absent on records from
 * before the daily cap). Both remain valid trust decisions for the file; only a v2
 * record can issue a run-manifest charter.
 *
 * The v2 facts are also written into `justification.requestedEffects`, which
 * the presented digest covers, so a verified human decision binds them twice
 * (payload hash + what the decider was shown). Kept free of charter-registry
 * imports so the registry can re-verify an issuance without an import cycle.
 */
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  DEFAULT_RUN_MANIFEST_RUNS_PER_DAY,
  DEFAULT_RUN_PRINCIPAL_MODES,
  MAX_RUN_MANIFEST_RUNS_PER_DAY,
  parseRunPrincipalModes,
  parseRunsPerDay,
  type RunPrincipalMode,
} from '../governance/run-manifest-grant.js';
import { RUN_MANIFEST_HASH_PATTERN } from '../foundation/charter-scope.js';

export const PROJECT_TRUST_APPROVAL_CHANNEL = 'project-trust';

const MANIFEST_EFFECT_PREFIX = 'run-manifest:';
const PRINCIPAL_EFFECT_PREFIX = 'run-principals:';
const RUNS_PER_DAY_EFFECT_PREFIX = 'run-runs-per-day:';

export function projectTrustEffectBinding(relativePath: string): string {
  return `project-trust:${relativePath}`;
}

export interface ProjectTrustManifestBinding {
  manifest_hash: string;
  principal_modes: RunPrincipalMode[];
  /**
   * Daily run cap the approver chose. Every new v2 request binds it; a v2
   * record from before the field has none (the charter then applies
   * DEFAULT_RUN_MANIFEST_RUNS_PER_DAY) and its payload omits the key.
   */
  runs_per_day?: number;
}

export function projectTrustBindingPayloadV1(
  relativePath: string,
  contentHash: string
): Record<string, string> {
  return { input_path: relativePath, content_hash: contentHash };
}

export function projectTrustBindingPayloadV2(
  relativePath: string,
  contentHash: string,
  manifest: ProjectTrustManifestBinding
): Record<string, unknown> {
  return {
    version: 2,
    input_path: relativePath,
    content_hash: contentHash,
    manifest_hash: manifest.manifest_hash,
    principal_modes: [...manifest.principal_modes],
    ...(manifest.runs_per_day !== undefined ? { runs_per_day: manifest.runs_per_day } : {}),
  };
}

/** The `requestedEffects` lines that carry the v2 facts on the record. */
export function projectTrustRequestedEffects(
  relativePath: string,
  manifest?: ProjectTrustManifestBinding
): string[] {
  return [
    projectTrustEffectBinding(relativePath),
    ...(manifest
      ? [
          `${MANIFEST_EFFECT_PREFIX}${manifest.manifest_hash}`,
          `${PRINCIPAL_EFFECT_PREFIX}${manifest.principal_modes.join(',')}`,
          ...(manifest.runs_per_day !== undefined
            ? [`${RUNS_PER_DAY_EFFECT_PREFIX}${manifest.runs_per_day}`]
            : []),
        ]
      : []),
  ];
}

export type ProjectTrustBindingVersion =
  | { version: 1 }
  | ({ version: 2 } & ProjectTrustManifestBinding)
  | { version: 'invalid'; reason: string };

/** Which binding a stored project-trust record carries (never trusted on its own). */
export function projectTrustBindingOf(
  record: Pick<ApprovalRequestRecord, 'justification'>
): ProjectTrustBindingVersion {
  const effects = record.justification?.requestedEffects ?? [];
  const manifests = effects.filter((effect) => effect.startsWith(MANIFEST_EFFECT_PREFIX));
  const principals = effects.filter((effect) => effect.startsWith(PRINCIPAL_EFFECT_PREFIX));
  const caps = effects.filter((effect) => effect.startsWith(RUNS_PER_DAY_EFFECT_PREFIX));
  if (manifests.length === 0 && principals.length === 0 && caps.length === 0) return { version: 1 };
  if (manifests.length !== 1 || principals.length !== 1 || caps.length > 1)
    return { version: 'invalid', reason: 'ambiguous run-manifest binding' };
  const manifestHash = manifests[0].slice(MANIFEST_EFFECT_PREFIX.length);
  const modes = parseRunPrincipalModes(
    principals[0].slice(PRINCIPAL_EFFECT_PREFIX.length).split(',')
  );
  const runsPerDay =
    caps.length === 1 ? parseRunsPerDay(caps[0].slice(RUNS_PER_DAY_EFFECT_PREFIX.length)) : null;
  if (!RUN_MANIFEST_HASH_PATTERN.test(manifestHash) || !modes || runsPerDay === undefined)
    return { version: 'invalid', reason: 'malformed run-manifest binding' };
  return {
    version: 2,
    manifest_hash: manifestHash,
    principal_modes: modes,
    ...(runsPerDay !== null ? { runs_per_day: runsPerDay } : {}),
  };
}

/** Expected `accountability.payloadHash` of a record for this file content. */
export function expectedProjectTrustPayloadHash(
  record: Pick<ApprovalRequestRecord, 'justification'>,
  relativePath: string,
  contentHash: string
): string | undefined {
  const binding = projectTrustBindingOf(record);
  if (binding.version === 'invalid') return undefined;
  return computeApprovalPayloadHash(
    binding.version === 1
      ? projectTrustBindingPayloadV1(relativePath, contentHash)
      : projectTrustBindingPayloadV2(relativePath, contentHash, binding)
  );
}

/** Canonical principal modes for a new request: attended unless explicitly widened. */
export function requestedPrincipalModes(
  value: readonly RunPrincipalMode[] | undefined
): RunPrincipalMode[] {
  const modes = parseRunPrincipalModes(value ?? DEFAULT_RUN_PRINCIPAL_MODES);
  if (!modes) {
    throw new Error(
      `[PROJECT_TRUST_PRINCIPAL] principal modes must be distinct values of attended|unattended — got ${JSON.stringify(value)} | next: pass ['attended'] or ['attended','unattended']`
    );
  }
  return modes;
}

/** Canonical daily run cap for a new request: the approver's value, or the default. */
export function requestedRunsPerDay(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RUN_MANIFEST_RUNS_PER_DAY;
  const parsed = parseRunsPerDay(value);
  if (parsed === undefined) {
    throw new Error(
      `[PROJECT_TRUST_RUN_LIMIT] runs per day must be an integer from 1 to ${MAX_RUN_MANIFEST_RUNS_PER_DAY} — got ${JSON.stringify(value)} | next: pass --runs-per-day <N> (default ${DEFAULT_RUN_MANIFEST_RUNS_PER_DAY})`
    );
  }
  return parsed;
}
