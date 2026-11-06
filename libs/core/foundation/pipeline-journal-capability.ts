/**
 * Tenant pipeline run journal store grant (G2 of the store-catalog guard design).
 *
 * The exact ceiling of one confidential library run journal
 * (`pipelineJournalCapability`) is issued only as an opaque, synchronous grant
 * of this module's private issuer (`withPipelineJournalCapability`,
 * import-restricted to pipeline/pipeline-run-journal.ts by
 * tests/pipeline-journal-capability-boundary.test.ts). A structural lookalike,
 * a copy, a grant of another issuer, a captured continuation or a grant of a
 * second module instance resolves nothing (`isPipelineJournalCapability`).
 */
import {
  createSynchronousResourceGrantIssuer,
  type ResourceAccessScope,
} from './resource-access-scope.js';
import * as path from 'node:path';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

/** Narrow store role that writes one tenant's confidential library pipeline run journal. */
export const PIPELINE_JOURNAL_STORE_ROLE = 'pipeline_journal_store';

const ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.pipeline_library_runs;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/u;
const SANDBOX =
  /^active\/shared\/runtime\/vitest-live\/pool-[\w-]+\/shared\/runtime\/pipeline-library-runs$/u;

/**
 * Internal store ceiling for one run journal file, its writer lease and lease
 * metrics, the directories leading to them (writes only), and product schema
 * reads; a read capability has no write or mkdir path. Contains
 * no caller-supplied path outside the tenant's own confidential journal partition.
 */
export function pipelineJournalCapability(
  tenantSlug: string,
  journalFile: string,
  write = true
): ResourceAccessScope {
  if (!isValidTenantSlug(tenantSlug))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid pipeline journal tenant');
  const directory = path.posix.dirname(journalFile);
  const root = path.posix.dirname(path.posix.dirname(directory));
  if (
    path.posix.normalize(journalFile) !== journalFile ||
    !FILE.test(path.posix.basename(journalFile)) ||
    directory !== root + '/confidential/' + tenantSlug ||
    !(root === ROOT || (getProcessEnv('VITEST') && SANDBOX.test(root)))
  )
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid pipeline journal path');
  const files = [
    journalFile,
    directory + '/writer-lease.json',
    directory + '/writer-lease-metrics.json',
  ];
  return {
    tenantSlug,
    readExact: files,
    writeExact: write ? files : [],
    mkdirExact: write ? [root, root + '/confidential', directory] : [],
    // Journal and lease envelopes validate against product schemas.
    allowProductKnowledgeRead: true,
  };
}

interface PipelineJournalBinding {
  readonly tenantSlug: string;
  readonly journalFile: string;
  readonly write: boolean;
}
const grants = createSynchronousResourceGrantIssuer<PipelineJournalBinding>(
  'PIPELINE_JOURNAL_CAPABILITY'
);

/**
 * Internal synchronous issuer of the exact journal ceiling, import-restricted to
 * pipeline/pipeline-run-journal.ts. The opaque grant exists only while `internalFn` runs.
 */
export function withPipelineJournalCapability<T>(
  tenantSlug: string,
  journalFile: string,
  write: boolean,
  internalFn: () => T
): T {
  const binding: PipelineJournalBinding = Object.freeze({
    tenantSlug,
    journalFile,
    write: write === true,
  });
  return grants.run(
    binding,
    pipelineJournalCapability(tenantSlug, journalFile, binding.write),
    internalFn
  );
}

/** Pure mandatory guard: only this issuer's live grant with its exact ceiling resolves. */
export function isPipelineJournalCapability(scope: ResourceAccessScope | undefined): boolean {
  const grant = grants.resolve(scope);
  if (!grant || !scope) return false;
  if (
    scope.tenantSlug !== grant.binding.tenantSlug ||
    scope.readExact[0] !== grant.binding.journalFile ||
    scope.writeExact.length > 0 !== grant.binding.write ||
    (scope.appendExact?.length ?? 0) !== 0 ||
    (scope.namePrefixExact?.length ?? 0) !== 0 ||
    scope.organizationId ||
    scope.projectId ||
    scope.allowProductKnowledgeRead !== true ||
    (scope.metadataExact?.length ?? 0) !== 0
  )
    return false;
  try {
    const expected = pipelineJournalCapability(
      scope.tenantSlug,
      scope.readExact[0] ?? '',
      scope.writeExact.length > 0
    );
    return (
      JSON.stringify(scope.readExact) === JSON.stringify(expected.readExact) &&
      JSON.stringify(scope.writeExact) === JSON.stringify(expected.writeExact) &&
      JSON.stringify(scope.mkdirExact) === JSON.stringify(expected.mkdirExact)
    );
  } catch {
    return false;
  }
}
