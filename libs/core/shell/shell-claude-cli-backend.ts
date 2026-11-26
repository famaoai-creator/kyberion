import {
  credentialExecutionIdentity,
  assertCredentialOwner,
  hasTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { assertOperatorNativeCredentialOwner } from '../agent/native-credential-fence.js';
/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * Shell Claude CLI Backend — spawns the local `claude` CLI in `-p --output-format json`
 * mode to run structured-output reasoning tasks. Designed for environments that
 * already have Claude Code (CLI) installed and authenticated (OAuth via keychain
 * or ANTHROPIC_API_KEY in env).
 *
 * Unlike `ClaudeAgentReasoningBackend` which uses the in-process Agent SDK,
 * this backend shells out to the CLI so it works anywhere `claude --version`
 * succeeds, including inside a parent Claude Code session (auth inherited via
 * the OS keychain).
 *
 * Each reasoning method turns into one `claude -p` invocation with
 *   --system-prompt <...>
 *   --json-schema <...>
 *   --output-format json
 *   --model <...>
 * and parses the `structured_output` field from the CLI's JSON result.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cliOptionValue } from '../harnessing/cli-guard.js';
import { memoizedCliSpawnSync } from '../provider/provider-discovery.js';
import * as readline from 'node:readline';
import {
  buildDelegationSpawnEnvWithRelay,
  newDelegationSessionId,
  spawnWithDelegationEnv,
} from '../provider/provider-spawn-env.js';
import {
  buildProviderChildEnv,
  resolveEffectiveProviderPermissionProfile,
  resolveProviderPermissionArgs,
  type ProviderPermissionProfileName,
} from '../provider/provider-permission-profiles.js';
import { assertReasoningEgressAllowed } from '../reasoning/reasoning-egress-scope.js';
import {
  delegationChildHandleFromChildProcess,
  withWallClockBudget,
  DelegationWallClockExceededError,
  DelegationInactivityExceededError,
} from '../mission/delegation-concurrency.js';
import { captureDelegationProgressReporter } from '../mission/delegation-progress.js';
import { z, type ZodType } from 'zod';
import { logger } from '../core.js';
import { resolveRuntimeModelId } from '../tool/runtime-model-defaults.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { resolveProviderCliCommand } from '../provider/provider-managed-env.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import {
  redactProviderOutputError,
  redactProviderOutputStream,
  redactProviderOutputValue,
  withRedactedProviderOutput,
} from '../provider/provider-output-redaction.js';
import {
  cliOutputFormat,
  parseClaudeCliUsage,
  recordCliUsage,
} from '../provider/cli-usage-metering.js';
import { isClaudeCliAuthenticated } from '../provider/claude-cli-auth-status.js';
import {
  CLAUDE_TENANT_ISOLATION_ARGS,
  boundClaudeCredentialValues,
  prepareClaudeBoundLaunch,
} from '../provider/claude-cli-tenant-isolation.js';
import {
  CLAUDE_CLI_PLACEHOLDER_SIGNATURE,
  isClaudeCliFallbackEligible,
  resolveClaudeCliFallbackCandidates,
} from '../provider/claude-cli-resolution.js';
export {
  CLAUDE_CLI_PLACEHOLDER_SIGNATURE,
  type ClaudeCliFallbackCandidateOptions,
  isClaudeCliFallbackEligible,
  isClaudeCliPlaceholderFailure,
  resolveClaudeCliFallbackCandidates,
} from '../provider/claude-cli-resolution.js';
import type { NativeSubagentAdopter } from '../media/native-subagent-adopter.js';
import { ClaudeCliSessionAdapter } from '../provider/claude-cli-session-adapter.js';
import { buildClaudeNativeDelegationPrompt } from '../provider/claude-native-subagent.js';
import { getSubagentCapabilityProfile } from '../workforce/subagent-capability-profiles.js';
import type { AgentAskOptions, AgentResponse } from '../agent/agent-adapter.js';
import type {
  ReasoningBackend,
  ReasoningCallOptions,
  ReasoningTextStream,
  DivergeHypothesisInput,
  HypothesisSketch,
  CritiqueInput,
  CritiqueResult,
  PersonaSynthesisInput,
  SynthesizedPersona,
  BranchForkInput,
  ForkedBranch,
  SimulationInput,
  SimulationResult,
  ExtractRequirementsInput,
  ExtractedRequirements,
  ExtractDesignSpecInput,
  ExtractedDesignSpec,
  ExtractTestPlanInput,
  ExtractedTestPlan,
  DecomposeIntoTasksInput,
  DecomposedTaskPlan,
  GenerateWithToolsResult,
  ToolDefinition,
} from '../reasoning/reasoning-backend.js';
import { isPromptedToolCallingEnabled } from '../reasoning/reasoning-backend-policy.js';
import {
  parsePromptedToolResponse,
  renderPromptedToolProtocol,
} from '../reasoning/prompted-tool-protocol.js';
import { runStartReportingDelegation } from '../workforce/delegation-execution-tracker.js';

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

/**
 * Task-weight → claude model mapping (①モデル振り分け): fast tasks run on the
 * governed fast model, standard on the governed standard model, deep on the
 * backend's configured heavy model (provider-config.json runtime_defaults).
 */
export function resolveClaudeModelForTier(
  tier: 'fast' | 'standard' | 'deep' | undefined,
  defaultModel: string
): string {
  if (tier === 'fast') return resolveRuntimeModelId('anthropic-fast');
  if (tier === 'standard') return resolveRuntimeModelId('anthropic-standard');
  if (tier === 'deep') return defaultModel || resolveRuntimeModelId('anthropic-default');
  return defaultModel;
}

export interface ShellClaudeCliBackendOptions {
  /** CLI binary. Defaults to `claude` (resolved via PATH). */
  bin?: string;
  /** Model alias or governed id. Defaults to runtime_defaults['anthropic-default']. */
  model?: string;
  /** Per-call hard ceiling. Defaults to 10 min; the claude-cli route policy raises it. */
  timeoutMs?: number;
  /**
   * Batch calls fail early when the CLI prints no stream record at all within
   * this window (hung at launch: auth prompt, keychain, MCP boot). Default 90 s.
   */
  startupTimeoutMs?: number;
  /**
   * Batch calls fail when no assistant message / tool event arrives for this
   * long, so a frozen turn fails over well before the hard ceiling. Default 5 min.
   */
  inactivityMs?: number;
  /** Additional CLI args to inject (e.g. --effort high). */
  extraArgs?: string[];
  /**
   * CN-02: expose the provider-native sub-agent adopter (one shared
   * stream-json CLI session, delegation as a real Claude sub-agent) instead
   * of spawning `claude -p` per delegated task. Defaults to
   * `KYBERION_CLAUDE_NATIVE_SUBAGENT === '1'`; an explicit value wins.
   */
  nativeSubagent?: boolean;
  /** Test seam and runtime injection for the shared native CLI session. */
  harnessSession?: ClaudeHarnessSession;
  /**
   * Expose `generateWithTools` through the prompted tool-calling protocol.
   * Defaults to the governed `prompted_tool_calling["claude-cli"]` policy
   * value (on); an explicit value wins.
   */
  promptedToolCalling?: boolean;
}

/**
 * Provider-native session contract this backend delegates through — the
 * Claude counterpart of `CodexHarnessSession` / `AgyHarnessSession`.
 */
export interface ClaudeHarnessSession {
  boot(): Promise<void>;
  ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  askNativeSubagent?(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  getRuntimeInfo?(): Record<string, unknown>;
  /** Executed by resetSession() for backend-owned sessions only. */
  shutdown?(): Promise<void>;
}

export interface ShellClaudeCliAvailability {
  available: boolean;
  reason?: string;
  /**
   * The binary that actually passed the probe. Differs from the default
   * `claude` when the LC-03 placeholder fallback selected a real CLI outside
   * `node_modules/.bin` (see `resolveClaudeCliFallbackCandidates`).
   */
  bin?: string;
}

export interface BrowserAgentTaskInput {
  /** Natural language instruction for the browser / computer-use task. */
  instruction: string;
  /** Optional context to prepend to the prompt. */
  context?: string;
  /** Maximum number of agentic turns. Defaults to 10. */
  maxTurns?: number;
}

export interface DocumentAgentTaskInput {
  /** Natural language instruction for the document or media generation task. */
  instruction: string;
  /** Optional context to prepend to the prompt. */
  context?: string;
  /** Maximum number of agentic turns. Defaults to 15. */
  maxTurns?: number;
}

export class ShellClaudeCliBackend implements ReasoningBackend {
  readonly name = 'shell-claude-cli';
  private readonly nativeCredentialOwner = credentialExecutionIdentity();
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly inactivityMs: number;
  private readonly extraArgs: string[];
  private readonly nativeSubagentEnabled: boolean;
  private readonly injectedHarnessSession?: ClaudeHarnessSession;
  private readonly nativeSubagentAdopter: NativeSubagentAdopter;
  private harnessSession?: ClaudeHarnessSession;
  private harnessSignature?: string;
  private harnessBoot?: Promise<void>;
  private harnessQueue: Promise<void> = Promise.resolve();
  private lastHarnessSubagentInfo: Record<string, unknown> | null = null;

  constructor(options: ShellClaudeCliBackendOptions = {}) {
    this.bin = options.bin ?? 'claude';
    this.model = options.model ?? resolveRuntimeModelId('anthropic-default');
    // 10 min: a tool-loop turn over a large organization context routinely
    // needs more than 5 min; KYBERION_CLAUDE_CLI_TIMEOUT_MS still overrides.
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? CLAUDE_CLI_DEFAULT_STARTUP_TIMEOUT_MS;
    this.inactivityMs = options.inactivityMs ?? CLAUDE_CLI_DEFAULT_INACTIVITY_MS;
    this.extraArgs = options.extraArgs ?? [];
    this.nativeSubagentEnabled =
      options.nativeSubagent ??
      (options.harnessSession !== undefined ||
        getRegisteredEnvText('KYBERION_CLAUDE_NATIVE_SUBAGENT') === '1');
    if (options.harnessSession) this.injectedHarnessSession = options.harnessSession;
    // Assigned only when opted in, so capability probes that test for
    // `generateWithTools` presence (failover chain, dot wake resolution)
    // answer truthfully when the policy switches it off.
    if (options.promptedToolCalling ?? isPromptedToolCallingEnabled('claude-cli')) {
      this.generateWithTools = (prompt, tools, callOptions) =>
        this.generateWithPromptedTools(prompt, tools, callOptions);
    }
    this.nativeSubagentAdopter = {
      id: 'claude-cli',
      supportsSemanticProgress: !options.harnessSession,
      dispatch: (instruction, context, callOptions) =>
        this.dispatchNativeSubagent(instruction, context, callOptions),
      getInfo: () => (this.lastHarnessSubagentInfo ? { ...this.lastHarnessSubagentInfo } : null),
    };
  }

  /**
   * Operator CLI extras (KYBERION_CLAUDE_CLI_EXTRA_ARGS) apply to operator
   * runs only: a bound (tenant) launch never inherits operator settings.
   */
  private callerExtraArgs(): string[] {
    return hasTaskCredentialBinding() ? [] : this.extraArgs;
  }

  /** The validated executable path used by this backend and its adapters. */
  getBinaryPath(): string {
    return this.bin;
  }

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    const minPer = Math.max(1, input.minPerPersona ?? 2);
    const schema = z.object({
      hypotheses: z.array(
        z.object({
          id: z.string(),
          proposed_by: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'survived', 'rejected']).optional(),
        })
      ),
    });
    const result = await this.runStructured({
      systemPrompt:
        'You generate divergent hypotheses from multiple personas independently. ' +
        'Each persona must propose hypotheses true to their own worldview without compromising for others. ' +
        'Output JSON that matches the schema exactly. Content should be in the language of the topic.',
      userPrompt: [
        `Topic: ${input.topic}`,
        '',
        `Personas (each must propose at least ${minPer} hypotheses):`,
        ...input.personas.map((p, i) => `  ${i + 1}. ${p}`),
        '',
        'Produce hypotheses as a flat array. For each hypothesis:',
        '- "id": H-{persona-slug}-{n}',
        '- "proposed_by": the exact persona label',
        '- "content": the hypothesis, written in that persona\'s voice',
        '- "status": "pending"',
      ].join('\n'),
      schema,
    });
    return result.hypotheses;
  }

  async crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    const schema = z.object({
      hypotheses: z.array(
        z.object({
          id: z.string(),
          proposed_by: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'survived', 'rejected']),
          survived: z.boolean(),
          rejection_reason: z.string().optional(),
          critiques: z.array(z.object({ by: z.string(), content: z.string() })).optional(),
        })
      ),
    });
    const result = await this.runStructured({
      systemPrompt:
        'You run a cross-critique pass. Each persona critiques hypotheses proposed by OTHER personas. ' +
        'Mark each hypothesis as survived (still valid after critique) or rejected (killed by critique). ' +
        'Provide critiques.content in the voice of the critiquing persona.',
      userPrompt: [
        `Topic: ${input.topic}`,
        '',
        'Hypotheses to critique:',
        JSON.stringify(input.hypotheses, null, 2),
        '',
        'Critiquing personas:',
        ...input.personas.map((p) => `- ${p}`),
        '',
        'For each hypothesis, add critiques from personas OTHER than its proposed_by.',
        'Set survived=true if the hypothesis holds up, false if demolished.',
      ].join('\n'),
      schema,
    });
    return result;
  }

  async synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    const fidelity = input.fidelity ?? 'high';
    const schema = z.object({
      fidelity: z.enum(['low', 'medium', 'high']),
      identity: z.record(z.string(), z.any()),
      style_hints: z.record(z.string(), z.any()),
      ng_topics: z.array(z.string()),
      recent_history_summary: z.array(z.any()),
    });
    return this.runStructured({
      systemPrompt:
        'You synthesize a counterparty persona from a relationship node for rehearsal / role-play. ' +
        'Respect fidelity level: low = role-only, medium = + communication style, high = + recent history.',
      userPrompt: [
        `Fidelity: ${fidelity}`,
        'Relationship node (JSON):',
        JSON.stringify(input.relationshipNode, null, 2),
      ].join('\n'),
      schema,
    });
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    const schema = z.object({
      branches: z.array(
        z.object({
          branch_id: z.string(),
          hypothesis_ref: z.string(),
          worktree_path: z.string(),
        })
      ),
    });
    const result = await this.runStructured({
      systemPrompt:
        'You fork short-horizon branches from surviving hypotheses for counterfactual simulation. ' +
        'Each branch_id should be stable and hypothesis_ref maps to the hypothesis id.',
      userPrompt: [
        `Execution profile: ${input.executionProfile}`,
        `Cost cap (tokens): ${input.costCapTokens}`,
        `Max steps per branch: ${input.maxStepsPerBranch}`,
        '',
        'Hypotheses to fork from:',
        JSON.stringify(input.hypotheses, null, 2),
        '',
        'Return one branch per surviving hypothesis (skip rejected ones).',
        'worktree_path format: active/missions/{mission_id}/evidence/counterfactual-branches/{branch_id}/',
      ].join('\n'),
      schema,
    });
    return result.branches;
  }

  async simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    const schema = z.object({
      branches: z.array(
        z.object({
          branch_id: z.string(),
          hypothesis_ref: z.string(),
          first_failure_mode: z.string().nullable(),
          first_success_mode: z.string().nullable(),
          terminated_at_step: z.number().nullable(),
        })
      ),
    });
    return (await this.runStructured({
      systemPrompt:
        'You simulate short-horizon execution of branches toward a goal, reporting first-failure / first-success modes. ' +
        'Do not actually execute anything — produce a reasoned simulation narrative per branch.',
      userPrompt: [
        `Goal: ${input.goal}`,
        `Max steps per branch: ${input.maxStepsPerBranch ?? 10}`,
        '',
        'Branches to simulate:',
        JSON.stringify(input.branches, null, 2),
      ].join('\n'),
      schema,
    })) as SimulationResult;
  }

  async extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    const schema = z.object({
      functional_requirements: z.array(z.any()),
      non_functional_requirements: z.array(z.any()),
      constraints: z.array(z.any()),
      assumptions: z.array(z.any()),
      open_questions: z.array(z.any()),
      scope: z
        .object({
          in_scope: z.array(z.string()).optional(),
          out_of_scope: z.array(z.string()).optional(),
        })
        .optional(),
    });
    const result = (await this.runStructured({
      systemPrompt:
        'You extract structured requirements from an elicitation transcript. ' +
        'Functional requirements get IDs like FR-001. Non-functional get NFR-001. ' +
        'Be exhaustive but do not invent — flag unknowns as open_questions. ' +
        'Set open_questions[].blocking=true only when the unanswered item blocks the current MVP; otherwise omit it or set it false. ' +
        'Do not convert interviewer follow-up questions into open questions unless the customer explicitly says the detail is unknown or blocking.',
      userPrompt: [
        input.projectName ? `Project: ${input.projectName}` : '',
        input.language ? `Source language: ${input.language}` : '',
        input.customer ? `Customer: ${JSON.stringify(input.customer)}` : '',
        '',
        'Source text:',
        input.sourceText,
        '',
        input.priorDraft
          ? `Prior draft to refine:\n${JSON.stringify(input.priorDraft, null, 2)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
    })) as ExtractedRequirements;
    return result;
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    const schema = z.object({
      architecture_summary: z.string().optional(),
      components: z.array(z.any()),
      data_flows: z.array(z.any()),
      cross_cutting_concerns: z.record(z.string(), z.any()).optional(),
      trade_offs: z.array(z.any()),
      risks: z.array(z.any()),
      open_decisions: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt:
        'You derive an architectural design spec from requirements. ' +
        'Each component has id/name/responsibility/interfaces. Identify data flows, trade-offs, risks, open decisions.',
      userPrompt: [
        input.projectName ? `Project: ${input.projectName}` : '',
        '',
        'Requirements draft:',
        JSON.stringify(input.requirementsDraft, null, 2),
        '',
        input.additionalContext ? `Additional context:\n${input.additionalContext}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
    })) as ExtractedDesignSpec;
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    const schema = z.object({
      app_id: z.string(),
      cases: z.array(z.any()),
      coverage_strategy: z.string().optional(),
    });
    return (await this.runStructured({
      systemPrompt:
        'You derive a test plan from requirements (+ optional design spec). ' +
        'Each case has case_id (TC-001), title, objective, steps, expected, priority, type.',
      userPrompt: [
        input.appId ? `App id: ${input.appId}` : '',
        input.projectName ? `Project: ${input.projectName}` : '',
        '',
        'Requirements draft:',
        JSON.stringify(input.requirementsDraft, null, 2),
        '',
        input.designSpec ? `Design spec:\n${JSON.stringify(input.designSpec, null, 2)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
    })) as ExtractedTestPlan;
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    const schema = z.object({
      strategy_summary: z.string().optional(),
      tasks: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt:
        'You decompose requirements + optional design into an ordered implementation task plan. ' +
        'Each task: task_id (T-001), title, summary, priority (must/should/could/wont), estimate (XS-XL), depends_on[], fulfills_requirements[].',
      userPrompt: [
        input.projectName ? `Project: ${input.projectName}` : '',
        '',
        'Requirements draft:',
        JSON.stringify(input.requirementsDraft, null, 2),
        '',
        input.designSpec ? `Design spec:\n${JSON.stringify(input.designSpec, null, 2)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
    })) as DecomposedTaskPlan;
  }

  delegateTask(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    // R5: every dispatch path spawns through spawnWithDelegationEnv, which
    // marks the start once a child exists — an earlier failure is pre-start.
    return runStartReportingDelegation(() =>
      this.dispatchDelegatedTask(instruction, context, options)
    );
  }

  private async dispatchDelegatedTask(
    instruction: string,
    context: string | undefined,
    options: ReasoningCallOptions | undefined
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const model = options?.model ?? resolveClaudeModelForTier(options?.model_tier, this.model);
    const permissionProfile = options?.advisory
      ? 'planner'
      : options?.profile === 'planner' ||
          options?.profile === 'explorer' ||
          options?.profile === 'implementer'
        ? options.profile
        : undefined;
    const permissionArgs = this.resolvePermissionArgs(permissionProfile);
    const args = [
      '-p',
      `${instruction}\n\nContext: ${context ?? 'none'}`,
      '--model',
      model,
      ...(options?.effort ? ['--effort', options.effort] : []),
      ...permissionArgs,
      // Advice-only calls have a closed argv: custom extras must not append
      // a second permission-mode flag after the governed planner projection.
      // They also close the operator's settings / MCP / hooks surface (the
      // prompted-tools tuple): the prompt is self-contained, so the repo
      // CLAUDE.md and the operator's auto-memory were ~13k chars of per-call
      // cache_creation that never hit (the CLI's only message-level cache
      // breakpoint sits after the per-call prompt), and operator memory has
      // no business in a resident's advisory turn.
      ...(options?.advisory ? CLAUDE_TENANT_ISOLATION_ARGS : this.callerExtraArgs()),
    ];
    return this.spawnCli(
      args,
      '',
      options?.signal,
      resolveEffectiveProviderPermissionProfile('claude', permissionProfile)
    );
  }

  async prompt(prompt: string, options?: ReasoningCallOptions): Promise<string> {
    return this.delegateTask(prompt, undefined, options);
  }

  /**
   * Single-turn tool use over the prompted tool-calling protocol. Present only
   * when opted in (see {@link ShellClaudeCliBackendOptions.promptedToolCalling}).
   */
  generateWithTools?: (
    prompt: string,
    tools: ToolDefinition[],
    options?: ReasoningCallOptions
  ) => Promise<GenerateWithToolsResult>;

  /**
   * The CLI only proposes calls: its own built-in tools are removed
   * (`--tools ''`) and the read-only planner permission profile still
   * applies, so nothing runs inside the CLI. Kyberion's goal driver executes
   * the parsed calls. The argv is closed — custom extras are not appended.
   */
  private async generateWithPromptedTools(
    prompt: string,
    tools: ToolDefinition[],
    options?: ReasoningCallOptions
  ): Promise<GenerateWithToolsResult> {
    assertReasoningEgressAllowed(this.name);
    const model = options?.model ?? resolveClaudeModelForTier(options?.model_tier, this.model);
    const args = [
      '-p',
      '--tools',
      '',
      ...CLAUDE_TENANT_ISOLATION_ARGS,
      '--model',
      model,
      ...(options?.effort ? ['--effort', options.effort] : []),
      ...this.resolvePermissionArgs('planner'),
    ];
    const stdout = await this.spawnCli(
      args,
      renderPromptedToolProtocol(prompt, tools),
      options?.signal,
      resolveEffectiveProviderPermissionProfile('claude', 'planner')
    );
    const outcome = parsePromptedToolResponse(stdout, tools);
    for (const refusal of outcome.rejected) {
      logger.warn(
        `[shell-claude-cli] refused prompted tool call "${refusal.name}" — ${refusal.reason} | next: the model sees the refusal in this turn's text | evidence: ${tools.length} tool(s) offered`
      );
    }
    if (outcome.malformed) {
      logger.warn(
        '[shell-claude-cli] prompted tool-call block was not valid JSON — returned as text with no tool calls | next: the goal loop treats the turn as prose | evidence: tool_calls block present'
      );
    }
    return outcome.result;
  }

  /**
   * Stream text deltas from the Claude CLI when the installed CLI supports
   * partial messages. Keeping this in the provider adapter lets the realtime
   * voice loop begin sentence-level TTS before the whole answer is complete.
   */
  streamPrompt(prompt: string, options?: ReasoningCallOptions): ReasoningTextStream {
    return redactProviderOutputStream(this.streamPromptFromCli(prompt, options));
  }

  private async *streamPromptFromCli(
    prompt: string,
    options?: ReasoningCallOptions
  ): ReasoningTextStream {
    assertReasoningEgressAllowed(this.name);
    if (options?.signal?.aborted) throw new Error('reasoning stream aborted');

    const model = options?.model ?? resolveClaudeModelForTier(options?.model_tier, this.model);
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--model',
      model,
      ...(options?.effort ? ['--effort', options.effort] : []),
      ...this.resolvePermissionArgs(options?.advisory ? 'planner' : undefined),
      ...this.callerExtraArgs(),
    ];
    const started = Date.now();
    const usageEvents: string[] = [];
    let completionChars = 0;
    let meteringStatus: 'success' | 'error' = 'error';
    let requestNotSent = false;
    // §4: a bound launch gets the isolated argv and a tenant scratch cwd, or
    // fails closed here — before any env is built or child is spawned.
    const bound = prepareClaudeBoundLaunch(args);
    // Captured while the binding is live: the child's close event and the
    // finally below dispose the launch before a stderr-bearing error surfaces.
    const launchSecrets = bound ? boundClaudeCredentialValues() : [];
    let spawnEnv: Awaited<ReturnType<typeof buildDelegationSpawnEnvWithRelay>>;
    let child: ChildProcessWithoutNullStreams;
    try {
      // Keep the same provider-scoped child environment as the batch path.
      const pendingSpawnEnv = buildDelegationSpawnEnvWithRelay({
        provider: 'claude',
        sessionId: newDelegationSessionId('claude'),
        profile: resolveEffectiveProviderPermissionProfile(
          'claude',
          options?.advisory ? 'planner' : undefined
        ),
      });
      // Await only when a credential relay had to start (no extra tick otherwise).
      spawnEnv = pendingSpawnEnv instanceof Promise ? await pendingSpawnEnv : pendingSpawnEnv;
      const env = spawnEnv;
      child = spawnWithDelegationEnv(env, () =>
        spawn(this.bin, bound?.args ?? args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: env.env,
          ...(bound ? { cwd: bound.cwd } : {}),
        })
      );
    } catch (error) {
      bound?.dispose();
      throw error;
    }
    if (bound) {
      child.once('close', () => bound.dispose());
      child.once('error', () => bound.dispose());
    }
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });

    const closePromise = new Promise<number>((resolve, reject) => {
      child.once('error', (error) => {
        requestNotSent = usageEvents.length === 0;
        reject(error);
      });
      child.once('close', (code) => resolve(code ?? 1));
    });
    const boundedClose = withWallClockBudget(
      {
        provider: 'claude',
        budgetMs: this.timeoutMs,
        child: delegationChildHandleFromChildProcess(child),
        signal: options?.signal,
      },
      () => closePromise
    );
    // The stream reader below observes the same process shutdown. Attaching a
    // handler immediately prevents an early timeout from becoming an
    // unhandled rejection before the stdout iterator reaches its end.
    void boundedClose.catch(() => undefined);

    const onAbort = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    let emittedPartialText = false;
    let yielded = false;
    try {
      child.stdin.write(prompt);
      child.stdin.end();
      let streamErrorResult = '';
      const lines = readline.createInterface({ input: child.stdout });
      try {
        for await (const line of lines) {
          if (options?.signal?.aborted) throw new Error('reasoning stream aborted');
          const parsed = parseSafeJsonInput(String(line), 'Claude CLI stream response');
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const record = parsed as Record<string, unknown>;
          if (record.type === 'result' && record.is_error === true) {
            streamErrorResult =
              typeof record.result === 'string'
                ? record.result.slice(0, 500)
                : String(record.subtype ?? '');
          }
          if (record.type === 'result' || record.type === 'assistant') {
            const message =
              record.message && typeof record.message === 'object'
                ? (record.message as Record<string, unknown>)
                : undefined;
            // Keep only provider metadata; do not retain model-authored text
            // as evidence or count partial text events as separate requests.
            usageEvents.push(
              JSON.stringify({
                type: record.type,
                usage: record.usage,
                modelUsage: record.modelUsage,
                total_cost_usd: record.total_cost_usd,
                is_error: record.is_error,
                ...(message
                  ? { message: { id: message.id, model: message.model, usage: message.usage } }
                  : {}),
              })
            );
          }
          const event = record.event;
          if (record.type === 'stream_event' && event && typeof event === 'object') {
            const eventRecord = event as Record<string, unknown>;
            const delta = eventRecord.delta;
            if (eventRecord.type === 'content_block_delta' && delta && typeof delta === 'object') {
              const deltaRecord = delta as Record<string, unknown>;
              if (deltaRecord.type === 'text_delta' && typeof deltaRecord.text === 'string') {
                emittedPartialText = true;
                yielded = true;
                completionChars += deltaRecord.text.length;
                yield deltaRecord.text;
              }
            }
            continue;
          }

          // Older/newer CLI variants may omit partial events. Preserve the
          // provider stream contract by yielding the final text exactly once.
          if (!emittedPartialText && record.type === 'assistant') {
            const message = record.message;
            const content =
              message && typeof message === 'object'
                ? (message as Record<string, unknown>).content
                : undefined;
            if (Array.isArray(content)) {
              const text = content
                .filter((block): block is Record<string, unknown> =>
                  Boolean(block && typeof block === 'object' && !Array.isArray(block))
                )
                .map((block) => (typeof block.text === 'string' ? block.text : ''))
                .join('');
              if (text) {
                yielded = true;
                completionChars += text.length;
                yield text;
              }
            }
          }
          if (
            !emittedPartialText &&
            record.type === 'result' &&
            typeof record.result === 'string'
          ) {
            yielded = true;
            completionChars += record.result.length;
            yield record.result;
          }
        }
      } finally {
        lines.close();
      }

      const exitCode = await boundedClose;
      if (exitCode !== 0) {
        throw new Error(
          `[shell-claude-cli] streaming CLI exited with code ${exitCode}${stderr ? `. stderr: ${stderr}` : ''}${
            streamErrorResult ? `. result: ${streamErrorResult}` : ''
          }`
        );
      }
      if (!yielded) throw new Error('[shell-claude-cli] streaming CLI returned no text');
      meteringStatus = 'success';
    } catch (error) {
      // Redact (stderr may echo the bound credential) before the launch is disposed.
      throw redactProviderOutputError(error, launchSecrets);
    } finally {
      recordCliUsage('claude-cli', model, started, meteringStatus, {
        report:
          cliOutputFormat(args) === 'stream-json'
            ? parseClaudeCliUsage(usageEvents.join('\n'))
            : undefined,
        promptChars: prompt.length,
        completionChars,
        requestNotSent,
      });
      options?.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      spawnEnv.dispose();
      bound?.dispose();
    }
  }

  /**
   * XP-02 follow-up: resolve a KD-05 capability profile to claude CLI argv
   * fragments. No profile ⇒ `[]` (argv unchanged from pre-XP-02 behavior).
   * A typed refusal (see the profile × provider matrix in
   * provider-permission-profiles.ts) throws before any spawn is attempted.
   */
  private resolvePermissionArgs(profile?: ProviderPermissionProfileName): string[] {
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('claude', profile);
    if (!effectiveProfile) return [];
    const resolution = resolveProviderPermissionArgs(effectiveProfile, 'claude');
    if (resolution.kind === 'refused') {
      throw new Error(
        `[shell-claude-cli] permission profile "${effectiveProfile}" refused: ${resolution.reason}`
      );
    }
    return [...resolution.args];
  }

  /**
   * CN-02: delegate through the shared native CLI session instead of one
   * `claude -p` process per task. Kept separate from `delegateTask` so the
   * historical spawn path stays byte-compatible for callers that predate
   * this option; `HarnessSubagentDispatcher` / the work-graph execution port
   * opt in through {@link getNativeSubagentAdopter}.
   *
   * Fails closed: if the session cannot prove that a provider-native
   * sub-agent actually ran, this raises `[SUBAGENT_UNAVAILABLE]` rather than
   * silently degrading to a spawn and reporting it as native.
   */
  private async dispatchNativeSubagent(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    assertOperatorNativeCredentialOwner(this.nativeCredentialOwner);
    assertReasoningEgressAllowed(this.name);
    const profile = resolveClaudeSubagentProfile(options);
    const model = options?.model ?? resolveClaudeModelForTier(options?.model_tier, this.model);

    const previous = this.harnessQueue;
    let release!: () => void;
    this.harnessQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      assertOperatorNativeCredentialOwner(this.nativeCredentialOwner);
      const session = this.getHarnessSession(profile, model, options?.effort);
      if (!session.askNativeSubagent) {
        throw new Error(
          '[SUBAGENT_UNAVAILABLE] claude CLI session has no native subagent operation.'
        );
      }
      if (!this.harnessBoot) {
        this.harnessBoot = session.boot().catch((err) => {
          this.harnessBoot = undefined;
          throw err;
        });
      }
      await this.harnessBoot;
      assertOperatorNativeCredentialOwner(this.nativeCredentialOwner);
      const response = await session.askNativeSubagent(
        buildClaudeNativeDelegationPrompt({
          profileName: profile,
          instruction,
          ...(context ? { context } : {}),
        }),
        {
          profile,
          subagent: true,
          effort: options?.effort ?? 'medium',
          ...(options?.signal ? { signal: options.signal } : {}),
        }
      );
      const nativeInfo = response.metadata?.nativeSubagent;
      if (!nativeInfo || typeof nativeInfo !== 'object') {
        throw new Error(
          '[SUBAGENT_UNAVAILABLE] claude CLI session returned no native subagent metadata.'
        );
      }
      this.lastHarnessSubagentInfo = redactProviderOutputValue({
        ...(nativeInfo as Record<string, unknown>),
      });
      return await withRedactedProviderOutput(async () => response.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('[SUBAGENT_UNAVAILABLE]')) throw redactProviderOutputError(error);
      throw redactProviderOutputError(
        new Error(`[SUBAGENT_UNAVAILABLE] claude CLI harness failed: ${message}`)
      );
    } finally {
      release();
    }
  }

  /**
   * Null until CN-02 is switched on (`KYBERION_CLAUDE_NATIVE_SUBAGENT=1`, an
   * explicit `nativeSubagent` option, or an injected harness session), so the
   * default delegation path stays the historical per-task spawn.
   */
  getNativeSubagentAdopter(): NativeSubagentAdopter | null {
    if (credentialExecutionIdentity().tenantSlug) return null;
    assertOperatorNativeCredentialOwner(this.nativeCredentialOwner);
    return this.nativeSubagentEnabled ? this.nativeSubagentAdopter : null;
  }

  requiresNativeSubagent(): boolean {
    return this.nativeSubagentEnabled;
  }

  /**
   * QM-06: drop the shared CLI session on a failover switch. An INJECTED
   * session belongs to its injector and is never shut down here — only the
   * backend's own bookkeeping is cleared.
   */
  async resetSession(): Promise<void> {
    assertCredentialOwner(this.nativeCredentialOwner);
    const session = this.harnessSession;
    this.harnessSession = undefined;
    this.harnessSignature = undefined;
    this.harnessBoot = undefined;
    this.lastHarnessSubagentInfo = null;
    if (!session || session === this.injectedHarnessSession) return;
    await session.shutdown?.().catch(() => undefined);
  }

  /**
   * One session per (profile, model, effort) signature: those are session
   * construction flags (`--agents`, `--permission-mode`, `--model`,
   * `--effort`), so a changed signature re-boots rather than silently
   * running the delegation under the previous tier's permissions.
   */
  private getHarnessSession(
    profile: ProviderPermissionProfileName,
    model: string,
    effort?: 'low' | 'medium' | 'high'
  ): ClaudeHarnessSession {
    if (this.injectedHarnessSession) {
      this.harnessSession = this.injectedHarnessSession;
      return this.harnessSession;
    }
    const signature = `${profile}|${model}|${effort ?? 'medium'}`;
    if (this.harnessSession && this.harnessSignature === signature) return this.harnessSession;
    if (this.harnessSession) {
      void this.harnessSession.shutdown?.().catch(() => undefined);
      this.harnessBoot = undefined;
    }
    this.harnessSession = new ClaudeCliSessionAdapter({
      bin: this.bin,
      model,
      profile,
      timeoutMs: this.timeoutMs,
      ...(effort ? { effort } : {}),
      ...(this.extraArgs.length > 0 ? { extraArgs: this.extraArgs } : {}),
    });
    this.harnessSignature = signature;
    return this.harnessSession;
  }

  /**
   * Run a document or media generation task in a separate Claude CLI agent
   * session. This is intended for higher-level orchestration paths that need
   * artifact generation without using the reasoning-only structured backend.
   */
  async runDocumentAgentTask(input: DocumentAgentTaskInput): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const prompt = [input.instruction.trim(), input.context ? `Context: ${input.context}` : '']
      .filter(Boolean)
      .join('\n\n');

    const args = [
      ...(resolveEffectiveProviderPermissionProfile('claude')
        ? this.resolvePermissionArgs()
        : ['--dangerously-skip-permissions']),
      '-p',
      prompt,
      ...(input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : []),
      ...this.callerExtraArgs(),
    ];

    return this.spawnCli(args, '', undefined, resolveEffectiveProviderPermissionProfile('claude'));
  }

  /**
   * Run a browser-interactive or computer-use task in a separate Claude CLI
   * agent session.
   */
  async runBrowserAgentTask(input: BrowserAgentTaskInput): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const prompt = [input.instruction.trim(), input.context ? `Context: ${input.context}` : '']
      .filter(Boolean)
      .join('\n\n');

    const args = [
      ...(resolveEffectiveProviderPermissionProfile('claude')
        ? this.resolvePermissionArgs()
        : ['--dangerously-skip-permissions']),
      '-p',
      prompt,
      ...(input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : []),
      ...this.callerExtraArgs(),
    ];

    return this.spawnCli(args, '', undefined, resolveEffectiveProviderPermissionProfile('claude'));
  }

  async runStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
  }): Promise<T> {
    // Output exit: parse the raw envelope first, then redact the parsed value
    // (masking raw JSON could break parsing on an unquoted secret).
    return withRedactedProviderOutput(() => this.runStructuredUnredacted(params));
  }

  private async runStructuredUnredacted<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
  }): Promise<T> {
    assertReasoningEgressAllowed(this.name);
    const jsonSchema = z.toJSONSchema(params.schema) as Record<string, unknown>;
    if ('$schema' in jsonSchema) delete jsonSchema['$schema'];

    const args = [
      '-p',
      '--output-format',
      'json',
      '--system-prompt',
      params.systemPrompt,
      '--json-schema',
      JSON.stringify(jsonSchema),
      '--model',
      this.model,
      ...this.callerExtraArgs(),
    ];

    const stdout = await this.spawnCliRaw(args, params.userPrompt);
    let cliResult: any;
    try {
      cliResult = parseSafeJsonInput(stdout, 'Claude CLI response');
    } catch (err: any) {
      throw new Error(
        `[shell-claude-cli] failed to parse CLI JSON output: ${err?.message ?? err}. Raw: ${stdout.slice(0, 500)}`
      );
    }
    if (cliResult.is_error) {
      throw new Error(
        `[shell-claude-cli] CLI reported error: ${cliResult.result ?? JSON.stringify(cliResult)}`
      );
    }
    const structured = cliResult.structured_output;
    if (structured === undefined) {
      throw new Error(
        `[shell-claude-cli] CLI did not emit structured_output. Result: ${cliResult.result}`
      );
    }
    const parsed = params.schema.safeParse(structured);
    if (!parsed.success) {
      throw new Error(
        `[shell-claude-cli] schema validation failed: ${parsed.error.message}. Structured: ${JSON.stringify(structured).slice(0, 500)}`
      );
    }
    return parsed.data;
  }

  /**
   * XP-06: the child is spawned asynchronously (real `ChildProcess`, not
   * `spawnSync`), so its wall-clock budget is enforced by
   * {@link withWallClockBudget} against a real, killable handle — on expiry
   * this backend's CLI process is actually SIGTERM'd then (after the grace
   * window) SIGKILL'd, not just abandoned.
   */
  private async spawnCli(
    args: string[],
    stdin: string,
    signal?: AbortSignal,
    profile?: ProviderPermissionProfileName
  ): Promise<string> {
    // Output exit: the answer and any stderr-bearing error are redacted.
    return withRedactedProviderOutput(() => this.spawnCliRaw(args, stdin, signal, profile));
  }

  private async spawnCliRaw(
    args: string[],
    stdin: string,
    signal?: AbortSignal,
    profile?: ProviderPermissionProfileName
  ): Promise<string> {
    if (signal?.aborted) throw new Error('[shell-claude-cli] query aborted before spawn');
    const started = Date.now();
    const format = cliOutputFormat(args);
    // Request a machine stream for text calls too, then unwrap only the final
    // result record. Arbitrary model-authored JSON is never billing evidence.
    // stream-json (not json) so the call can tell a frozen CLI from a long turn.
    const supervised = !format;
    const cliArgs = supervised ? [...args, '--output-format', 'stream-json', '--verbose'] : args;
    const nativeJson = !format || format === 'json' || format === 'stream-json';
    const model = cliOptionValue(args, '--model') || this.model;
    const selectedPrompt = cliOptionValue(args, '-p');
    const inlinePrompt = selectedPrompt && !selectedPrompt.startsWith('-') ? selectedPrompt : '';
    const promptChars =
      stdin.length + inlinePrompt.length + (cliOptionValue(args, '--system-prompt')?.length ?? 0);
    let stdout = '';
    let completionChars = 0;
    let status: 'success' | 'error' = 'error';
    let requestNotSent = true;
    let bound: ReturnType<typeof prepareClaudeBoundLaunch> = null;
    try {
      // XP-02: minimal allowlisted env (no cross-provider credential
      // leakage); SA-05: one delegation hop deeper than us; WS-02: private git
      // index for implementer delegations.
      // §4: a bound launch gets the isolated argv and a tenant scratch cwd,
      // or fails closed here — before any env is built or child is spawned.
      bound = prepareClaudeBoundLaunch(cliArgs);
      const pendingSpawnEnv = buildDelegationSpawnEnvWithRelay({
        provider: 'claude',
        sessionId: newDelegationSessionId('claude'),
        ...(profile ? { profile } : {}),
      });
      // Await only when a credential relay had to start (no extra tick otherwise).
      const spawnEnv = pendingSpawnEnv instanceof Promise ? await pendingSpawnEnv : pendingSpawnEnv;
      const child = spawnWithDelegationEnv(spawnEnv, () =>
        spawn(this.bin, bound?.args ?? cliArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv.env,
          ...(bound ? { cwd: bound.cwd } : {}),
        })
      );
      requestNotSent = false;
      // An enclosing supervised delegation still hears this call's progress.
      const outerProgress = captureDelegationProgressReporter();
      const startupTimeoutMs = this.startupTimeoutMs;
      const startup = supervised ? new AbortController() : undefined;
      const stopSignal =
        startup && signal ? AbortSignal.any([startup.signal, signal]) : (startup?.signal ?? signal);
      let startupStalled = false;
      let stderr = '';
      const startupTimer = startup
        ? setTimeout(() => {
            if (stopSignal?.aborted) return;
            startupStalled = true;
            startup.abort();
          }, startupTimeoutMs)
        : undefined;
      startupTimer?.unref?.();

      const raw = await withWallClockBudget(
        {
          provider: 'claude',
          budgetMs: this.timeoutMs,
          child: delegationChildHandleFromChildProcess(child),
          signal: stopSignal,
          ...(supervised ? { inactivity: { timeoutMs: this.inactivityMs } } : {}),
        },
        () =>
          new Promise<string>((resolve, reject) => {
            let spawned = false;
            const progress = captureDelegationProgressReporter();
            let pending = '';
            child.once('spawn', () => {
              spawned = true;
            });
            child.stdout.on('data', (chunk) => {
              const text = chunk.toString();
              stdout += text;
              if (!supervised) return;
              pending += text;
              const lines = pending.split('\n');
              pending = lines.pop() ?? '';
              for (const line of lines) {
                const type = claudeStreamRecordType(line);
                if (!type) continue;
                if (startupTimer) clearTimeout(startupTimer);
                const event = claudeStreamProgressEventForType(type);
                if (event) {
                  progress(event);
                  outerProgress(event);
                }
              }
            });
            child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
            child.on('close', (code) => {
              if (code !== 0) {
                // The JSON envelope carries the real cause (auth expiry, usage
                // limit, overload) on stdout; an empty stderr alone classified
                // every such failure as `unknown` and hid it from operators.
                const envelope = describeClaudeCliErrorEnvelope(stdout);
                reject(
                  new Error(
                    `[shell-claude-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}${
                      envelope ? `. result: ${envelope}` : ''
                    }`
                  )
                );
                return;
              }
              resolve(stdout);
            });
            child.on('error', (err) => {
              if (!spawned && !stdout) requestNotSent = true;
              reject(new Error(`[shell-claude-cli] spawn failed: ${err.message}`));
            });
            child.stdin.write(stdin);
            child.stdin.end();
          })
      )
        .catch((err) => {
          if (startupStalled) {
            spawnEnv.dispose();
            throw new Error(
              `[shell-claude-cli] timed out: startup stalled, no CLI stream record within ${startupTimeoutMs}ms. stderr: ${stderr.slice(0, 300)}`,
              { cause: err }
            );
          }
          if (err instanceof DelegationWallClockExceededError) {
            spawnEnv.dispose();
            throw new Error(`[shell-claude-cli] timed out after ${this.timeoutMs}ms`);
          }
          if (err instanceof DelegationInactivityExceededError) {
            spawnEnv.dispose();
            throw new Error(
              `[shell-claude-cli] timed out: no assistant or tool progress for ${this.inactivityMs}ms`
            );
          }
          throw err;
        })
        .finally(() => {
          if (startupTimer) clearTimeout(startupTimer);
        });
      const text = supervised ? extractClaudeStreamResult(raw) : raw;
      completionChars = text.length;
      status = 'success';
      return text;
    } finally {
      bound?.dispose();
      recordCliUsage('claude-cli', model, started, status, {
        ...(nativeJson ? { report: parseClaudeCliUsage(stdout) } : {}),
        promptChars,
        completionChars,
        requestNotSent,
      });
    }
  }
}

/** 90 s: the CLI prints its `system/init` record within seconds; silence means it hung at launch. */
export const CLAUDE_CLI_DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
/** 5 min without an assistant message or tool event = a frozen turn (matches agent-dispatch). */
export const CLAUDE_CLI_DEFAULT_INACTIVITY_MS = 300_000;

/** Map one stream-json record to semantic progress; init/system records are not progress. */
export function claudeStreamProgressEvent(
  line: string
): 'assistant_message' | 'tool_completed' | undefined {
  return claudeStreamProgressEventForType(claudeStreamRecordType(line));
}

function claudeStreamRecordType(line: string): string | undefined {
  if (!line.trimStart().startsWith('{')) return undefined;
  let record: unknown;
  try {
    record = parseSafeJsonInput(line, 'Claude CLI stream record');
  } catch {
    return undefined;
  }
  if (!record || typeof record !== 'object') return undefined;
  const type = (record as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

function claudeStreamProgressEventForType(
  type: string | undefined
): 'assistant_message' | 'tool_completed' | undefined {
  if (type === 'assistant') return 'assistant_message';
  if (type === 'user') return 'tool_completed';
  return undefined;
}

/**
 * The text of the final `result` record of a stream-json run. A single json
 * envelope and plain text (old CLIs) stay usable unchanged.
 */
export function extractClaudeStreamResult(stdout: string): string {
  const lines = stdout.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = parseSafeJsonInput(line, 'Claude CLI stream result') as Record<
        string,
        unknown
      >;
      if (parsed && parsed.type === 'result' && typeof parsed.result === 'string')
        return parsed.result;
    } catch {
      // Not a JSON record; keep scanning toward the start.
    }
  }
  try {
    const parsed = parseSafeJsonInput(stdout, 'Claude CLI text envelope') as Record<
      string,
      unknown
    >;
    if (parsed && parsed.type === 'result' && typeof parsed.result === 'string')
      return parsed.result;
  } catch {
    // Old CLI text output remains usable, but carries no provider usage.
  }
  return stdout;
}

/**
 * Extract the error text from a `--output-format json` envelope written to
 * stdout by a CLI run that exited non-zero. Returns '' when stdout is not an
 * error envelope, so callers never surface model-authored success text.
 */
export function describeClaudeCliErrorEnvelope(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  // stream-json / verbose runs emit several lines; the result record is last.
  const lastLine = trimmed.split('\n').pop() ?? '';
  for (const candidate of [trimmed, lastLine]) {
    try {
      const parsed = parseSafeJsonInput(candidate, 'Claude CLI error envelope') as Record<
        string,
        unknown
      >;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (parsed.is_error !== true && !String(parsed.subtype ?? '').startsWith('error')) continue;
      const detail =
        typeof parsed.result === 'string' && parsed.result
          ? parsed.result
          : typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.subtype === 'string'
              ? parsed.subtype
              : '';
      return detail.slice(0, 500);
    } catch {
      // not JSON — fall through
    }
  }
  return '';
}

/**
 * KD-05 tier for a delegation, degrade-not-fail (mirrors the dispatcher's
 * own rule: `profile` > `role` > default; unknown names degrade).
 */
function resolveClaudeSubagentProfile(
  options?: ReasoningCallOptions
): ProviderPermissionProfileName {
  const requested = options?.profile || options?.role || 'implementer';
  try {
    const profile = getSubagentCapabilityProfile(requested).name as ProviderPermissionProfileName;
    return resolveEffectiveProviderPermissionProfile('claude', profile) ?? profile;
  } catch {
    return resolveEffectiveProviderPermissionProfile('claude', 'implementer') ?? 'implementer';
  }
}

// SYNC, NOT WALL-CLOCK-BUDGETED (XP-06): this is a one-shot local readiness
// probe, not a delegation's unit of work — it never goes through `spawnCli`/
// `withWallClockBudget`. It must not issue a paid model request during startup;
// version and auth-status checks are sufficient to admit Claude to the
// failover chain. `spawnSync` blocks this thread until each bounded probe
// returns (or its own timeout fires).
/**
 * LC-03: the repo dependency `@anthropic-ai/claude-code` ships a postinstall
 * placeholder — until `pnpm approve-builds` runs, `node_modules/.bin/claude`
 * is a shim that prints this message to stderr and exits non-zero. Under
 * pnpm, `node_modules/.bin` shadows the operator's real `claude` on PATH,
 * so a matching failure means "shadowed", not "not installed".
 */
export function probeShellClaudeCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number } = {}
): ShellClaudeCliAvailability {
  const explicitBin = options.bin?.trim() || envText(env, 'KYBERION_CLAUDE_CLI_BIN')?.trim();
  const bin = explicitBin || resolveProviderCliCommand('claude');
  const timeoutMs = options.timeoutMs ?? 5_000;

  const primary = probeClaudeBinOnce(bin, env, timeoutMs);
  if (primary.available) {
    return { ...primary, bin };
  }

  // LC-03 fallback: only when no binary was explicitly requested and the
  // default `claude` is the pnpm placeholder or absent from PATH — never
  // second-guess an operator-pinned KYBERION_CLAUDE_CLI_BIN.
  if (!explicitBin && isClaudeCliFallbackEligible(primary.reason)) {
    for (const candidate of resolveClaudeCliFallbackCandidates({
      env: { ...process.env, ...env },
    })) {
      const fallback = probeClaudeBinOnce(candidate, env, timeoutMs);
      if (fallback.available) {
        logger.info(
          `[shell-claude-cli] '${bin}' is the pnpm placeholder shim (run \`pnpm approve-builds\` to fix) — selected fallback binary ${candidate}`
        );
        return { available: true, bin: candidate };
      }
    }
  }

  return primary;
}

function probeClaudeBinOnce(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): ShellClaudeCliAvailability {
  try {
    const childEnv = buildProviderChildEnv({
      provider: 'claude',
      baseEnv: { ...process.env, ...env },
    });
    const versionResult = memoizedCliSpawnSync(bin, ['--version'], {
      // XP-02: minimal allowlisted env; overrides in `env` (e.g. a test's
      // KYBERION_CLAUDE_CLI_BIN, or the KYBERION_PROVIDER_ENV_ALLOWLIST=0
      // escape hatch) are applied before allowlisting so they still take
      // effect.
      env: childEnv,
      timeout: timeoutMs,
    });

    if (versionResult.error) {
      return { available: false, reason: versionResult.error.message };
    }
    if (versionResult.status !== 0) {
      const stderr = typeof versionResult.stderr === 'string' ? versionResult.stderr.trim() : '';
      const stdout = typeof versionResult.stdout === 'string' ? versionResult.stdout.trim() : '';
      return {
        available: false,
        reason: stderr || stdout || `exit code ${versionResult.status}`,
      };
    }

    const authResult = memoizedCliSpawnSync(bin, ['auth', 'status'], {
      env: childEnv,
      timeout: timeoutMs,
    });
    if (authResult.error) {
      return { available: false, reason: authResult.error.message };
    }
    const authOk = isClaudeCliAuthenticated({
      ok: authResult.status === 0,
      stdout: typeof authResult.stdout === 'string' ? authResult.stdout : '',
      stderr: typeof authResult.stderr === 'string' ? authResult.stderr : '',
    });
    if (!authOk) {
      const stderr = typeof authResult.stderr === 'string' ? authResult.stderr.trim() : '';
      const stdout = typeof authResult.stdout === 'string' ? authResult.stdout.trim() : '';
      return {
        available: false,
        reason: stderr || stdout || `auth status exit code ${authResult.status}`,
      };
    }
    return { available: true };
  } catch (err: any) {
    return { available: false, reason: err?.message ?? String(err) };
  }
}

export interface RunClaudeCliQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  options?: ShellClaudeCliBackendOptions;
}

export async function runClaudeCliQuery<T>({
  systemPrompt,
  userPrompt,
  schema,
  options = {},
}: RunClaudeCliQueryParams<T>): Promise<T> {
  const backend = new ShellClaudeCliBackend(options);
  return backend.runStructured({ systemPrompt, userPrompt, schema });
}

function positiveIntEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = envText(env, name)?.trim();
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function claudeCliSupervisionFromEnv(
  env: NodeJS.ProcessEnv
): Pick<ShellClaudeCliBackendOptions, 'startupTimeoutMs' | 'inactivityMs'> {
  const startupTimeoutMs = positiveIntEnv(env, 'KYBERION_CLAUDE_CLI_STARTUP_TIMEOUT_MS');
  const inactivityMs = positiveIntEnv(env, 'KYBERION_CLAUDE_CLI_INACTIVITY_MS');
  return {
    ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
    ...(inactivityMs ? { inactivityMs } : {}),
  };
}

export function buildClaudeCliOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ShellClaudeCliBackendOptions {
  const bin = envText(env, 'KYBERION_CLAUDE_CLI_BIN')?.trim();
  const model = envText(env, 'KYBERION_CLAUDE_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_CLAUDE_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = envText(env, 'KYBERION_CLAUDE_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...claudeCliSupervisionFromEnv(env),
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
    ...(envText(env, 'KYBERION_CLAUDE_NATIVE_SUBAGENT') === '1' ? { nativeSubagent: true } : {}),
  };
}

export function buildShellClaudeCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => ShellClaudeCliAvailability = probeShellClaudeCliAvailability,
  modelOverride?: string,
  timeoutOverrideMs?: number
): ShellClaudeCliBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[shell-claude-cli] backend unavailable (bin=${envText(env, 'KYBERION_CLAUDE_CLI_BIN')?.trim() || resolveProviderCliCommand('claude')}): ${availability.reason ?? 'failed health check'}. If the reason mentions "${CLAUDE_CLI_PLACEHOLDER_SIGNATURE}", run \`pnpm approve-builds\` (approve @anthropic-ai/claude-code) or set KYBERION_CLAUDE_CLI_BIN=$HOME/.local/bin/claude.`
    );
    return null;
  }

  // Prefer an explicit pin; otherwise honor the binary the probe actually
  // validated (LC-03: may be a fallback outside node_modules/.bin).
  const bin = envText(env, 'KYBERION_CLAUDE_CLI_BIN')?.trim() || availability.bin?.trim();
  const model = modelOverride?.trim() || envText(env, 'KYBERION_CLAUDE_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_CLAUDE_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutOverrideMs ?? (timeoutRaw ? parseInt(timeoutRaw, 10) : undefined);
  const extraRaw = envText(env, 'KYBERION_CLAUDE_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  const backend = new ShellClaudeCliBackend({
    ...claudeCliSupervisionFromEnv(env),
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
    ...(envText(env, 'KYBERION_CLAUDE_NATIVE_SUBAGENT') === '1' ? { nativeSubagent: true } : {}),
  });
  logger.debug(
    `[shell-claude-cli] backend ready (bin=${bin ?? 'claude'}, model=${model ?? resolveRuntimeModelId('anthropic-default')})`
  );
  return backend;
}
