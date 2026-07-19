/**
 * Lifecycle hook engine (KC-04).
 *
 * Generalizes the Claude-Code-specific hook surface (claude-code-hook.ts,
 * 5 events) into an engine any internal loop can fire: pipelines, workers,
 * delegation, compaction. Modeled on kimi-cli's HookEngine:
 *
 * - 13-event vocabulary (Claude Code taxonomy mapped to Kyberion names)
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
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeReadFile } from './secure-io.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';

export const LIFECYCLE_HOOK_EVENTS = [
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'user_prompt_submit',
  'stop',
  'stop_failure',
  'session_start',
  'session_end',
  'subagent_start',
  'subagent_stop',
  'pre_compact',
  'post_compact',
  'notification',
] as const;

export type LifecycleHookEvent = (typeof LIFECYCLE_HOOK_EVENTS)[number];

export interface LifecycleHookPayload {
  /** Value the hook matcher regex runs against (e.g. op/tool name). */
  matcher_value?: string;
  [key: string]: unknown;
}

export interface LifecycleHookDecision {
  block: boolean;
  reason?: string;
  /** Extra context appended to the worker's view (non-blocking hooks). */
  additional_context?: string;
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
  reasons: string[];
  additionalContext: string[];
  /** Hook ids that failed to run (fail-open — informational only). */
  failedHooks: string[];
}

const ALLOW_OUTCOME: LifecycleHookOutcome = {
  blocked: false,
  reasons: [],
  additionalContext: [],
  failedHooks: [],
};

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const CONFIG_LOGICAL_PATH = 'knowledge/product/governance/lifecycle-hooks.json';

export class LifecycleHookEngine {
  private readonly hooks: LifecycleHookRegistration[] = [];

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
      reasons: [],
      additionalContext: [],
      failedHooks: [],
    };
    for (const entry of outcomes) {
      if (entry.failed) {
        outcome.failedHooks.push(entry.hook.id);
        continue;
      }
      if (!entry.decision) continue;
      if (entry.decision.block) {
        outcome.blocked = true;
        outcome.reasons.push(entry.decision.reason || `blocked by hook ${entry.hook.id}`);
      }
      if (entry.decision.additional_context) {
        outcome.additionalContext.push(entry.decision.additional_context);
      }
    }
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
  let parsed: { decision?: string; reason?: string; additional_context?: string } = {};
  try {
    parsed = JSON.parse(result.stdout.trim() || '{}');
  } catch {
    /* non-JSON stdout is fine for allow/exit-code-only hooks */
  }
  const block = result.status === 2 || parsed.decision === 'block';
  return {
    block,
    ...(block ? { reason: parsed.reason || result.stderr.trim() || `hook ${hook.id} blocked` } : {}),
    ...(parsed.additional_context ? { additional_context: parsed.additional_context } : {}),
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
