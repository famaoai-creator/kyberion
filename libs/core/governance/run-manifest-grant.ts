/**
 * Run-manifest grants — the only external-operation grant shape a
 * `run_manifest` charter may hold, and the pure check the runtime gate uses to
 * admit one browser effect against one approved manifest entry
 * (pipeline-run-manifest-model.md §3.1–3.2).
 *
 * A grant is bound to one manifest hash and one step path; it carries what
 * verification needs (target, page origins, authored-params hash, occurrence
 * bound, secret origins) so the gate never re-reads the pipeline to decide.
 */
import { isRecord } from '../foundation/primitives.js';
import { isManifestBindableOperation } from '../foundation/authorization-registry.js';
import { RUN_MANIFEST_HASH_PATTERN } from '../foundation/charter-scope.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { pipelineTemplateMatches } from '../pipeline/pipeline-template.js';
import type { EffectManifestEntry, ManifestTarget, RunManifest } from '../pipeline/run-manifest.js';

/**
 * Who executes a run (pipeline-run-manifest-model.md §4): `attended` = the
 * owner is at the terminal; `unattended` = a worker or resident Dot. A
 * run-manifest charter admits only the modes the approver chose.
 */
export const RUN_PRINCIPAL_MODES = ['attended', 'unattended'] as const;
export type RunPrincipalMode = (typeof RUN_PRINCIPAL_MODES)[number];
/** Approval default: unattended use must be enabled explicitly on the card. */
export const DEFAULT_RUN_PRINCIPAL_MODES: readonly RunPrincipalMode[] = Object.freeze(['attended']);

export function isRunPrincipalMode(value: unknown): value is RunPrincipalMode {
  return (RUN_PRINCIPAL_MODES as readonly unknown[]).includes(value);
}

/** Canonical (sorted, distinct, non-empty) principal modes, or undefined when invalid. */
export function parseRunPrincipalModes(value: unknown): RunPrincipalMode[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRunPrincipalMode))
    return undefined;
  const modes = [...new Set(value)];
  if (modes.length !== value.length) return undefined;
  return RUN_PRINCIPAL_MODES.filter((mode) => modes.includes(mode));
}

/**
 * Daily run cap of a run-manifest charter (pipeline-run-manifest-model.md
 * §3.1): the approver picks it on the card; approvals that predate the field
 * (and charters issued from them) get this default.
 */
export const DEFAULT_RUN_MANIFEST_RUNS_PER_DAY = 20;
export const MAX_RUN_MANIFEST_RUNS_PER_DAY = 1000;

/** A valid daily run cap (integer 1..1000), or undefined. */
export function parseRunsPerDay(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return typeof parsed === 'number' &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= MAX_RUN_MANIFEST_RUNS_PER_DAY
    ? parsed
    : undefined;
}

/**
 * The run-cap day of a timestamp: the UTC calendar date (YYYY-MM-DD), the same
 * boundary as a charter's money `per_day`. Runs reset at 00:00 UTC.
 */
export function runManifestRunDay(at: Date | string): string {
  return (typeof at === 'string' ? at : at.toISOString()).slice(0, 10);
}

/** Distinct run ids started on `day` (UTC) among a charter's ledger entries. */
export function countRunManifestRunsOnDay(
  entries: readonly { kind: string; ts?: string; run_id?: string }[],
  day: string
): number {
  const runs = new Set<string>();
  for (const entry of entries)
    if (
      entry.kind === 'run_started' &&
      entry.run_id &&
      entry.ts &&
      runManifestRunDay(entry.ts) === day
    )
      runs.add(entry.run_id);
  return runs.size;
}

export interface RunManifestGrant {
  operation_id: string;
  manifest_hash: string;
  entry_id: string;
  target?: ManifestTarget;
  origins: string[];
  params_template_hash: string;
  max_occurrences: number;
  /** Secret reference → origins its value may be typed into or sent to. */
  secret_origins?: Record<string, string[]>;
}

const MAX_MANIFEST_GRANTS = 512;
const ENTRY_ID_PATTERN = /^\d+(\.[A-Za-z_]+|\.\d+)*$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const GRANT_KEYS = new Set([
  'operation_id',
  'manifest_hash',
  'entry_id',
  'target',
  'origins',
  'params_template_hash',
  'max_occurrences',
  'secret_origins',
]);

function canonicalOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseOrigins(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const origins = value.map(canonicalOrigin);
  if (origins.some((origin) => !origin)) return undefined;
  return origins as string[];
}

function parseTarget(value: unknown): ManifestTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'url' && Object.keys(value).length === 2 && typeof value.url === 'string') {
    try {
      const url = new URL(value.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
      if (url.username || url.password || url.href !== value.url) return undefined;
      return { kind: 'url', url: url.href };
    } catch {
      return undefined;
    }
  }
  if (
    value.kind === 'origin_path' &&
    Object.keys(value).length === 3 &&
    canonicalOrigin(value.origin) &&
    typeof value.path_prefix === 'string' &&
    value.path_prefix.startsWith('/')
  )
    return { kind: 'origin_path', origin: value.origin as string, path_prefix: value.path_prefix };
  return undefined;
}

/** Strict parse: every field required for verification, nothing else. */
export function parseRunManifestGrant(raw: unknown): RunManifestGrant | undefined {
  if (!isRecord(raw)) return undefined;
  if (Object.keys(raw).some((key) => !GRANT_KEYS.has(key))) return undefined;
  const {
    operation_id: operationId,
    manifest_hash: manifestHash,
    entry_id: entryId,
    params_template_hash: paramsHash,
    max_occurrences: maxOccurrences,
  } = raw;
  if (typeof operationId !== 'string' || !isManifestBindableOperation(operationId))
    return undefined;
  if (typeof manifestHash !== 'string' || !RUN_MANIFEST_HASH_PATTERN.test(manifestHash))
    return undefined;
  if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) return undefined;
  if (typeof paramsHash !== 'string' || !HASH_PATTERN.test(paramsHash)) return undefined;
  if (typeof maxOccurrences !== 'number' || !Number.isInteger(maxOccurrences) || maxOccurrences < 1)
    return undefined;
  const origins = parseOrigins(raw.origins);
  if (!origins || origins.length === 0) return undefined;
  const navigation = operationId === 'browser:goto' || operationId === 'browser:open_tab';
  const target = raw.target === undefined ? undefined : parseTarget(raw.target);
  if (navigation !== (target !== undefined)) return undefined;
  let secretOrigins: Record<string, string[]> | undefined;
  if (raw.secret_origins !== undefined) {
    if (!isRecord(raw.secret_origins)) return undefined;
    secretOrigins = {};
    for (const [ref, value] of Object.entries(raw.secret_origins)) {
      const parsed = parseOrigins(value);
      if (!ref.trim() || !parsed || parsed.length === 0) return undefined;
      secretOrigins[ref] = parsed;
    }
  }
  return {
    operation_id: operationId,
    manifest_hash: manifestHash,
    entry_id: entryId,
    ...(target ? { target } : {}),
    origins,
    params_template_hash: paramsHash,
    max_occurrences: maxOccurrences,
    ...(secretOrigins ? { secret_origins: secretOrigins } : {}),
  };
}

/** Parse a whole grant list; undefined when any grant is invalid or repeated. */
export function parseRunManifestGrants(raw: unknown): RunManifestGrant[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_MANIFEST_GRANTS) return undefined;
  const grants = raw.map(parseRunManifestGrant);
  if (grants.some((grant) => !grant)) return undefined;
  const ids = new Set(grants.map((grant) => `${grant!.manifest_hash}:${grant!.entry_id}`));
  return ids.size === grants.length ? (grants as RunManifestGrant[]) : undefined;
}

/** The secret references a manifest entry reads, from its argument origins. */
function entrySecretRefs(entry: EffectManifestEntry): string[] {
  return [
    ...new Set(
      Object.values(entry.argument_origins)
        .filter((origin) => origin.startsWith('secret:'))
        .map((origin) => origin.slice('secret:'.length))
    ),
  ];
}

/**
 * Each secret's own origin (the page it was authored for), never the
 * manifest's full origin set; undefined when any secret has none.
 */
function entrySecretOrigins(entry: EffectManifestEntry): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const ref of entrySecretRefs(entry)) {
    const origins = entry.secret_origins?.[ref];
    if (!origins?.length) return undefined;
    out[ref] = [...origins];
  }
  return out;
}

/** Grants for every bindable entry of a manifest (what a charter would carry). */
export function runManifestGrantsFor(manifest: RunManifest): RunManifestGrant[] {
  return manifest.requirements.effects.flatMap((entry) => {
    if (!entry.bindable || entry.max_occurrences === null || entry.origins.length === 0) return [];
    const secrets = entrySecretRefs(entry);
    const secretOrigins = entrySecretOrigins(entry);
    // A secret without a bound origin is never granted (the compiler marks it unbindable).
    if (secrets.length && !secretOrigins) return [];
    return [
      {
        operation_id: entry.operation_id,
        manifest_hash: manifest.manifest_hash,
        entry_id: entry.entry_id,
        ...(entry.target ? { target: entry.target } : {}),
        origins: [...entry.origins],
        params_template_hash: entry.params_template_hash,
        max_occurrences: entry.max_occurrences,
        ...(secrets.length && secretOrigins ? { secret_origins: secretOrigins } : {}),
      },
    ];
  });
}

export type ManifestEffectVerdict = { ok: true } | { ok: false; reason: string };

export interface VerifyManifestEffectOptions {
  /** Operation id the runtime is admitting (`browser:goto`, `browser:evaluate`, …). */
  operationId: string;
  /** 1-based execution count of this entry within the run. */
  occurrence: number;
  /**
   * The runtime-shaped authored (unresolved) params when the runner resolved
   * templates before the browser effect was built. Must hash to the grant and
   * structurally match the effect's `requested_params`.
   */
  authoredParams?: Record<string, unknown>;
}

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function targetMatches(target: ManifestTarget, rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (target.kind === 'url') return url.href === target.url;
  return (
    url.origin === target.origin && url.href.slice(url.origin.length).startsWith(target.path_prefix)
  );
}

/**
 * Pure admission check of one runtime browser effect against one manifest
 * grant. The effect is the object the browser runtime hands to
 * runExternalOperation: `{ current_url, requested_params, params, … }`.
 */
export function verifyManifestEntryMatchesEffect(
  rawGrant: RunManifestGrant,
  effect: Record<string, unknown>,
  options: VerifyManifestEffectOptions
): ManifestEffectVerdict {
  const grant = parseRunManifestGrant(rawGrant);
  if (!grant) return { ok: false, reason: 'grant is not a valid run-manifest grant' };
  if (options.operationId !== grant.operation_id)
    return {
      ok: false,
      reason: `operation ${options.operationId} differs from the approved entry`,
    };
  if (!Number.isInteger(options.occurrence) || options.occurrence < 1)
    return { ok: false, reason: 'occurrence must be a positive integer' };
  if (options.occurrence > grant.max_occurrences)
    return {
      ok: false,
      reason: `occurrence ${options.occurrence} exceeds the approved ${grant.max_occurrences}`,
    };

  const requested = effect.requested_params;
  if (!isRecord(requested)) return { ok: false, reason: 'effect has no requested_params' };
  const requestedHash = computeApprovalPayloadHash(requested);
  const exact = requestedHash === grant.params_template_hash;
  const runnerResolved =
    !exact &&
    options.authoredParams !== undefined &&
    computeApprovalPayloadHash(options.authoredParams) === grant.params_template_hash &&
    pipelineTemplateMatches(options.authoredParams, requested);
  if (!exact && !runnerResolved)
    return { ok: false, reason: 'params differ from the approved step' };
  // Runner-resolved values are final: a value resolved a second time (a
  // page-derived "{{password}}" turning into a secret) is not what was approved.
  if (
    runnerResolved &&
    (!isRecord(effect.params) || computeApprovalPayloadHash(effect.params) !== requestedHash)
  )
    return { ok: false, reason: 'params were resolved again after the runner resolved them' };

  const navigation = grant.target !== undefined;
  let destination: string | undefined;
  if (navigation) {
    const params = isRecord(effect.params) ? effect.params : {};
    if (!targetMatches(grant.target!, params.url))
      return { ok: false, reason: 'navigation URL is outside the approved target' };
    destination = originOf(params.url);
  } else {
    destination = originOf(effect.current_url);
    if (!destination || !grant.origins.includes(destination))
      return { ok: false, reason: 'current page origin is not an approved origin' };
  }
  for (const [ref, origins] of Object.entries(grant.secret_origins ?? {})) {
    if (!destination || !origins.includes(destination))
      return {
        ok: false,
        reason: `secret ${ref} may not be sent to ${destination ?? 'this page'}`,
      };
  }
  return { ok: true };
}
