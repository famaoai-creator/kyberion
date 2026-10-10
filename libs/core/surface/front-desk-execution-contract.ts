/** Bounded opt-in diagnostic contract. No policy grants execution approval. */
import { createHash } from 'node:crypto';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';
import { canonicalHumanOwner } from './verified-human-request-identity.js';

export const FRONT_DESK_EXECUTION_POLICY_PATH =
  'knowledge/product/governance/front-desk-execution-policy.json';
export const FRONT_DESK_RECEIPT_PIPELINE = 'pipelines/front-desk-request-receipt.json';
export const FRONT_DESK_RECEIPT_VERSION = 'receipt-v1';
// i18n-exempt: Exact opt-in protocol command, never natural-language intent inference.
export const FRONT_DESK_RECEIPT_COMMAND = 'Create a local diagnostic request receipt artifact.';
import {
  parseFrontDeskArtifactRevisionInput,
  type FrontDeskArtifactRevisionInput,
  type FrontDeskReceiptFormat,
} from './front-desk-artifact-revision-contract.js';
export {
  parseFrontDeskArtifactRevisionInput,
  frontDeskArtifactRevisionCommand,
  type FrontDeskArtifactRevisionInput,
  type FrontDeskReceiptFormat,
} from './front-desk-artifact-revision-contract.js';
export function frontDeskArtifactRevisionDigest(input: FrontDeskArtifactRevisionInput): string {
  const parsed = parseFrontDeskArtifactRevisionInput(input);
  if (!parsed) throw new Error('front_desk_revision_invalid');
  return createHash('sha256')
    .update(JSON.stringify({ kind: 'diagnostic-receipt-format-revision', ...parsed }))
    .digest('hex');
}
export const FIRST_JOB_DIAGNOSTIC_PROTOCOL = 'first-job-v1' as const;
export interface FrontDeskExecutionBinding {
  /** Durable admission provenance; a later charter edit cannot lower this requirement. */
  diagnostic_protocol?: typeof FIRST_JOB_DIAGNOSTIC_PROTOCOL;
  mapping_id: string;
  config_digest: string;
  conversation_key: string;
  request_id: string;
  revision: number;
  request_digest: string;
  work_item_id: string;
  parent_request_id?: string;
  parent_revision?: number;
  parent_sha256?: string;
  receipt_format?: FrontDeskReceiptFormat;
}
export interface FrontDeskExecutionMapping {
  id: string;
  viewer: SurfaceViewerScope;
  dotId: string;
  exactCommand: typeof FRONT_DESK_RECEIPT_COMMAND;
  pipeline: {
    path: typeof FRONT_DESK_RECEIPT_PIPELINE;
    version: typeof FRONT_DESK_RECEIPT_VERSION;
  };
}
export interface FrontDeskExecutionPolicy {
  version: 1;
  mappings: FrontDeskExecutionMapping[];
}
export interface FrontDeskExecutionProjection {
  status:
    | 'queued'
    | 'awaiting_approval'
    | 'running'
    | 'work_completed'
    | 'blocked'
    | 'cancel_requested'
    | 'terminated_unstarted'
    | 'uncertain';
  text: string;
  reportId?: string;
  artifactPath?: string;
  artifactSha256?: string;
  /** Exact bytes decoded as UTF-8 from the successful readback, opt-in only. */
  artifactBody?: string;
}
const policyCatalog = defineCatalog<FrontDeskExecutionPolicy>({
  id: 'front-desk-execution-policy',
  path: () => pathResolver.rootResolve(FRONT_DESK_EXECUTION_POLICY_PATH),
  schema: pathResolver.rootResolve(
    'knowledge/product/schemas/front-desk-execution-policy.schema.json'
  ),
  fallback: { version: 1, mappings: [] },
  fallbackOnInvalid: true,
});
function canonicalSet(values: string[] | 'all'): string[] | 'all' {
  return values === 'all' ? values : [...new Set(values)].sort();
}
function canonicalViewer(viewer: SurfaceViewerScope) {
  const human = canonicalHumanOwner(viewer);
  return {
    ...(human
      ? { human }
      : {
          principal: viewer.principalId ?? null,
          member: viewer.memberId ?? null,
          source: viewer.source,
        }),
    role: viewer.role,
    tenants: canonicalSet(viewer.tenantSlugs),
    organizations: canonicalSet(viewer.organizationIds),
    projects: canonicalSet(viewer.projectIds),
    tiers: canonicalSet(viewer.tierAccess),
  };
}
/** Includes every server-owned identity/restriction, including optional member identity. */
export function frontDeskExecutionViewerFingerprint(viewer: SurfaceViewerScope): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalViewer(viewer)))
    .digest('hex');
}
/** This first diagnostic slice cannot read or materialize protected-tier input. */
export function isFrontDeskExecutionPublicViewer(viewer: SurfaceViewerScope): boolean {
  return (
    Array.isArray(viewer.tierAccess) &&
    viewer.tierAccess.length === 1 &&
    viewer.tierAccess[0] === 'public'
  );
}
export function frontDeskExecutionViewerMatches(
  viewer: SurfaceViewerScope,
  mapping: FrontDeskExecutionMapping
): boolean {
  return (
    // Remote verified-human requests never acquire the separate local diagnostic grant.
    viewer.canonicalHuman === undefined &&
    mapping.viewer.canonicalHuman === undefined &&
    isFrontDeskExecutionPublicViewer(viewer) &&
    isFrontDeskExecutionPublicViewer(mapping.viewer) &&
    viewer.source !== 'anonymous' &&
    Boolean(viewer.principalId?.trim()) &&
    frontDeskExecutionViewerFingerprint(viewer) ===
      frontDeskExecutionViewerFingerprint(mapping.viewer)
  );
}
/** Duplicate IDs or ambiguous viewer mappings enable nothing. No wildcard admission. */
export function loadFrontDeskExecutionPolicy(): FrontDeskExecutionPolicy {
  try {
    // Admission and pre-effect checks must observe revocation even after an equal-size,
    // same-timestamp replacement; a filesystem cache signature is not authority.
    policyCatalog.reset();
    const policy = policyCatalog.load();
    const ids = new Set<string>();
    const viewers = new Set<string>();
    for (const mapping of policy.mappings) {
      if (!isFrontDeskExecutionPublicViewer(mapping.viewer)) return { version: 1, mappings: [] };
      const fingerprint = frontDeskExecutionViewerFingerprint(mapping.viewer);
      if (ids.has(mapping.id) || viewers.has(fingerprint)) return { version: 1, mappings: [] };
      ids.add(mapping.id);
      viewers.add(fingerprint);
    }
    return structuredClone(policy);
  } catch {
    return { version: 1, mappings: [] };
  }
}
/** This first slice admits one local write only; a newly approved digest must
 * never turn the diagnostic receipt label into authority for another effect. */
export function assertFrontDeskReceiptPipeline(raw: string): void {
  const pipeline = parseSafeJsonObjectValue(
    parseSafeJsonInput(raw, 'front desk receipt pipeline'),
    'front desk receipt pipeline'
  );
  if (
    Object.keys(pipeline).some(
      (key) => !['action', 'pipeline_id', 'version', 'description', 'steps'].includes(key)
    ) ||
    pipeline.action !== 'pipeline' ||
    pipeline.pipeline_id !== 'front-desk-request-receipt' ||
    pipeline.version !== '1.0.0' ||
    (pipeline.description !== undefined && typeof pipeline.description !== 'string') ||
    !Array.isArray(pipeline.steps) ||
    pipeline.steps.length !== 1
  )
    throw new Error('front_desk_pipeline_contract_invalid');
  const step = parseSafeJsonObjectValue(pipeline.steps[0], 'front desk receipt step');
  if (
    Object.keys(step).some((key) => !['id', 'role', 'op', 'params'].includes(key)) ||
    step.id !== 'write-request-receipt' ||
    step.role !== 'sink' ||
    step.op !== 'system:write_file'
  )
    throw new Error('front_desk_pipeline_contract_invalid');
  const params = parseSafeJsonObjectValue(step.params, 'front desk receipt params');
  if (
    Object.keys(params).length !== 2 ||
    params.path !== '{{front_desk_output_path}}' ||
    params.content !== '{{front_desk_artifact_content}}'
  )
    throw new Error('front_desk_pipeline_contract_invalid');
}
/** The exact installed pipeline bytes are part of authority, re-read on every inspection. */
export function frontDeskMappingDigest(
  mapping: FrontDeskExecutionMapping,
  pipelineSource?: string
): string {
  if (
    !isFrontDeskExecutionPublicViewer(mapping.viewer) ||
    mapping.pipeline.path !== FRONT_DESK_RECEIPT_PIPELINE ||
    mapping.pipeline.version !== FRONT_DESK_RECEIPT_VERSION ||
    mapping.exactCommand !== FRONT_DESK_RECEIPT_COMMAND
  )
    throw new Error('front_desk_contract_invalid');
  const pipelineBytes =
    pipelineSource ??
    safeReadFile(pathResolver.rootResolve(FRONT_DESK_RECEIPT_PIPELINE), {
      encoding: null,
    });
  assertFrontDeskReceiptPipeline(
    typeof pipelineBytes === 'string' ? pipelineBytes : pipelineBytes.toString('utf8')
  );
  const pipelineDigest = createHash('sha256').update(pipelineBytes).digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: mapping.id,
        viewer: canonicalViewer(mapping.viewer),
        dotId: mapping.dotId,
        exactCommand: mapping.exactCommand,
        pipeline: { path: mapping.pipeline.path, version: mapping.pipeline.version },
        pipelineDigest,
      })
    )
    .digest('hex');
}
export function parseFrontDeskExecutionBinding(
  value: unknown
): FrontDeskExecutionBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fields = [
    'mapping_id',
    'config_digest',
    'conversation_key',
    'request_id',
    'revision',
    'request_digest',
    'work_item_id',
  ];
  const revisionFields = [
    'parent_request_id',
    'parent_revision',
    'parent_sha256',
    'receipt_format',
  ];
  const hasDiagnostic = Object.prototype.hasOwnProperty.call(row, 'diagnostic_protocol');
  const hasRevision = revisionFields.some((key) => row[key] !== undefined);
  const revisionInput = hasRevision
    ? parseFrontDeskArtifactRevisionInput({
        requestId: row.parent_request_id,
        revision: row.parent_revision,
        sha256: row.parent_sha256,
        format: row.receipt_format,
      })
    : undefined;
  if (
    (hasDiagnostic && row.diagnostic_protocol !== FIRST_JOB_DIAGNOSTIC_PROTOCOL) ||
    Object.keys(row).length !== fields.length + (hasRevision ? 4 : 0) + (hasDiagnostic ? 1 : 0) ||
    Object.keys(row).some(
      (key) =>
        !fields.includes(key) &&
        !(hasRevision && revisionFields.includes(key)) &&
        !(hasDiagnostic && key === 'diagnostic_protocol')
    ) ||
    (hasRevision &&
      (!revisionInput ||
        row.revision !== revisionInput.revision + 1 ||
        row.request_id === revisionInput.requestId ||
        row.request_digest !== frontDeskArtifactRevisionDigest(revisionInput))) ||
    (!hasRevision && row.revision !== 1) ||
    typeof row.mapping_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.mapping_id) ||
    typeof row.work_item_id !== 'string' ||
    !/^WI-FD-[a-f0-9]{48}$/.test(row.work_item_id) ||
    typeof row.request_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.request_id) ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    (row.revision as number) > 64 ||
    ['config_digest', 'conversation_key', 'request_digest'].some(
      (key) => typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key] as string)
    )
  )
    return undefined;
  return { ...row } as unknown as FrontDeskExecutionBinding;
}
export function getFrontDeskExecutionMapping(
  binding: FrontDeskExecutionBinding
): FrontDeskExecutionMapping | undefined {
  if (!parseFrontDeskExecutionBinding(binding)) return undefined;
  const mapping = loadFrontDeskExecutionPolicy().mappings.find(
    (entry) => entry.id === binding.mapping_id
  );
  if (!mapping) return undefined;
  try {
    return frontDeskMappingDigest(mapping) === binding.config_digest ? mapping : undefined;
  } catch {
    return undefined;
  }
}
export function frontDeskExecutionExpectedContent(
  binding: FrontDeskExecutionBinding,
  mapping: FrontDeskExecutionMapping,
  sessionId: string
): string {
  return JSON.stringify(
    {
      kind: 'front-desk-request-receipt',
      version: FRONT_DESK_RECEIPT_VERSION,
      request_id: binding.request_id,
      session_id: sessionId,
      request_digest: binding.request_digest,
      revision: binding.revision,
      request_text: mapping.exactCommand,
      ...(binding.parent_request_id
        ? {
            parent_request_id: binding.parent_request_id,
            parent_revision: binding.parent_revision,
            parent_sha256: binding.parent_sha256,
            receipt_format: binding.receipt_format,
          }
        : {}),
    },
    null,
    binding.receipt_format === 'compact' ? undefined : 2
  );
}
