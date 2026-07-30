import { a2aBridge } from './a2a-bridge.js';
import { logger } from './core.js';
import { deriveAgentNhiId } from './agent-identity.js';
import {
  appendDelegationLink,
  assertChainAttenuation,
  buildDelegationLink,
  DelegationAttenuationError,
  embedDelegationChainInContext,
  extractDelegationChainFromContext,
  type DelegationCapabilityTier,
} from './delegation-chain.js';
import {
  SUBAGENT_PROFILE_CLI_TOOLS,
  describeSubagentCapabilityCatalog,
  getSubagentCapabilityProfile,
  listSubagentCapabilityProfileNames,
  type SubagentCapabilityProfile,
} from './subagent-capability-profiles.js';
import {
  advanceToolCallRepeatGovernor,
  createToolCallRepeatGovernorState,
  type ToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';
import { getDefaultWorkerEventStream, type WorkerEventStream } from './worker-event-stream.js';
import {
  withDelegationSlot,
  withWallClockBudget,
  wireDelegationKillSwitchIntegration,
} from './delegation-concurrency.js';
import { providerIdForReasoningIdentifier } from './provider-egress-gate.js';
import type {
  ReasoningBackend,
  ReasoningCallOptions,
  ToolDefinition,
  GenerateWithToolsResult,
} from './reasoning-backend.js';
import { createDelegationHandle, type DelegationHandle } from './delegated-task-observability.js';
import type { ClaudeAgentTaskParams, ClaudeAgentTaskResult } from './claude-agent-query.js';
import type { GovernedAgentPromptInput } from './claude-agent-governance.js';
import type { CanUseTool, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** Default tier for an in-session delegation that does not name one (backward compatible). */
const DEFAULT_SUBAGENT_PROFILE = 'implementer';

/**
 * XP-06: best-effort provider id for concurrency/budget bucketing. An
 * unresolved backend name shares the 'unknown' bucket (still governed by the
 * global cap) rather than skipping governance entirely.
 */
function resolveDelegationProvider(backend: ReasoningBackend): string {
  return providerIdForReasoningIdentifier(backend.name) ?? 'unknown';
}

/**
 * XP-06 choke point shared by all three dispatchers: a global + per-provider
 * concurrency semaphore and a wall-clock budget around the same unit of
 * work each `dispatch()` implementation already did. See
 * `delegation-concurrency.ts` for the "why env config, why no real child
 * handle yet" design notes.
 */
function dispatchWithConcurrencyGovernance<T>(
  backend: ReasoningBackend,
  fn: () => Promise<T>
): Promise<T> {
  // Fire-and-forget, memoized — cheap after the first call.
  wireDelegationKillSwitchIntegration();
  const provider = resolveDelegationProvider(backend);
  return withDelegationSlot({ provider }, () => withWallClockBudget({ provider }, fn));
}

/**
 * Agent dispatch (agent-runtime plane).
 *
 * "How a task is handed to a sub-agent" is an orchestration concern, distinct from
 * "how a single agent thinks" (the {@link ReasoningBackend} cognition substrate).
 * A dispatcher decides *where* delegated work runs — spawn a fresh CLI/SDK child, or
 * route it to an in-process agent over the A2A bridge — without re-implementing the
 * reasoning interface. The reasoning backend's `delegateTask` is just the public
 * entry point; it pass-throughs to the selected dispatcher.
 */
export interface AgentDispatcher {
  readonly name: string;
  /**
   * Hand a task to a sub-agent and return its result.
   * `backend` is the cognition substrate available for planning the dispatch
   * (tool-use) and as a delegation fallback. `options` is the same call-level
   * options bag `ReasoningBackend.delegateTask` already accepts (role/profile
   * hint, budget, ...); it is optional so every pre-existing dispatcher
   * implementation (which predates this parameter) remains a valid
   * implementation without change — CT-02 backward compatibility.
   */
  dispatch(
    instruction: string,
    context: string | undefined,
    backend: ReasoningBackend,
    options?: ReasoningCallOptions
  ): Promise<string>;
}

/**
 * Default strategy: delegate via the backend's own (process/SDK-spawning) `delegateTask`.
 * This is what every install does unless an in-session strategy is selected.
 */
export class ProcessSpawnDispatcher implements AgentDispatcher {
  readonly name = 'process-spawn';

  dispatch(
    instruction: string,
    context: string | undefined,
    backend: ReasoningBackend
  ): Promise<string> {
    return dispatchWithConcurrencyGovernance(backend, () =>
      backend.delegateTask(instruction, context)
    );
  }
}

/**
 * In-process strategy (prototype): ask the backend (via tool use) which sub-agent to
 * invoke, then route the task over the A2A bridge to that agent's session — no new
 * CLI/SDK process is spawned. Falls back to {@link ProcessSpawnDispatcher} when the
 * base backend cannot do tool-use.
 *
 * NOTE: this is the relocated former `InSessionReasoningBackend`. It was never a
 * reasoning backend (13 of its methods threw "Not implemented"); its only real job is
 * dispatch, which is why it lives here in the agent-runtime plane.
 */
export class InSessionDispatcher implements AgentDispatcher {
  readonly name = 'in-session';
  private readonly fallback = new ProcessSpawnDispatcher();
  /** KC-01: consecutive identical invoke_agent calls across dispatches. */
  private repeatGovernor: ToolCallRepeatGovernorState = createToolCallRepeatGovernorState();
  private pendingRepeatReminder: string | undefined;

  dispatch(
    instruction: string,
    context: string | undefined,
    backend: ReasoningBackend
  ): Promise<string> {
    return dispatchWithConcurrencyGovernance(backend, () =>
      this.dispatchInner(instruction, context, backend)
    );
  }

  private async dispatchInner(
    instruction: string,
    context: string | undefined,
    backend: ReasoningBackend
  ): Promise<string> {
    logger.info('[agent-dispatch:in-session] Initiating in-session delegation for task...');

    if (!backend.generateWithTools) {
      logger.warn(
        '[agent-dispatch:in-session] Base backend lacks generateWithTools — falling back to process-spawn delegation.'
      );
      // XP-06: call the backend directly rather than `this.fallback.dispatch`
      // — `dispatchInner` already runs inside `dispatchWithConcurrencyGovernance`
      // (see `dispatch()` above), and `ProcessSpawnDispatcher.dispatch` applies
      // that same governance itself; nesting the two would double-count (and,
      // under a saturated per-provider cap, self-deadlock: the outer slot
      // would never free while waiting on an inner acquire from the same pool).
      return backend.delegateTask(instruction, context);
    }

    // KD-05: the tier catalog is rebuilt from the registry on every dispatch,
    // so the model always sees the current tier list — no manual sync
    // between subagent-capability-profiles.ts and this description.
    const invokeAgentTool: ToolDefinition = {
      name: 'invoke_agent',
      description: [
        "Invoke a specialized sub-agent (e.g., 'codebase_investigator', 'generalist') to perform a complex task.",
        'Choose the least-privileged agent_profile tier that can do the job:',
        describeSubagentCapabilityCatalog(),
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: { type: 'string' },
          prompt: { type: 'string', description: 'Detailed instruction for the sub-agent' },
          agent_profile: {
            type: 'string',
            enum: listSubagentCapabilityProfileNames(),
            description: `Capability tier the sub-agent runs under (KD-05). Defaults to "${DEFAULT_SUBAGENT_PROFILE}" when omitted.`,
          },
        },
        required: ['agent_name', 'prompt'],
      },
    };

    const systemPrompt = [
      "You are a delegating orchestrator. You MUST use the 'invoke_agent' tool to accomplish the following task.",
      'Do NOT attempt to solve it directly.',
    ].join('\n');

    const reminderBlock = this.pendingRepeatReminder
      ? `\n\n<system-reminder>${this.pendingRepeatReminder}</system-reminder>`
      : '';
    const fullPrompt = `${systemPrompt}\n\nTask: ${instruction}\nContext: ${context || 'none'}${reminderBlock}`;
    this.pendingRepeatReminder = undefined;

    try {
      const result = await backend.generateWithTools(fullPrompt, [invokeAgentTool]);
      const toolCall = result.toolCalls?.find((tc) => tc.name === 'invoke_agent');
      if (toolCall) {
        const decision = advanceToolCallRepeatGovernor(
          this.repeatGovernor,
          'invoke_agent',
          toolCall.input
        );
        this.repeatGovernor = decision.state;
        if (decision.should_force_stop) {
          // A dead-end delegation loop: break it with a fresh process-spawn
          // child (new context, new judgment) instead of re-routing in-session.
          logger.error(
            `[agent-dispatch:in-session] invoke_agent repeated ${decision.streak}x with identical arguments — breaking the loop via process-spawn fallback.`
          );
          const { recordGovernanceAction } = await import('./kill-switch.js');
          recordGovernanceAction(
            'agent-dispatch:in-session',
            'tool_call_repeat_force_stop',
            `invoke_agent streak=${decision.streak}`,
            true
          );
          this.repeatGovernor = createToolCallRepeatGovernorState();
          // XP-06: see the comment on the other fallback path above — call
          // the backend directly to avoid nesting concurrency governance.
          return backend.delegateTask(instruction, context);
        }
        if (decision.reminder) {
          logger.warn(`[agent-dispatch:in-session] [repeat-governor] ${decision.reminder}`);
          this.pendingRepeatReminder = decision.reminder;
        }
        const agentName = String(toolCall.input.agent_name || 'generalist');
        const requestedPrompt = String(toolCall.input.prompt || instruction);
        // KD-05: resolve the chosen capability tier and prefix the sub-agent's
        // prompt with its tier-appropriate system prompt. This is the
        // instruction-level half of tier containment; the enforcement-level
        // half is assertSubagentOpAllowed, called by op execution call sites
        // (e.g. secure-io / actuator invocation) once they know the active
        // delegation's tier. An unrecognized tier degrades to the default
        // rather than failing the whole dispatch — the model picking a bad
        // enum value should not brick delegation, but it never widens agency
        // (the default tier is the least-privileged full-write tier only in
        // the sense that it is the historical default before KD-05 existed).
        const requestedProfileName = String(
          toolCall.input.agent_profile || DEFAULT_SUBAGENT_PROFILE
        );
        let profileName = requestedProfileName;
        try {
          getSubagentCapabilityProfile(requestedProfileName);
        } catch {
          logger.warn(
            `[agent-dispatch:in-session] Unknown agent_profile "${requestedProfileName}" — falling back to "${DEFAULT_SUBAGENT_PROFILE}".`
          );
          profileName = DEFAULT_SUBAGENT_PROFILE;
        }
        const profile = getSubagentCapabilityProfile(profileName);
        const agentPrompt = `${profile.systemPromptPrefix}\n\n${requestedPrompt}`;
        logger.info(
          `[agent-dispatch:in-session] LLM chose to invoke sub-agent: ${agentName} (tier: ${profile.name})`
        );
        const subResult = await this.routeToSubAgent(agentName, agentPrompt);
        return `[In-Session Rollup] Sub-agent '${agentName}' completed the task.\nSummary: ${subResult}`;
      }
      return result.text || 'No tool called';
    } catch (err: any) {
      logger.error(`[agent-dispatch:in-session] Delegation failed: ${err?.message ?? err}`);
      throw err;
    }
  }

  /** Route the task to a sub-agent within the same process via the A2A bridge. */
  private async routeToSubAgent(agentName: string, prompt: string): Promise<string> {
    logger.info(`[agent-dispatch:in-session] Waking up sub-agent: ${agentName} via A2A Bridge...`);
    const response = await a2aBridge.route({
      a2a_version: '1.1',
      header: {
        msg_id: `insession-${Date.now()}`,
        sender: 'orchestrator',
        receiver: agentName,
        performative: 'request',
      },
      payload: { content: prompt },
    });
    return typeof response.payload === 'object'
      ? JSON.stringify(response.payload)
      : String(response.payload || 'Sub-agent returned no data.');
  }
}

/**
 * The governed Agent SDK runtime pieces {@link HarnessSubagentDispatcher} needs.
 * Loaded lazily (see {@link loadDefaultGovernedRuntime}) so importing this
 * module never touches the real `@anthropic-ai/claude-agent-sdk` package —
 * only an actual `dispatch()` call does, and only when
 * `KYBERION_HARNESS_SUBAGENT=1` selects this dispatcher. Tests inject a fake
 * runtime (or a rejecting loader, to simulate "SDK unavailable") via the
 * constructor, so they never load the real SDK either.
 */
interface GovernedHarnessRuntime {
  runTask: (params: ClaudeAgentTaskParams) => Promise<ClaudeAgentTaskResult>;
  buildGovernedAgentSystemPrompt: (input: GovernedAgentPromptInput) => string;
  buildKyberionMcpServerConfig: () => Record<string, McpServerConfig>;
  createKyberionCanUseTool: () => CanUseTool;
  /** Advisory allowlist ceiling (GOVERNED_AGENT_ALLOWED_TOOLS); canUseTool is the real enforcer. */
  allowedTools: readonly string[];
}

async function loadDefaultGovernedRuntime(): Promise<GovernedHarnessRuntime> {
  const [{ runClaudeAgentTask }, governance] = await Promise.all([
    import('./claude-agent-query.js'),
    import('./claude-agent-governance.js'),
  ]);
  return {
    runTask: runClaudeAgentTask,
    buildGovernedAgentSystemPrompt: governance.buildGovernedAgentSystemPrompt,
    buildKyberionMcpServerConfig: governance.buildKyberionMcpServerConfig,
    createKyberionCanUseTool: governance.createKyberionCanUseTool,
    allowedTools: governance.GOVERNED_AGENT_ALLOWED_TOOLS,
  };
}

/** Intersect a KD-05 tier's CLI tool projection with the governed ceiling. */
function resolveHarnessAllowedTools(
  profileName: string,
  governedCeiling: readonly string[]
): string[] {
  const tierTools =
    SUBAGENT_PROFILE_CLI_TOOLS[profileName] ?? SUBAGENT_PROFILE_CLI_TOOLS[DEFAULT_SUBAGENT_PROFILE];
  return tierTools.filter((tool) => governedCeiling.includes(tool));
}

export interface HarnessSubagentDispatcherDeps {
  /**
   * Seam replacing {@link loadDefaultGovernedRuntime}. Tests inject a fake
   * runtime to keep the real Agent SDK out of the test process entirely; a
   * rejecting loader deterministically exercises the SDK-unavailable
   * fallback without needing to uninstall or unmock anything.
   */
  loadRuntime?: () => Promise<GovernedHarnessRuntime>;
}

/**
 * CT-02: dispatches delegated tasks through the CLI harness's own Agent SDK
 * sub-agent mechanism (Direction B / governed path — `runClaudeAgentTask` +
 * Kyberion MCP + `canUseTool` + governed system prompt), applying a KD-05
 * capability profile: the profile's `allowedOps` tier is projected onto the
 * SDK's `allowedTools` (intersected with `GOVERNED_AGENT_ALLOWED_TOOLS`,
 * which stays the real ceiling — `canUseTool` enforces it) and its
 * `systemPromptPrefix` is prepended to the sub-agent's system prompt.
 *
 * Selected via `KYBERION_HARNESS_SUBAGENT=1` (see {@link maybeWrapWithDispatcher}).
 * Claude keeps its historical SDK-unavailable fallback. Codex is different:
 * when its app-server/native-subagent capability is unavailable, the
 * dispatcher emits `subagent_unavailable` and fails closed rather than
 * pretending that a process-spawn delegation was a native subagent.
 */
export class HarnessSubagentDispatcher implements AgentDispatcher {
  readonly name = 'harness-subagent';
  /** Typed as the interface (not the concrete class) so the 4-arg dispatch call below type-checks. */
  private readonly fallback: AgentDispatcher = new ProcessSpawnDispatcher();
  private readonly loadRuntime: () => Promise<GovernedHarnessRuntime>;

  constructor(deps: HarnessSubagentDispatcherDeps = {}) {
    this.loadRuntime = deps.loadRuntime ?? loadDefaultGovernedRuntime;
  }

  dispatch(
    instruction: string,
    context: string | undefined,
    backend: ReasoningBackend,
    options?: ReasoningCallOptions
  ): Promise<string> {
    return dispatchWithConcurrencyGovernance(backend, () =>
      this.dispatchInner(instruction, context, backend, options)
    );
  }

  private async dispatchInner(
    instruction: string,
    context: string | undefined,
    backend: ReasoningBackend,
    options?: ReasoningCallOptions
  ): Promise<string> {
    const stream = getDefaultWorkerEventStream();
    const profile = this.resolveProfile(options);

    this.emit(stream, 'subagent_begin', {
      dispatcher: this.name,
      profile: profile.name,
    });

    const provider = resolveDelegationProvider(backend);
    if (provider === 'codex') {
      if (!backend.dispatchHarnessSubagent) {
        const reason =
          'Codex backend does not expose a provider-native app-server subagent session.';
        this.emitUnavailable(stream, profile.name, reason);
        throw new Error(`[SUBAGENT_UNAVAILABLE] ${reason}`);
      }
      try {
        const result = await backend.dispatchHarnessSubagent(instruction, context, {
          ...options,
          profile: profile.name,
        });
        this.emit(stream, 'subagent_end', {
          dispatcher: this.name,
          provider,
          profile: profile.name,
          status: 'success',
          native: true,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('[SUBAGENT_UNAVAILABLE]')) {
          this.emitUnavailable(stream, profile.name, message, provider);
        } else {
          this.emit(stream, 'subagent_end', {
            dispatcher: this.name,
            provider,
            profile: profile.name,
            status: 'failure',
            error: message,
          });
        }
        throw err;
      }
    }

    let runtime: GovernedHarnessRuntime;
    try {
      runtime = await this.loadRuntime();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[agent-dispatch:harness-subagent] Agent SDK unavailable (${message}) — falling back to process-spawn delegation.`
      );
      this.emit(stream, 'subagent_end', {
        dispatcher: this.name,
        profile: profile.name,
        status: 'fallback',
        fallback_to: this.fallback.name,
        reason: message,
      });
      // XP-06: call the backend directly rather than `this.fallback.dispatch`
      // — this method already runs inside `dispatchWithConcurrencyGovernance`
      // (see `dispatch()` below), and nesting it via `ProcessSpawnDispatcher`
      // would double-wrap (and risk self-deadlock under a saturated
      // per-provider cap). `this.fallback` is kept only for its `.name`.
      return backend.delegateTask(instruction, context);
    }

    try {
      const result = await runtime.runTask({
        systemPrompt: runtime.buildGovernedAgentSystemPrompt({
          base: profile.systemPromptPrefix,
          missionContext: context,
        }),
        userPrompt: `Task: ${instruction}`,
        mcpServers: runtime.buildKyberionMcpServerConfig(),
        allowedTools: resolveHarnessAllowedTools(profile.name, runtime.allowedTools),
        canUseTool: runtime.createKyberionCanUseTool(),
      });
      this.emit(stream, 'subagent_end', {
        dispatcher: this.name,
        profile: profile.name,
        status: 'success',
      });
      return result.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[agent-dispatch:harness-subagent] Delegation failed: ${message}`);
      this.emit(stream, 'subagent_end', {
        dispatcher: this.name,
        profile: profile.name,
        status: 'failure',
        error: message,
      });
      throw err;
    }
  }

  /**
   * KD-05 tier resolution: `options.profile` (falling back to `options.role`
   * for callers that only set the governed-role hint) names the tier;
   * unset or unrecognized both degrade to the historical default
   * ({@link DEFAULT_SUBAGENT_PROFILE}) rather than failing the dispatch —
   * matching {@link InSessionDispatcher}'s own degrade-not-fail rule.
   */
  private resolveProfile(options?: ReasoningCallOptions): SubagentCapabilityProfile {
    const requested = options?.profile || options?.role || DEFAULT_SUBAGENT_PROFILE;
    try {
      return getSubagentCapabilityProfile(requested);
    } catch {
      logger.warn(
        `[agent-dispatch:harness-subagent] Unknown profile "${requested}" — falling back to "${DEFAULT_SUBAGENT_PROFILE}".`
      );
      return getSubagentCapabilityProfile(DEFAULT_SUBAGENT_PROFILE);
    }
  }

  private emit(
    stream: WorkerEventStream,
    type: 'subagent_begin' | 'subagent_end' | 'subagent_unavailable',
    payload: Record<string, unknown>
  ): void {
    try {
      stream.emit(type, payload);
    } catch {
      // Event stream projection is best-effort; it must never break dispatch.
    }
  }

  private emitUnavailable(
    stream: WorkerEventStream,
    profile: string,
    reason: string,
    provider = 'codex'
  ): void {
    logger.warn(`[agent-dispatch:harness-subagent] Native subagent unavailable: ${reason}`);
    this.emit(stream, 'subagent_unavailable', {
      dispatcher: this.name,
      provider,
      profile,
      reason,
      fallback_allowed: false,
    });
  }
}

/**
 * NI-03: resolve the KD-05 tier this delegation runs under, mirroring
 * {@link HarnessSubagentDispatcher}'s degrade-not-fail rule (`options.profile`
 * > `options.role` > default; unknown names degrade to the default).
 */
function resolveDelegationTier(options?: ReasoningCallOptions): DelegationCapabilityTier {
  const requested = options?.profile || options?.role || DEFAULT_SUBAGENT_PROFILE;
  try {
    return getSubagentCapabilityProfile(requested).name as DelegationCapabilityTier;
  } catch {
    return DEFAULT_SUBAGENT_PROFILE as DelegationCapabilityTier;
  }
}

/**
 * NI-03: best-effort identity of the CURRENT actor for chain origination.
 * There is no authenticated "who am I" seam in a worker process yet, so this
 * mirrors authority.ts's role resolution inputs (SYSTEM_ROLE / MISSION_ROLE)
 * and projects them onto an NI-01 nhi_id when the slug derives cleanly,
 * falling back to a legacy `actor:<role>` string. Documented best-effort:
 * the chain root recorded here is an attribution claim, not a verified
 * identity (NI-02's registry verification applies where the chain is
 * consumed).
 */
function resolveBestEffortDelegationActor(): string {
  const role =
    String(process.env.SYSTEM_ROLE || process.env.MISSION_ROLE || 'delegating-agent')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'delegating-agent';
  try {
    return deriveAgentNhiId(role) ?? `actor:${role}`;
  } catch {
    return `actor:${role}`;
  }
}

/**
 * NI-03 chain propagation at the delegation choke point
 * ({@link DispatchingReasoningBackend.delegateTask}). The chain travels in
 * the `context` string as a marked block (see delegation-chain.ts), because
 * `delegateTask(instruction, context)` is the only channel every dispatcher
 * and backend already threads through.
 *
 * - Incoming context carries a chain → append this delegation's sub-worker
 *   link (tier from {@link resolveDelegationTier}) and validate attenuation
 *   FAIL-CLOSED before any dispatch happens. The sub-worker has no durable
 *   identity at this seam (process-spawn children are anonymous), so its
 *   actor is the documented placeholder `subagent:<dispatcher>:<tier>` until
 *   spawned sub-workers acquire NHIs.
 * - Incoming context carries a MALFORMED chain block → fail closed too (a
 *   corrupted chain is a bug, not a legacy path).
 * - No chain present → originate a single-link chain rooted at the current
 *   actor (best-effort, see {@link resolveBestEffortDelegationActor}) with an
 *   unrestricted scope, so the next chain-aware hop appends onto a recorded
 *   root instead of starting blind. Chain-less LEGACY payloads elsewhere are
 *   untouched — this only augments the context string of governed dispatch.
 */
function propagateDelegationChainThroughContext(
  context: string | undefined,
  options: ReasoningCallOptions | undefined,
  dispatcherName: string
): string {
  const extracted = extractDelegationChainFromContext(context);
  if (extracted.malformed) {
    throw new DelegationAttenuationError([
      'embedded delegation-chain block is malformed — refusing to dispatch on a corrupted chain',
    ]);
  }
  if (extracted.chain) {
    const tier = resolveDelegationTier(options);
    const extended = appendDelegationLink(
      extracted.chain,
      buildDelegationLink({
        actor: `subagent:${dispatcherName}:${tier}`,
        ...(options?.role ? { team_role: options.role } : {}),
        granted_scope: { capability_tier: tier },
      })
    );
    assertChainAttenuation(extended); // fail-closed BEFORE dispatch
    return embedDelegationChainInContext(extracted.contextWithoutChain, extended);
  }
  const origin = [
    buildDelegationLink({ actor: resolveBestEffortDelegationActor(), granted_scope: {} }),
  ];
  return embedDelegationChainInContext(context, origin);
}

/**
 * A reasoning backend decorator whose `delegateTask` routes through the agent-runtime
 * dispatch plane, while every cognition op forwards verbatim to the wrapped base
 * backend. This keeps `delegateTask` on the {@link ReasoningBackend} interface (so all
 * existing call sites are untouched) without forcing a dispatch strategy to masquerade
 * as a full reasoning backend.
 */
export class DispatchingReasoningBackend implements ReasoningBackend {
  name: string;

  constructor(
    private readonly base: ReasoningBackend,
    private readonly dispatcher: AgentDispatcher
  ) {
    this.name = `${base.name}+${dispatcher.name}`;
  }

  delegateTask(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    // NI-03: continue (or originate) the delegation chain BEFORE dispatch —
    // an attenuation violation rejects here and the dispatcher never runs.
    let chainedContext: string;
    try {
      chainedContext = propagateDelegationChainThroughContext(
        context,
        options,
        this.dispatcher.name
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.dispatcher.dispatch(instruction, chainedContext, this.base, options);
  }

  delegateTaskHandle(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): DelegationHandle {
    return createDelegationHandle({
      instruction,
      ...(context ? { context } : {}),
      backendName: this.name,
      execute: (signal) =>
        this.delegateTask(instruction, context, { ...options, ...(signal ? { signal } : {}) }),
    });
  }

  // --- cognition substrate: forward verbatim to the wrapped base backend ---
  divergePersonas(...a: Parameters<ReasoningBackend['divergePersonas']>) {
    return this.base.divergePersonas(...a);
  }
  crossCritique(...a: Parameters<ReasoningBackend['crossCritique']>) {
    return this.base.crossCritique(...a);
  }
  synthesizePersona(...a: Parameters<ReasoningBackend['synthesizePersona']>) {
    return this.base.synthesizePersona(...a);
  }
  forkBranches(...a: Parameters<ReasoningBackend['forkBranches']>) {
    return this.base.forkBranches(...a);
  }
  simulateBranches(...a: Parameters<ReasoningBackend['simulateBranches']>) {
    return this.base.simulateBranches(...a);
  }
  extractRequirements(...a: Parameters<ReasoningBackend['extractRequirements']>) {
    return this.base.extractRequirements(...a);
  }
  extractDesignSpec(...a: Parameters<ReasoningBackend['extractDesignSpec']>) {
    return this.base.extractDesignSpec(...a);
  }
  extractTestPlan(...a: Parameters<ReasoningBackend['extractTestPlan']>) {
    return this.base.extractTestPlan(...a);
  }
  decomposeIntoTasks(...a: Parameters<ReasoningBackend['decomposeIntoTasks']>) {
    return this.base.decomposeIntoTasks(...a);
  }
  prompt(...a: Parameters<ReasoningBackend['prompt']>) {
    return this.base.prompt(...a);
  }
  generateWithTools(prompt: string, tools: ToolDefinition[]): Promise<GenerateWithToolsResult> {
    if (this.base.generateWithTools) return this.base.generateWithTools(prompt, tools);
    return this.base.prompt(prompt).then((text) => ({ text }));
  }
}

/**
 * Select the dispatch strategy from the environment (default: process-spawn).
 * `KYBERION_HARNESS_SUBAGENT=1` (CT-02) takes precedence over
 * `KYBERION_IN_SESSION_SUBAGENT=1` when both are set — the harness path is
 * the more capable / more governed of the two opt-ins.
 */
export function selectAgentDispatcher(env: NodeJS.ProcessEnv = process.env): AgentDispatcher {
  if (env.KYBERION_HARNESS_SUBAGENT === '1') return new HarnessSubagentDispatcher();
  if (env.KYBERION_IN_SESSION_SUBAGENT === '1') return new InSessionDispatcher();
  return new ProcessSpawnDispatcher();
}

/**
 * Wrap a base reasoning backend so its `delegateTask` routes through the configured
 * agent-runtime dispatch strategy. Returns the base **unchanged** when the default
 * (process-spawn) strategy is active, so normal installs are untouched.
 */
export function maybeWrapWithDispatcher(
  backend: ReasoningBackend,
  env: NodeJS.ProcessEnv = process.env
): ReasoningBackend {
  if (env.KYBERION_HARNESS_SUBAGENT === '1') {
    logger.success('[agent-dispatch] ⚡ Harness sub-agent dispatch enabled (CT-02)');
    return new DispatchingReasoningBackend(backend, new HarnessSubagentDispatcher());
  }
  if (env.KYBERION_IN_SESSION_SUBAGENT === '1') {
    logger.success('[agent-dispatch] ⚡ In-Session sub-agent dispatch enabled');
    return new DispatchingReasoningBackend(backend, new InSessionDispatcher());
  }
  return backend;
}
