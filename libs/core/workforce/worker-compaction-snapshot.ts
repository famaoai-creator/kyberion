import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { assertSafeRepositoryPath, safeReadFileSnapshot, safeUnlinkSync } from '../secure-io.js';
import type { ScopeContext } from '../scope-context-validation.js';
import type { WorkerStateJournal } from './worker-state-journal.js';
import {
  MAX_COMPACTION_RETENTION_MS,
  DEFAULT_COMPACTION_RETENTION_MS,
  compactionScopeKey,
  compactionSnapshotReceiptSchema,
  type CompactionSnapshotReceipt,
} from './worker-compaction-receipt.js';
import type { ScopedArtifactScope } from './artifact-store.js';
import type { WorkerContextMessage } from './worker-context-compaction.js';

export {
  MAX_COMPACTION_RETENTION_MS,
  DEFAULT_COMPACTION_RETENTION_MS,
  compactionScopeKey,
  compactionSnapshotReceiptSchema,
  type CompactionSnapshotReceipt,
} from './worker-compaction-receipt.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function artifactOwner(scope: ScopeContext): ScopedArtifactScope {
  if (!scope.mission_id) throw new Error('[COMPACTION_SCOPE] A mission scope is required');
  return {
    mission: scope.mission_id,
    ...(scope.task_id ? { task: scope.task_id } : {}),
    ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
    ...(scope.organization_id ? { organization: scope.organization_id } : {}),
    ...(scope.project_id ? { project: scope.project_id } : {}),
  };
}

/** Immutable internal artifact, never published. Deadline bounds recovery, not publication authority. */
export async function writeCompactionSnapshot(input: {
  source: readonly WorkerContextMessage[];
  messages: readonly WorkerContextMessage[];
  scope: ScopeContext;
  parent?: CompactionSnapshotReceipt;
  retentionMs?: number;
  now?: number;
  canCommit?: () => boolean;
}): Promise<CompactionSnapshotReceipt> {
  const { writeScopedArtifact } = await import('./artifact-store.js');
  if (input.canCommit?.() === false)
    throw new Error('[COMPACTION_CANCELLED] Snapshot attempt superseded');
  const scopeKey = compactionScopeKey(input.scope);
  if (input.parent && input.parent.scopeKey !== scopeKey)
    throw new Error('[COMPACTION_SCOPE] Parent scope changed');
  const retention = input.retentionMs ?? DEFAULT_COMPACTION_RETENTION_MS;
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(retention) ||
    retention <= 0 ||
    retention > MAX_COMPACTION_RETENTION_MS ||
    !Number.isFinite(now) ||
    now < 0
  )
    throw new Error('[COMPACTION_RETENTION] Invalid finite retention');
  const id = randomUUID();
  const sourceSha256 = hash(JSON.stringify(input.source));
  const content = JSON.stringify({
    kind: 'worker_compaction_snapshot',
    id,
    parentId: input.parent?.id,
    generation: (input.parent?.generation ?? 0) + 1,
    createdAt: now,
    scopeKey,
    sourceSha256,
    source: input.source,
    messages: input.messages,
    expiresAt: now + retention,
  });
  if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024)
    throw new Error('[COMPACTION_SIZE] Snapshot exceeds bounded recovery size');
  const artifact = writeScopedArtifact({
    scope: artifactOwner(input.scope),
    tier: input.scope.tier,
    artifact_class: 'evidence',
    name: `compaction/snapshot-${id}.json`,
    content,
    format: 'text',
    create_only: true,
  });
  const receipt = compactionSnapshotReceiptSchema.parse({
    id,
    ...(input.parent ? { parentId: input.parent.id } : {}),
    generation: (input.parent?.generation ?? 0) + 1,
    scopeKey,
    artifactPath: artifact.repo_relative_path,
    sha256: hash(content),
    sourceSha256,
    createdAt: now,
    expiresAt: now + retention,
  });
  try {
    await readCompactionSnapshot(receipt, input.scope, now);
  } catch {
    // Only this call's exclusively-created, unpublished UUID artifact is rolled back.
    // Unlink removes the entry, never follows its target; existing artifacts are never overwritten.
    try {
      safeUnlinkSync(artifact.absolute_path || artifact.repo_relative_path);
    } catch {
      throw new Error(
        '[COMPACTION_CLEANUP_NEEDS_ATTENTION] Uncommitted raw snapshot could not be removed'
      );
    }
    throw new Error(
      '[COMPACTION_RECEIPT] Snapshot validation failed; uncommitted artifact removed'
    );
  }
  return receipt;
}

async function snapshotText(
  receipt: CompactionSnapshotReceipt,
  scope: ScopeContext
): Promise<string> {
  const { readScopedArtifactIndex } = await import('./artifact-store.js');
  compactionSnapshotReceiptSchema.parse(receipt);
  if (receipt.scopeKey !== compactionScopeKey(scope))
    throw new Error('[COMPACTION_SCOPE] Snapshot scope mismatch');
  const indexed = readScopedArtifactIndex(artifactOwner(scope), scope.tier).some(
    (row) =>
      row.path === receipt.artifactPath &&
      row.artifact_class === 'evidence' &&
      row.name === `compaction/snapshot-${receipt.id}.json`
  );
  if (!indexed) throw new Error('[COMPACTION_RECEIPT] Snapshot is outside its scoped index');
  const content = safeReadFileSnapshot(
    assertSafeRepositoryPath(receipt.artifactPath),
    16 * 1024 * 1024
  ).toString('utf8');
  if (hash(content) !== receipt.sha256)
    throw new Error('[COMPACTION_RECEIPT] Artifact digest changed');
  return content;
}

export async function readCompactionSnapshot(
  receipt: CompactionSnapshotReceipt,
  scope: ScopeContext,
  now = Date.now()
): Promise<WorkerContextMessage[]> {
  if (!Number.isFinite(now) || now < receipt.createdAt || now >= receipt.expiresAt)
    throw new Error('[COMPACTION_EXPIRED] Snapshot expired');
  const body = parseSafeJsonInput(
    await snapshotText(receipt, scope),
    'worker compaction snapshot'
  ) as Record<string, unknown>;
  if (
    body.id !== receipt.id ||
    body.parentId !== receipt.parentId ||
    body.generation !== receipt.generation ||
    body.createdAt !== receipt.createdAt ||
    body.scopeKey !== receipt.scopeKey ||
    body.expiresAt !== receipt.expiresAt ||
    body.sourceSha256 !== receipt.sourceSha256 ||
    hash(JSON.stringify(body.source)) !== receipt.sourceSha256
  )
    throw new Error('[COMPACTION_RECEIPT] Snapshot content mismatch');
  const message = z
    .object({
      role: z.enum(['system', 'user', 'assistant', 'tool_use', 'tool_result']),
      content: z.string(),
    })
    .passthrough();
  return z.array(message).parse(body.messages) as WorkerContextMessage[];
}

/** Explicit maintenance path; restore itself never writes or deletes. */
export async function purgeExpiredCompactionSnapshot(
  receipt: CompactionSnapshotReceipt,
  scope: ScopeContext,
  now = Date.now()
): Promise<boolean> {
  if (!Number.isFinite(now) || now < receipt.expiresAt) return false;
  await snapshotText(receipt, scope);
  safeUnlinkSync(assertSafeRepositoryPath(receipt.artifactPath));
  return true;
}

/** Roll back only this exact immutable artifact when its journal commit did not land. */
export async function discardUncommittedCompactionSnapshot(
  receipt: CompactionSnapshotReceipt,
  scope: ScopeContext
): Promise<void> {
  await snapshotText(receipt, scope);
  safeUnlinkSync(assertSafeRepositoryPath(receipt.artifactPath));
}

/** Recovery reads artifacts without replaying hooks, notifications or tool effects. */
export async function restoreJournalCompaction(
  journal: WorkerStateJournal,
  scope: ScopeContext,
  now = Date.now()
) {
  const receipt = journal.compactionTip(scope);
  return receipt ? { receipt, messages: await readCompactionSnapshot(receipt, scope, now) } : null;
}

export async function purgeJournalCompactions(
  journal: WorkerStateJournal,
  scope: ScopeContext,
  now = Date.now()
): Promise<number> {
  const history = journal.compactionHistory(scope, true);
  let removed = 0;
  for (const receipt of history) {
    if (now < receipt.expiresAt) continue;
    try {
      if (await purgeExpiredCompactionSnapshot(receipt, scope, now)) removed++;
    } catch {
      /* Changed/unreadable artifacts are retained for explicit review. */
    }
  }
  return removed;
}
