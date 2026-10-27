import * as crypto from 'node:crypto';
import { logger } from '../core.js';
import { writeScopedArtifact } from './artifact-store.js';
import type {
  WorkerContextMessage,
  CompactWorkerContextOptions,
  CompactionDetails,
  CompactionCarryover,
} from './worker-context-compaction.js';
const DEFAULT_SUMMARY_TIMEOUT_MS = 60_000;
const DEFAULT_SUMMARY_IDLE_TIMEOUT_MS = 30_000;
export class CompactionSummaryTimeout extends Error {}

export async function runSummaryWithDeadline(
  run: (signal: AbortSignal, reportProgress: () => void) => Promise<string>,
  options: CompactWorkerContextOptions
): Promise<string> {
  const positive = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
  const totalMs = positive(options.summaryTimeoutMs, DEFAULT_SUMMARY_TIMEOUT_MS);
  const idleMs = Math.min(
    totalMs,
    positive(options.summaryIdleTimeoutMs, DEFAULT_SUMMARY_IDLE_TIMEOUT_MS)
  );
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let totalTimer: ReturnType<typeof setTimeout>;
  let idleTimer: ReturnType<typeof setTimeout>;
  let abortListener: () => void;
  let settled = false;
  const deadline = new Promise<never>((_, reject) => {
    const expire = (kind: string) => {
      if (settled) return;
      const error = new CompactionSummaryTimeout(`Summary ${kind} deadline reached`);
      controller.abort(error);
    };
    abortListener = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Summary attempt cancelled')
      );
    signal.addEventListener('abort', abortListener, { once: true });
    totalTimer = setTimeout(() => expire('total'), totalMs);
    idleTimer = setTimeout(() => expire('idle'), idleMs);
    if (signal.aborted) abortListener();
  });
  const progress = () => {
    if (settled || signal.aborted) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new CompactionSummaryTimeout('Summary idle deadline reached')),
      idleMs
    );
  };
  try {
    if (signal.aborted) throw signal.reason;
    return await Promise.race([Promise.resolve().then(() => run(signal, progress)), deadline]);
  } finally {
    settled = true;
    clearTimeout(totalTimer!);
    clearTimeout(idleTimer!);
    signal.removeEventListener('abort', abortListener!);
  }
}
/** Dropping older context is allowed only after its exact scoped archive landed. */
export function persistIncompleteHandoff(
  messages: readonly WorkerContextMessage[],
  options: CompactWorkerContextOptions,
  details: CompactionDetails,
  carryover: CompactionCarryover | undefined
): string | undefined {
  if (!options.scope) return undefined;
  try {
    const scope = options.scope;
    const mission = scope.mission_id || options.missionId;
    if (scope.mission_id && options.missionId && scope.mission_id !== options.missionId)
      throw new Error('Handoff scope contradicts the mission');
    const owner = mission
      ? {
          mission,
          ...(scope.task_id ? { task: scope.task_id } : {}),
          ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
          ...(scope.organization_id ? { organization: scope.organization_id } : {}),
          ...(scope.project_id ? { project: scope.project_id } : {}),
        }
      : scope.project_id
        ? { project: scope.project_id, ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}) }
        : scope.organization_id
          ? {
              organization: scope.organization_id,
              ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
            }
          : scope.tenant_slug
            ? { tenant: scope.tenant_slug }
            : scope.tier === 'public'
              ? { system: true as const }
              : undefined;
    if (!owner) return undefined;
    const artifact = writeScopedArtifact({
      scope: owner,
      tier: scope.tier,
      artifact_class: 'evidence',
      name: `compaction/incomplete-handoff-${crypto.randomUUID()}.json`,
      content: {
        kind: 'incomplete_context_handoff',
        incomplete: true,
        reason: 'summary_stalled',
        messages,
        details,
        ...(carryover ? { carryover } : {}),
      },
    });
    options.recordArtifact?.(
      artifact.repo_relative_path,
      'Incomplete deterministic context handoff'
    );
    return artifact.repo_relative_path;
  } catch (error) {
    logger.warn(
      `[context-compaction] incomplete handoff archive unavailable — retain microcompacted history | next: restore scoped artifact storage | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
