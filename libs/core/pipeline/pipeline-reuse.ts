/** Read-only revision outcomes from the engine's existing protected run journal. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import {
  summarizeKnowledgeReuse,
  type KnowledgeReuseReceipt,
} from '../knowledge/knowledge-reuse-contract.js';
import { pipelineRunJournalPath, readPipelineRunJournal } from './pipeline-run-journal.js';
import { loadApprovalRequest } from '../governance/approval-store-reader.js';
import type { PipelineRunJournalState } from './pipeline-run-journal.js';

function observedHumanIntervention(
  journal: PipelineRunJournalState,
  scope: MemoryScopeEnvelope
): boolean | undefined {
  const waits = journal.events.filter(
    (event) => event.event === 'run_suspended' && event.payload.await_kind !== 'state'
  );
  if (!waits.length) return undefined;
  let unknown = false;
  let human = false;
  for (const wait of waits) {
    const { storage_channel: channel, approval_request_id: id } = wait.payload;
    if (typeof channel !== 'string' || typeof id !== 'string') {
      unknown = true;
      continue;
    }
    try {
      const request = loadApprovalRequest(channel, id, { scope });
      if (
        !request ||
        !request.scope ||
        Object.entries(scope).some(
          ([key, value]) =>
            value !== undefined &&
            (request.scope as unknown as Record<string, unknown>)[key] !== value
        )
      ) {
        unknown = true;
        continue;
      }
      if (
        request.status === 'approved' &&
        request.decidedByType === 'human' &&
        request.authenticated === true
      )
        human = true;
      else if (request.status !== 'approved') unknown = true;
    } catch {
      unknown = true;
    }
  }
  return human ? true : unknown ? undefined : false;
}

export function inspectPipelineReuse(input: {
  documentPath: string;
  sourceSha256: string;
  scope: MemoryScopeEnvelope;
}) {
  const scope = assertMemoryScope(input.scope);
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256))
    throw new Error('[PIPELINE_REUSE] Invalid revision');
  const dirs = new Set([
    path.dirname(
      pipelineRunJournalPath('reuse-inspect', undefined, {
        tier: scope.tier,
        ...(scope.tenant_slug ? { tenantSlug: scope.tenant_slug } : {}),
      })
    ),
  ]);
  // Public CLI/mission journals have their own established location. Never scan other missions.
  if (scope.mission_id || (scope.tier === 'public' && !scope.tenant_slug))
    dirs.add(path.dirname(pipelineRunJournalPath('reuse-inspect', scope.mission_id)));
  const receipts: KnowledgeReuseReceipt[] = [];
  const wanted = pathResolver.toRepoRelative(
    assertSafeRepositoryPath(pathResolver.rootResolve(input.documentPath))
  );
  let scanned = 0;
  let truncated = false;
  let unreadableRuns = 0;
  for (const dir of dirs) {
    if (!safeExistsSync(dir)) continue;
    for (const name of safeReaddir(dir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      if (scanned++ >= 1000) {
        truncated = true;
        break;
      }
      const file = assertSafeRepositoryPath(path.join(dir, name));
      if (!safeLstat(file).isFile()) continue;
      let journal: PipelineRunJournalState;
      try {
        journal = readPipelineRunJournal(file);
      } catch {
        unreadableRuns += 1;
        continue;
      }
      const started = journal.started;
      if (!started || started.pipeline_sha256 !== input.sourceSha256) continue;
      const actualScope =
        started.library_execution?.scope_identity || started.execution_authority?.scope;
      if (
        !actualScope ||
        Object.entries(scope).some(
          ([key, value]) =>
            value !== undefined &&
            (actualScope as unknown as Record<string, unknown>)[key] !== value
        )
      )
        continue;
      if (pathResolver.toRepoRelative(pathResolver.rootResolve(started.input_path)) !== wanted)
        continue;
      const successful =
        journal.finished?.status === 'succeeded' &&
        journal.events.at(-1)?.event === 'run_finished' &&
        journal.events.filter((event) => event.event === 'run_finished').length === 1 &&
        !journal.suspended &&
        started.step_ids.length > 0 &&
        !journal.events.some((event) => event.event === 'node_failed') &&
        started.step_ids.every((id) => journal.completed_nodes.has(id));
      receipts.push({
        receipt_id: createHash('sha256').update(journal.run_id).digest('hex'),
        source_sha256: input.sourceSha256,
        scope: actualScope,
        kind: successful ? 'verified' : journal.finished ? 'verification_failed' : 'incomplete',
        at: journal.events.at(-1)!.timestamp,
        human_intervention: observedHumanIntervention(journal, actualScope),
      });
    }
  }
  return {
    ...summarizeKnowledgeReuse(receipts, input.sourceSha256, scope),
    truncated,
    unreadable_runs: unreadableRuns,
    evidence_complete: !truncated && unreadableRuns === 0,
  };
}
