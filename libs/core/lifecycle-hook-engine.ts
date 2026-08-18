/**
 * Lifecycle hook engine (KC-04).
 *
 * Generalizes the Claude-Code-specific hook surface (claude-code-hook.ts,
 * 5 events) into an engine any internal loop can fire: pipelines, workers,
 * delegation, compaction. Modeled on kimi-cli's HookEngine:
 *
 * - lifecycle vocabulary (Claude Code taxonomy mapped to Kyberion names)
 * - hooks match on a regex over the event's matcher value (e.g. op name)
 * - all matching hooks run in parallel; any block ⇒ blocked
 * - **fail-open**: an engine/hook failure never stops the worker — EXCEPT
 *   the telemetry emit for a security block, which sits outside the
 *   fail-open guard so a block is never silently dropped
 *
 * Two hook sources: in-process handlers (plugins/tests) and command hooks
 * from a governed config file (JSON on stdin, exit 2 or {"decision":"block"}
 * ⇒ block — same convention as claude-code-hook).
 */

import { logger } from './core.js';
import { assertModuleInvariant } from './invariants.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeReadFile } from './secure-io.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';
import {
  createApprovalRequest,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';

export const LIFECYCLE_HOOK_EVENTS = [
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'user_prompt_submit',
  'stop',
  'stop_failure',
  'session_start',
  /** Fired after session setup and before the agent receives its first prompt. */
  'before_agent_start',
  'session_end',
  'subagent_start',
  'subagent_stop',
  'pre_compact',
  'post_compact',
  'notification',
  /** Emitted once after the run's retry/repair/compaction work is complete. */
  'task_settled',
] as const;

export type LifecycleHookEvent = (typeof LIFECYCLE_HOOK_EVENTS)[number];

export interface LifecycleHookPayload {
  /** Value the hook matcher regex runs against (e.g. op/tool name). */
  matcher_value?: string;
  [key: string]: unknown;
}

export interface LifecycleHookDecision {
  block: boolean;
  /** External hook compatibility: deny > ask > allow. Ask is fail-closed at
   * execution boundaries that do not expose an interactive approval surface. */
  decision?: 'allow' | 'ask' | 'block';
  reason?: string;
  /** Extra context appended to the worker's view (non-blocking hooks). */
  additional_context?: string;
  /** Partial tool-result/context patch applied after the operation settles. */
  result_patch?: Record<string, unknown>;
}

export type LifecycleHookHandler = (
  event: LifecycleHookEvent,
  payload: LifecycleHookPayload
) => LifecycleHookDecision | void | Promise<LifecycleHookDecision | void>;

export interface LifecycleHookRegistration {
  id: string;
  event: LifecycleHookEvent;
  /** Regex source matched against payload.matcher_value; omit = match all. */
  matcher?: string;
  handler?: LifecycleHookHandler;
  /** Command hook: argv receives nothing; the JSON payload arrives on stdin. */
  command?: string[];
  timeoutMs?: number;
}

export interface LifecycleHookOutcome {
  blocked: boolean;
  /** Strongest disposition across all matching hooks. */
  decision: 'allow' | 'ask' | 'block';
  asked: boolean;
  reasons: string[];
  additionalContext: string[];
  /** Deterministic shallow patch collected from post-tool middleware. */
  resultPatch: Record<string, unknown>;
  /** Hook ids that failed to run (fail-open — informational only). */
  failedHooks: string[];
  /** PI-08: pending human approval created for an interactive ask. */
  approvalRequestId?: string;
}

export interface LifecycleHookApprovalSurface {
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  storageChannel?: string;
  title?: string;
  summary?: string;
  details?: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface LifecycleHookEngineOptions {
  /** Keep a security block active until an explicit operator reset. */
  stickyHalt?: boolean;
}

const ALLOW_OUTCOME: LifecycleHookOutcome = {
  blocked: false,
  decision: 'allow',
  asked: false,
  reasons: [],
  additionalContext: [],
  resultPatch: {},
  failedHooks: [],
};

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const CONFIG_LOGICAL_PATH = 'knowledge/product/governance/lifecycle-hooks.json';

export class LifecycleHookEngine {
  private readonly hooks: LifecycleHookRegistration[] = [];
  private readonly stickyHalt: boolean;
  private haltedReason: string | undefined;
  private activeFires = 0;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: LifecycleHookEngineOptions = {}) {
    this.stickyHalt = options.stickyHalt === true;
  }

  register(hook: LifecycleHookRegistration): () => void {
    this.validate(hook);
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    };
  }

  private validate(hook: LifecycleHookRegistration): void {
    if (!LIFECYCLE_HOOK_EVENTS.includes(hook.event)) {
      throw new Error(`[HOOK_CONFIG] Unknown lifecycle hook event: ${hook.event}`);
    }
    if (!hook.handler && (!hook.command || hook.command.length === 0)) {
      throw new Error(`[HOOK_CONFIG] Hook ${hook.id} needs a handler or a command`);
    }
    if (hook.matcher !== undefined) new RegExp(hook.matcher, 'u');
  }

  hookCountFor(event: LifecycleHookEvent): number {
    return this.matching(event, undefined).length;
  }

  /** Whether this engine has latched a sticky security halt. */
  get isHalted(): boolean {
    return this.haltedReason !== undefined;
  }

  /** Explicit operator/mission-owner reset for an opt-in sticky halt. */
  clearHalt(): void {
    this.haltedReason = undefined;
  }

  /** Resolve after all hook fires already in progress have settled. */
  whenIdle(): Promise<void> {
    if (this.activeFires === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private matching(
    event: LifecycleHookEvent,
    matcherValue: string | undefined
  ): LifecycleHookRegistration[] {
    return this.hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (hook.matcher === undefined || matcherValue === undefined) return true;
      try {
        return new RegExp(hook.matcher, 'u').test(matcherValue);
      } catch {
        return false;
      }
    });
  }

  /**
   * Run every matching hook in parallel and aggregate. Never throws: any
   * internal failure degrades to `allow` (fail-open) with the failure noted.
   * The security carve-out — telemetry for a block decision — is emitted by
   * {@link fireLifecycleHooks}, outside this method's guard.
   */
  async fire(
    event: LifecycleHookEvent,
    payload: LifecycleHookPayload = {}
  ): Promise<LifecycleHookOutcome> {
    this.activeFires += 1;
    try {
      return await this.fireInternal(event, payload);
    } finally {
      this.activeFires -= 1;
      if (this.activeFires === 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private async fireInternal(
    event: LifecycleHookEvent,
    payload: LifecycleHookPayload
  ): Promise<LifecycleHookOutcome> {
    if (this.haltedReason !== undefined) {
      const reason = `sticky lifecycle halt: ${this.haltedReason}`;
      const halted: LifecycleHookOutcome = {
        blocked: true,
        decision: 'block',
        asked: false,
        reasons: [reason],
        additionalContext: [],
        resultPatch: {},
        failedHooks: [],
      };
      assertModuleInvariant('lifecycle-hook-engine', 'outcome-shape', halted);
      return halted;
    }
    let matched: LifecycleHookRegistration[];
    try {
      matched = this.matching(event, payload.matcher_value);
    } catch {
      return ALLOW_OUTCOME;
    }
    if (matched.length === 0) return ALLOW_OUTCOME;

    const outcomes = await Promise.all(
      matched.map(async (hook) => {
        try {
          const decision = hook.handler
            ? await hook.handler(event, payload)
            : runCommandHook(hook, event, payload);
          return { hook, decision: decision ?? undefined, failed: false };
        } catch (err) {
          logger.warn(
            `[lifecycle-hooks] hook ${hook.id} failed on ${event}: ${err instanceof Error ? err.message : String(err)}`
          );
          return { hook, decision: undefined, failed: true };
        }
      })
    );

    const outcome: LifecycleHookOutcome = {
      blocked: false,
      decision: 'allow',
      asked: false,
      reasons: [],
      additionalContext: [],
      resultPatch: {},
      failedHooks: [],
    };
    for (const entry of outcomes) {
      if (entry.failed) {
        outcome.failedHooks.push(entry.hook.id);
        continue;
      }
      if (!entry.decision) continue;
      const disposition = entry.decision.block ? 'block' : entry.decision.decision || 'allow';
      if (disposition === 'block') {
        outcome.decision = 'block';
        outcome.asked = false;
        outcome.blocked = true;
        outcome.reasons.push(entry.decision.reason || `blocked by hook ${entry.hook.id}`);
        if (this.stickyHalt && this.haltedReason === undefined) {
          this.haltedReason = outcome.reasons[outcome.reasons.length - 1];
        }
      } else if (disposition === 'ask' && outcome.decision !== 'block') {
        outcome.decision = 'ask';
        outcome.asked = true;
        // A non-interactive execution boundary cannot safely continue after
        // an ask. Keep the legacy `blocked` projection true so existing
        // callers fail closed without having to understand the new field.
        outcome.blocked = true;
        outcome.reasons.push(entry.decision.reason || `approval required by hook ${entry.hook.id}`);
      }
      if (entry.decision.additional_context) {
        outcome.additionalContext.push(entry.decision.additional_context);
      }
      if (entry.decision.result_patch) {
        for (const [key, value] of Object.entries(entry.decision.result_patch)) {
          outcome.resultPatch[key] = value;
        }
      }
    }
    assertModuleInvariant('lifecycle-hook-engine', 'outcome-shape', outcome);
    return outcome;
  }
}

function runCommandHook(
  hook: LifecycleHookRegistration,
  event: LifecycleHookEvent,
  payload: LifecycleHookPayload
): LifecycleHookDecision {
  const [command, ...args] = hook.command!;
  const result = safeExecResult(command, args, {
    timeoutMs: hook.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    input: JSON.stringify({ event, ...payload }),
  });
  // Exit 2 = block (claude-code-hook convention); stdout may refine it.
  let parsed: {
    decision?: string;
    reason?: string;
    additional_context?: string;
    result_patch?: Record<string, unknown>;
    hookSpecificOutput?: {
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  } = {};
  try {
    parsed = JSON.parse(result.stdout.trim() || '{}');
  } catch {
    /* non-JSON stdout is fine for allow/exit-code-only hooks */
  }
  const externalDecision = parsed.hookSpecificOutput?.permissionDecision?.toLowerCase();
  const decision =
    result.status === 2 ||
    parsed.decision === 'block' ||
    parsed.decision === 'deny' ||
    externalDecision === 'deny'
      ? 'block'
      : parsed.decision === 'ask' || externalDecision === 'ask'
        ? 'ask'
        : 'allow';
  const reason =
    parsed.reason ||
    parsed.hookSpecificOutput?.permissionDecisionReason ||
    result.stderr.trim() ||
    undefined;
  return {
    block: decision === 'block',
    decision,
    ...(decision !== 'allow'
      ? {
          reason:
            reason || `hook ${hook.id} ${decision === 'ask' ? 'requires approval' : 'blocked'}`,
        }
      : {}),
    ...(parsed.additional_context ? { additional_context: parsed.additional_context } : {}),
    ...(parsed.result_patch && typeof parsed.result_patch === 'object'
      ? { result_patch: parsed.result_patch }
      : {}),
  };
}

/**
 * Fire hooks with the security carve-out: when the outcome is a block, the
 * telemetry emit happens OUTSIDE the fail-open guard, so a security block is
 * recorded even if other hooks (or the engine internals) misbehaved.
 */
export async function fireLifecycleHooks(
  engine: LifecycleHookEngine,
  event: LifecycleHookEvent,
  payload: LifecycleHookPayload = {}
): Promise<LifecycleHookOutcome> {
  let outcome: LifecycleHookOutcome;
  try {
    outcome = await engine.fire(event, payload);
  } catch {
    outcome = ALLOW_OUTCOME;
  }
  if (outcome.blocked) {
    // Deliberately unguarded emits: a failure here should surface loudly
    // rather than let a security block vanish from the record.
    const { recordGovernanceAction } = await import('./kill-switch.js');
    recordGovernanceAction(
      'lifecycle-hooks',
      'hook_block',
      `${event}:${payload.matcher_value ?? ''}:${outcome.reasons.join('; ')}`,
      true
    );
    try {
      getDefaultWorkerEventStream().emit('governance_action', {
        kind: 'hook_block',
        event,
        matcher_value: payload.matcher_value,
        reasons: outcome.reasons,
      });
    } catch {
      /* stream projection stays best-effort; the governance action above is the record */
    }
  }
  return outcome;
}

/**
 * Materialize an interactive `ask` into the shared approval store. Plain
 * `fireLifecycleHooks` intentionally remains a fail-closed, non-interactive
 * boundary; callers with a real surface opt into this adapter explicitly.
 * Pending requests are reused by correlation id so retries do not fan out
 * duplicate approval prompts.
 */
export async function fireLifecycleHooksWithApproval(
  engine: LifecycleHookEngine,
  event: LifecycleHookEvent,
  payload: LifecycleHookPayload = {},
  surface: LifecycleHookApprovalSurface
): Promise<LifecycleHookOutcome> {
  const outcome = await fireLifecycleHooks(engine, event, payload);
  if (outcome.decision !== 'ask') return outcome;

  const pending = listApprovalRequests({ status: 'pending', kind: 'channel-approval' }).find(
    (record) =>
      record.correlationId === surface.correlationId &&
      record.channel === surface.channel &&
      record.requestedBy === surface.requestedBy
  );
  const request: ApprovalRequestRecord =
    pending ||
    createApprovalRequest('surface_runtime', {
      channel: surface.channel,
      storageChannel: surface.storageChannel || surface.channel,
      threadTs: surface.threadTs,
      correlationId: surface.correlationId,
      requestedBy: surface.requestedBy,
      draft: {
        title: surface.title || `Lifecycle approval required: ${event}`,
        summary: surface.summary || outcome.reasons.join('; ') || 'Operator approval is required.',
        ...(surface.details ? { details: surface.details } : {}),
        severity: surface.severity || 'medium',
      },
      accountability: { finalDecision: 'human_only' },
      sourceText: `lifecycle-hook:${event}:${payload.matcher_value || ''}`,
    });
  return { ...outcome, approvalRequestId: request.id };
}

interface LifecycleHookConfigFile {
  hooks?: Array<{
    id?: string;
    event?: string;
    matcher?: string;
    command?: string[];
    timeout_ms?: number;
  }>;
}

/**
 * Load command hooks from the governed config file. Malformed entries are
 * skipped with a warning (fail-open) — a broken config must not brick every
 * worker loop.
 */
export function loadLifecycleHookEngine(
  configPath: string = pathResolver.rootResolve(CONFIG_LOGICAL_PATH)
): LifecycleHookEngine {
  const engine = new LifecycleHookEngine();
  if (!safeExistsSync(configPath)) return engine;
  let config: LifecycleHookConfigFile;
  try {
    config = JSON.parse(String(safeReadFile(configPath, { encoding: 'utf-8' })));
  } catch (err) {
    logger.warn(
      `[lifecycle-hooks] unreadable config ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return engine;
  }
  for (const [index, entry] of (config.hooks ?? []).entries()) {
    try {
      engine.register({
        id: entry.id || `config-hook-${index}`,
        event: entry.event as LifecycleHookEvent,
        matcher: entry.matcher,
        command: entry.command,
        ...(entry.timeout_ms ? { timeoutMs: entry.timeout_ms } : {}),
      });
    } catch (err) {
      logger.warn(
        `[lifecycle-hooks] skipping invalid hook entry ${index}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return engine;
}

const GLOBAL_KEY = Symbol.for('kyberion.lifecycleHookEngine');

/** Process-wide engine (config hooks + programmatic registrations). */
export function getDefaultLifecycleHookEngine(): LifecycleHookEngine {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[GLOBAL_KEY]) holder[GLOBAL_KEY] = loadLifecycleHookEngine();
  return holder[GLOBAL_KEY] as LifecycleHookEngine;
}

/** Test seam. */
export function resetDefaultLifecycleHookEngine(): void {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
}
