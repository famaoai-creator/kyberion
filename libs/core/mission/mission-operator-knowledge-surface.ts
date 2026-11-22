/**
 * Operator-facing promoted-knowledge surface (D8 / MEMORY_LOOP_CLOSURE).
 *
 * KP-05 delivery telemetry only observed the dispatched-worker path:
 * `recordKnowledgeDelivery` runs inside worker context packs, background
 * review and ADF repair, so direct_cli missions delivered no promoted
 * knowledge and `computeMemoryLoopHealth` measured the loop as permanently
 * open (promoted > 0, retrieved = 0). This surface closes the gap for the
 * operator path: at mission start/kickoff/resume it retrieves the top
 * promoted records for the mission goal, prints them for the operator and
 * records the delivery through the same `recordKnowledgeDelivery` writer,
 * so the loop metric counts direct_cli deliveries too.
 *
 * Fail-open: a retrieval or delivery error must never block the lifecycle
 * verb — it only means no section gets printed.
 */
import { logger } from '../core.js';
import { detectAgentExecutionContext } from '../agent/agent-execution-context.js';
import { currentActor } from '../authn/actor-context.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { hasDelegatedExecutionContext } from '../governance/delegated-execution.js';
import { findRelevantPromotedKnowledge } from '../knowledge/promoted-knowledge-retrieval.js';
import {
  recordKnowledgeDelivery,
  recordExplicitKnowledgeUse,
  type ExplicitKnowledgeUseResult,
} from '../knowledge/knowledge-feedback-loop.js';
import { createKnowledgeDeliverySnapshot } from '../knowledge/knowledge-delivery-snapshot.js';
import { loadState } from './mission-state.js';
import { findMissionPath } from '../path-resolver.js';
import { readMissionNextTasks } from './mission-lifecycle.js';
import { inspectInstalledPersonalRuntime } from '../organization/personal-runtime-identity.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveIdentityContext } from '../authority.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';

export const OPERATOR_PROMOTED_RETRIEVAL_LIMIT = 3;

function operatorKnowledgeScope(
  missionId: string,
  state: NonNullable<ReturnType<typeof loadState>>
): MemoryScopeEnvelope | undefined {
  const scope: MemoryScopeEnvelope = {
    tier: state.tier,
    ...(state.tenant_slug ? { tenant_slug: state.tenant_slug } : {}),
    ...(state.organization_id ? { organization_id: state.organization_id } : {}),
    mission_id: missionId,
  };
  if (state.tier !== 'personal') return scope;

  // Installation identity is available to the standalone operator path only.
  // Existing execution and storage authorization still applies to every read/write.
  if (
    state.tenant_slug ||
    state.organization_id ||
    detectAgentExecutionContext().isAgent ||
    currentActor() ||
    currentScopeEnvelope() ||
    currentExecutionScope() ||
    currentResourceAccessScope() ||
    hasDelegatedExecutionContext() ||
    resolveIdentityContext().tenantSlug
  )
    return undefined;
  const installed = inspectInstalledPersonalRuntime();
  if (!installed.ready || !installed.agentActive) return undefined;
  return { ...scope, owner_nhi: installed.agentId };
}

type OperatorKnowledgeUseResult =
  ExplicitKnowledgeUseResult | { reference: string; status: 'personal_owner_required' };

/** Read-only early refusal. Evidence writes still recheck the task under its fence. */
export function inspectOperatorKnowledgeUse(
  missionId: string,
  taskId: string
): { status: 'personal_owner_required' | 'task_not_recorded'; nextAction: string } | undefined {
  const id = missionId.toUpperCase();
  const state = loadState(id);
  // The evidence command owns the canonical missing-mission diagnostic.
  if (!state) return undefined;
  if (!operatorKnowledgeScope(id, state))
    return {
      status: 'personal_owner_required',
      nextAction: 'Use the installed standalone operator terminal with an active personal NHI.',
    };
  const missionPath = findMissionPath(id);
  if (
    !missionPath ||
    !readMissionNextTasks(missionPath).some((task) => String(task.task_id || '') === taskId)
  ) {
    return {
      status: 'task_not_recorded',
      nextAction: 'Check the task ID in pnpm mission status and retry.',
    };
  }
}

/** Records an explicit report against previously delivered mission-level references. */
export function recordOperatorKnowledgeUsage(
  missionId: string,
  taskId: string,
  paths: string[]
): OperatorKnowledgeUseResult[] {
  const id = missionId.toUpperCase();
  const state = loadState(id);
  if (!state) return paths.map((reference) => ({ reference, status: 'retryable_error' }));
  const scope = operatorKnowledgeScope(id, state);
  if (!scope) return paths.map((reference) => ({ reference, status: 'personal_owner_required' }));
  return recordExplicitKnowledgeUse({
    missionId: id,
    scope,
    delivery: { recipientKind: 'operator_cli' },
    reportTaskId: taskId,
    references: paths,
  });
}

/**
 * Lifecycle-verb seam: load the mission, surface the promoted records for its
 * goal and print them. No-ops unless the mission is active. Fail-open — a
 * state-load or retrieval problem must never block start/kickoff/resume.
 */
export async function printPromotedKnowledgeForActiveMission(
  missionId: string,
  emit: (line: string) => void = (line) => logger.info(line)
): Promise<void> {
  try {
    const state = loadState(missionId);
    if (state?.status !== 'active') return;
    const scope = operatorKnowledgeScope(missionId, state);
    if (!scope) {
      emit(
        '   Knowledge usage unavailable: an active installed personal identity is required in a standalone operator session.'
      );
      return;
    }
    for (const line of await surfacePromotedKnowledgeForOperator({
      missionId,
      topic: state.intent?.goal_summary || state.intent?.source_text || '',
      scope,
    })) {
      emit(`   ${line}`);
    }
  } catch {
    // Fail-open — see module doc.
  }
}

export async function surfacePromotedKnowledgeForOperator(input: {
  missionId: string;
  /** Retrieval topic — the mission goal summary or source text. */
  topic: string;
  scope?: MemoryScopeEnvelope;
  limit?: number;
  /** Test seam: repo root containing a fixture `knowledge/`. */
  rootDir?: string;
}): Promise<string[]> {
  const topic = input.topic.trim();
  if (!topic) return [];
  try {
    const limit = Math.max(1, Math.floor(input.limit ?? OPERATOR_PROMOTED_RETRIEVAL_LIMIT));
    const entries = await findRelevantPromotedKnowledge({
      topic,
      limit,
      minScore: 0.08,
      scope: input.scope,
      ...(input.rootDir ? { rootDir: input.rootDir } : {}),
    });
    if (entries.length === 0) return [];
    const delivery = recordKnowledgeDelivery({
      missionId: input.missionId,
      recipientKind: 'operator_cli',
      scope: input.scope,
      refs: entries.map((entry) => ({
        path: entry.path,
        ...(typeof entry.score === 'number' ? { score: entry.score } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        snapshot: createKnowledgeDeliverySnapshot({
          text: `- ${entry.title} (${entry.path})\n  ${entry.excerpt.trim().replace(/\s+/g, ' ').slice(0, 200)}`,
          form: 'context_string',
          ...(entry.source_sha256 ? { source_sha256: entry.source_sha256 } : {}),
        }),
      })),
    });
    const versions = new Map(delivery?.refs.map((ref) => [ref.path, ref.snapshot?.sha256]));
    const lines = [`Promoted knowledge relevant to this mission (${entries.length}):`];
    for (const entry of entries) {
      lines.push(`- ${entry.title} (${entry.path})`);
      lines.push(`  ${entry.excerpt.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
      const version = versions.get(entry.path);
      if (version) lines.push(`  Usage reference: ${entry.path}@${version}`);
    }
    return lines;
  } catch (err) {
    logger.warn(
      `[MISSION] promoted-knowledge surface failed for ${input.missionId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
