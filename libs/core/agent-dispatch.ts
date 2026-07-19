import { a2aBridge } from './a2a-bridge.js';
import { logger } from './core.js';
import {
  advanceToolCallRepeatGovernor,
  createToolCallRepeatGovernorState,
  type ToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';
import type {
  ReasoningBackend,
  ToolDefinition,
  GenerateWithToolsResult,
} from './reasoning-backend.js';

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
   * (tool-use) and as a delegation fallback.
   */
  dispatch(instruction: string, context: string | undefined, backend: ReasoningBackend): Promise<string>;
}

/**
 * Default strategy: delegate via the backend's own (process/SDK-spawning) `delegateTask`.
 * This is what every install does unless an in-session strategy is selected.
 */
export class ProcessSpawnDispatcher implements AgentDispatcher {
  readonly name = 'process-spawn';

  dispatch(instruction: string, context: string | undefined, backend: ReasoningBackend): Promise<string> {
    return backend.delegateTask(instruction, context);
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

  async dispatch(instruction: string, context: string | undefined, backend: ReasoningBackend): Promise<string> {
    logger.info('[agent-dispatch:in-session] Initiating in-session delegation for task...');

    if (!backend.generateWithTools) {
      logger.warn(
        '[agent-dispatch:in-session] Base backend lacks generateWithTools — falling back to process-spawn delegation.',
      );
      return this.fallback.dispatch(instruction, context, backend);
    }

    const invokeAgentTool: ToolDefinition = {
      name: 'invoke_agent',
      description:
        "Invoke a specialized sub-agent (e.g., 'codebase_investigator', 'generalist') to perform a complex task.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: { type: 'string' },
          prompt: { type: 'string', description: 'Detailed instruction for the sub-agent' },
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
            `[agent-dispatch:in-session] invoke_agent repeated ${decision.streak}x with identical arguments — breaking the loop via process-spawn fallback.`,
          );
          const { recordGovernanceAction } = await import('./kill-switch.js');
          recordGovernanceAction(
            'agent-dispatch:in-session',
            'tool_call_repeat_force_stop',
            `invoke_agent streak=${decision.streak}`,
            true,
          );
          this.repeatGovernor = createToolCallRepeatGovernorState();
          return this.fallback.dispatch(instruction, context, backend);
        }
        if (decision.reminder) {
          logger.warn(`[agent-dispatch:in-session] [repeat-governor] ${decision.reminder}`);
          this.pendingRepeatReminder = decision.reminder;
        }
        const agentName = String(toolCall.input.agent_name || 'generalist');
        const agentPrompt = String(toolCall.input.prompt || instruction);
        logger.info(`[agent-dispatch:in-session] LLM chose to invoke sub-agent: ${agentName}`);
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
    private readonly dispatcher: AgentDispatcher,
  ) {
    this.name = `${base.name}+${dispatcher.name}`;
  }

  delegateTask(instruction: string, context?: string): Promise<string> {
    return this.dispatcher.dispatch(instruction, context, this.base);
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

/** Select the dispatch strategy from the environment (default: process-spawn). */
export function selectAgentDispatcher(env: NodeJS.ProcessEnv = process.env): AgentDispatcher {
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
  env: NodeJS.ProcessEnv = process.env,
): ReasoningBackend {
  if (env.KYBERION_IN_SESSION_SUBAGENT === '1') {
    logger.success('[agent-dispatch] ⚡ In-Session sub-agent dispatch enabled');
    return new DispatchingReasoningBackend(backend, new InSessionDispatcher());
  }
  return backend;
}
