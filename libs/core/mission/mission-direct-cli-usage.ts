import { logger } from '../core.js';
import { metrics, type MetricsCollector, type ResourceUsageRecord } from '../metrics.js';
import { PROVIDER_IDS } from '../provider/provider-permission-profiles.js';

/**
 * Usage accounting for direct-CLI mission work (`record-evidence` /
 * `review-task`). That work happens outside the agent-runtime supervisor, so
 * no token usage is ever observed for it and a finished mission's
 * retrospective would otherwise report `entries: 0` — indistinguishable from
 * "free". Each completed task appends one ESTIMATED entry to the existing
 * resource-usage ledger (`MetricsCollector.recordResourceUsage`) so the work is
 * at least counted. Token counts are never fabricated: quantity and cost are 0
 * and the token fields are null.
 */
export const DIRECT_CLI_USAGE_SOURCE = 'direct_cli';

export type DirectCliUsageEvent = 'record_evidence' | 'review_task';

export interface DirectCliUsageInput {
  missionId: string;
  taskId: string;
  event: DirectCliUsageEvent;
  /** Tasks the same call completed by dependency cascade; each gets its own entry. */
  cascaded?: readonly string[];
  actorId?: string;
  actorType?: 'agent' | 'human' | 'service';
  /** Explicit provider (`--provider`); must be a known provider id, else inferred from the actor id. */
  provider?: string;
  /**
   * Owning mission state — REQUIRED so the entry's scope carries the mission's
   * real tier/tenant and can never silently default to `public`. A
   * confidential mission without a tenant fails scope validation and records
   * nothing (with a warning) rather than being downgraded.
   */
  state: { tier: 'personal' | 'confidential' | 'public'; tenant_slug?: string };
  /** Injected collector for isolated runtimes / tests; defaults to the shared one. */
  collector?: Pick<MetricsCollector, 'recordResourceUsage'>;
}

function isKnownProvider(value: string): boolean {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Provider id named by the actor id's leading segment (e.g. `codex-reviewer` → `codex`). */
export function inferProviderFromActorId(actorId?: string): string | undefined {
  const head = String(actorId || '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/u)[0];
  return isKnownProvider(head) ? head : undefined;
}

function resolveProvider(input: DirectCliUsageInput): string | undefined {
  const explicit = input.provider?.trim().toLowerCase();
  if (explicit && !isKnownProvider(explicit)) {
    logger.warn(
      `[direct-cli-usage] --provider '${input.provider}' ignored — not a known provider id | next: use one of ${PROVIDER_IDS.join(', ')}`
    );
  }
  return explicit && isKnownProvider(explicit) ? explicit : inferProviderFromActorId(input.actorId);
}

/**
 * Append the estimated usage entries for the task a direct-CLI call closed
 * (plus any task it completed by cascade). Failure-tolerant: accounting must
 * never block evidence or review recording.
 */
export function recordDirectCliTaskUsage(input: DirectCliUsageInput): ResourceUsageRecord[] {
  const missionId = input.missionId.toUpperCase();
  const provider = resolveProvider(input);
  const records: ResourceUsageRecord[] = [];
  for (const taskId of [input.taskId, ...(input.cascaded || [])]) {
    const cascadedFrom = taskId === input.taskId ? undefined : input.taskId;
    try {
      if (!input.state?.tier) throw new Error('mission tier is unknown');
      records.push(
        (input.collector || metrics).recordResourceUsage({
          usage_id: `${DIRECT_CLI_USAGE_SOURCE}:${missionId}:${taskId}:${input.event}`,
          resource_kind: input.actorType === 'human' ? 'human_time' : provider ? 'llm' : 'other',
          actor_id: input.actorId,
          mission_id: missionId,
          quantity: 0,
          unit: 'task',
          cost_usd: 0,
          status: 'estimated',
          source: DIRECT_CLI_USAGE_SOURCE,
          scope: {
            scope_kind: 'task',
            tier: input.state.tier,
            ...(input.state.tenant_slug ? { tenant_slug: input.state.tenant_slug } : {}),
            mission_id: missionId,
            task_id: taskId,
          },
          metadata: {
            task_id: taskId,
            event: input.event,
            estimated: true,
            ...(cascadedFrom ? { cascaded_from: cascadedFrom } : {}),
            ...(provider ? { provider } : {}),
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            note: 'direct CLI work — token usage was not observed, not zero',
          },
        })
      );
    } catch (err) {
      logger.warn(
        `[direct-cli-usage] usage entry not recorded for ${missionId}/${taskId} — ${
          err instanceof Error ? err.message : String(err)
        } | next: the retrospective may report this mission as usage_unrecorded`
      );
    }
  }
  return records;
}
