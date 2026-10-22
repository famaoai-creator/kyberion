import type { ResourceAccessScope } from './resource-access-scope.js';
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

export function isPipelineJournalCapability(scope: ResourceAccessScope | undefined): boolean {
  if (
    !scope ||
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
