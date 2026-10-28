/** Promotion consumes the engine's durable journal, never a caller's success claim. */
import * as path from 'node:path';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { rootDir } from '../path-resolver.js';
import { safeExistsSync } from '../secure-io.js';
import {
  pipelineRunJournalPath,
  readPipelineRunJournal,
  type PipelineJournalScope,
} from './pipeline-run-journal.js';

export interface PipelinePromotionEvidenceInput {
  runId: string;
  inputPath: string;
  sourceSha256: string;
  tenantSlug?: string;
  missionId?: string;
  traceId?: string;
}

export interface VerifiedPipelinePromotionEvidence {
  run_id: string;
  trace_id?: string;
  journal_ref: string;
  source_sha256: string;
  completed_at: string;
  tier: 'public' | 'confidential';
  tenant_slug?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function denied(reason: string): never {
  throw new Error(
    `[PIPELINE_PROMOTION_UNVERIFIED] ${reason} — run this exact ADF to completion in the target scope and pass --run <run-id>, or use --draft`
  );
}

export function verifyPipelinePromotionEvidence(
  input: PipelinePromotionEvidenceInput
): VerifiedPipelinePromotionEvidence {
  if (!ID.test(input.runId)) denied('A bounded engine run ID is required');
  if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256)) denied('Invalid source digest');
  const scope: PipelineJournalScope = input.tenantSlug
    ? { tier: 'confidential', tenantSlug: input.tenantSlug }
    : { tier: 'public' };
  const caller = currentScopeEnvelope()?.identity;
  const ambientTenant = caller?.tenant_slug ?? currentExecutionScope()?.tenantSlug;
  if (ambientTenant && ambientTenant !== input.tenantSlug)
    denied('The target tenant differs from the caller scope');
  // Probe only the requested partition and exact mission/run. Never enumerate
  // other tenants to discover an ID supplied by an untrusted caller.
  const libraryPath = pipelineRunJournalPath(input.runId, undefined, scope);
  const missionPath = input.missionId
    ? pipelineRunJournalPath(input.runId, input.missionId)
    : undefined;
  const journalPath = missionPath && safeExistsSync(missionPath) ? missionPath : libraryPath;
  const state = readPipelineRunJournal(journalPath);
  const started = state.started;
  const executionScope = started?.execution_authority?.scope;
  if (
    !started ||
    !executionScope ||
    executionScope.tier !== scope.tier ||
    (executionScope.tenant_slug ?? '') !== (input.tenantSlug ?? '')
  )
    denied('The journal does not prove the same data scope');
  for (const key of ['organization_id', 'project_id'] as const) {
    if (caller?.[key] && caller[key] !== executionScope[key])
      denied(`The journal does not prove the caller ${key}`);
  }
  if (input.missionId && started.mission_id?.toUpperCase() !== input.missionId.toUpperCase())
    denied('The journal belongs to a different mission');
  if (state.run_id !== input.runId) denied('The journal belongs to a different run');
  if (path.resolve(rootDir(), started.input_path) !== path.resolve(rootDir(), input.inputPath))
    denied('The run executed a different source');
  if (started.pipeline_sha256 !== input.sourceSha256)
    denied('The source differs from the executed ADF or the legacy journal has no digest');
  if (!started.trace_id) denied('A legacy journal has no engine trace binding');
  if (input.traceId && started.trace_id !== input.traceId)
    denied('The trace is not bound to this run');
  const terminal = state.events.at(-1);
  if (
    !terminal ||
    terminal.event !== 'run_finished' ||
    state.events.filter((event) => event.event === 'run_finished').length !== 1 ||
    state.finished?.status !== 'succeeded' ||
    state.suspended ||
    state.events.some((event) => event.event === 'node_failed')
  )
    denied('The run is incomplete, suspended, failed, or recovered from a failed primary');
  const completed = new Set(
    state.events
      .filter((event) => event.event === 'node_completed')
      .map((event) => event.payload.step_id)
  );
  if (!started.step_ids.length || started.step_ids.some((id) => !completed.has(id)))
    denied('Not every declared source step has completed evidence');
  return {
    run_id: state.run_id,
    ...(started.trace_id ? { trace_id: started.trace_id } : {}),
    journal_ref: path.relative(rootDir(), journalPath).split(path.sep).join('/'),
    source_sha256: input.sourceSha256,
    completed_at: terminal.timestamp,
    tier: scope.tier as 'public' | 'confidential',
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
  };
}
