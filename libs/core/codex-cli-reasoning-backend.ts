import { z } from 'zod';
import {
  buildCodexCliQueryOptionsFromEnv,
  runCodexCliQuery,
  type CodexCliQueryOptions,
} from './codex-cli-query.js';
import type {
  BranchForkInput,
  CritiqueInput,
  CritiqueResult,
  DecomposeIntoTasksInput,
  DecomposedTaskPlan,
  DivergeHypothesisInput,
  ExtractDesignSpecInput,
  ExtractRequirementsInput,
  ExtractTestPlanInput,
  ExtractedDesignSpec,
  ExtractedRequirements,
  ExtractedTestPlan,
  ForkedBranch,
  HypothesisSketch,
  PersonaSynthesisInput,
  ReasoningBackend,
  ReasoningCallOptions,
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
} from './reasoning-backend.js';
import {
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  structuredReasoningSpecs,
  type StructuredOpSpec,
} from './structured-reasoning.js';
import { assertReasoningEgressAllowed } from './reasoning-egress-scope.js';
import {
  CodexAppServerAdapter,
  type AgentAskOptions,
  type AgentResponse,
} from './agent-adapter.js';
import {
  getSubagentCapabilityProfile,
  type SubagentCapabilityProfile,
} from './subagent-capability-profiles.js';
import { resolveProviderPermissionArgs } from './provider-permission-profiles.js';
import type { NativeSubagentAdopter } from './native-subagent-adopter.js';

export interface CodexHarnessSession {
  boot(): Promise<void>;
  ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  askNativeSubagent?(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  getRuntimeInfo?(): Record<string, unknown>;
}

export interface CodexCliReasoningBackendOptions extends CodexCliQueryOptions {
  /** Test seam and runtime injection for the shared Codex app-server session. */
  harnessSession?: CodexHarnessSession;
}

export class CodexCliReasoningBackend implements ReasoningBackend {
  readonly name = 'codex-cli';
  private readonly options: CodexCliQueryOptions;
  private readonly injectedHarnessSession?: CodexHarnessSession;
  private harnessSession?: CodexHarnessSession;
  private harnessBoot?: Promise<void>;
  private harnessQueue: Promise<void> = Promise.resolve();
  private lastHarnessSubagentInfo: Record<string, unknown> | null = null;
  private readonly nativeSubagentAdopter: NativeSubagentAdopter;

  constructor(options: CodexCliReasoningBackendOptions = {}) {
    this.options = options;
    this.injectedHarnessSession = options.harnessSession;
    this.nativeSubagentAdopter = {
      id: 'codex-app-server',
      dispatch: (instruction, context, callOptions) =>
        this.dispatchNativeSubagent(instruction, context, callOptions),
      getInfo: () => (this.lastHarnessSubagentInfo ? { ...this.lastHarnessSubagentInfo } : null),
    };
  }

  /** Run a shared structured-reasoning op through the codex CLI (schema-validated). */
  private async runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    assertReasoningEgressAllowed(this.name);
    const result = await runCodexCliQuery({
      systemPrompt: STRUCTURED_REASONING_SYSTEM_PROMPT,
      userPrompt: spec.buildUserPrompt(input),
      schema: spec.schema,
      mode: 'workspace-write',
      options: this.options,
    });
    return spec.extract(result);
  }

  divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    return this.runStructured(structuredReasoningSpecs.divergePersonas, input);
  }

  crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    return this.runStructured(structuredReasoningSpecs.crossCritique, input);
  }

  synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    return this.runStructured(structuredReasoningSpecs.synthesizePersona, input);
  }

  forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    return this.runStructured(structuredReasoningSpecs.forkBranches, input);
  }

  simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    return this.runStructured(structuredReasoningSpecs.simulateBranches, input);
  }

  extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    return this.runStructured(structuredReasoningSpecs.extractRequirements, input);
  }

  extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    return this.runStructured(structuredReasoningSpecs.extractDesignSpec, input);
  }

  extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    return this.runStructured(structuredReasoningSpecs.extractTestPlan, input);
  }

  decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    return this.runStructured(structuredReasoningSpecs.decomposeIntoTasks, input);
  }

  async delegateTask(
    instruction: string,
    context?: string,
    options?: { signal?: AbortSignal }
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const schema = z.object({ answer: z.string() });
    const result = (await runCodexCliQuery({
      systemPrompt:
        'You are a focused autonomous sub-agent. Complete the task in the workspace if needed and return a concise report.',
      userPrompt: [context ? `Context: ${context}` : '', `Task: ${instruction}`]
        .filter(Boolean)
        .join('\n\n'),
      schema,
      mode: 'workspace-write',
      options: { ...this.options, ...(options?.signal ? { signal: options.signal } : {}) },
    })) as z.infer<typeof schema>;
    return result.answer;
  }

  /**
   * CT-05: use one shared Codex app-server process and its native multi-agent
   * turn mode instead of spawning `codex exec` for every delegated task.
   *
   * This method is intentionally separate from `delegateTask`: normal Codex
   * reasoning remains backward-compatible, while HarnessSubagentDispatcher
   * can opt into the provider-native execution surface explicitly.
   */
  private async dispatchNativeSubagent(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const profile = resolveProfile(options);
    const permission = resolveProviderPermissionArgs(profile.name, 'codex');
    if (permission.kind === 'refused') {
      throw new Error(`[SUBAGENT_UNAVAILABLE] ${permission.reason}`);
    }

    const previous = this.harnessQueue;
    let release!: () => void;
    this.harnessQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const session = this.getHarnessSession(permission.args);
      if (!this.harnessBoot) this.harnessBoot = session.boot();
      await this.harnessBoot;
      const ask = session.askNativeSubagent?.bind(session) || session.ask.bind(session);
      const response = await ask(
        [
          profile.systemPromptPrefix,
          '<kyberion-delegated-task>',
          context ? `Context:\n${context}` : '',
          `Task: ${instruction}`,
          'Use Codex native subagents when useful for this bounded task and return the requested task_result contract.',
          '</kyberion-delegated-task>',
        ]
          .filter(Boolean)
          .join('\n\n'),
        {
          profile: profile.name,
          subagent: true,
          signal: options?.signal,
          approvalMode: profile.name === 'implementer' ? 'relaxed' : 'strict',
          sandboxPolicy: sandboxPolicyForArgs(permission.args),
        }
      );
      const nativeInfo = response.metadata?.nativeSubagent;
      const runtimeInfo = session.getRuntimeInfo?.();
      const runtimeNativeInfo = runtimeInfo?.lastNativeSubagent;
      this.lastHarnessSubagentInfo =
        nativeInfo && typeof nativeInfo === 'object'
          ? { ...(nativeInfo as Record<string, unknown>) }
          : runtimeNativeInfo && typeof runtimeNativeInfo === 'object'
            ? { ...(runtimeNativeInfo as Record<string, unknown>) }
            : null;
      return response.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('[SUBAGENT_UNAVAILABLE]')) throw error;
      throw new Error(`[SUBAGENT_UNAVAILABLE] Codex app-server harness failed: ${message}`);
    } finally {
      release();
    }
  }

  getNativeSubagentAdopter(): NativeSubagentAdopter {
    return this.nativeSubagentAdopter;
  }

  requiresNativeSubagent(): boolean {
    return true;
  }

  private getHarnessSession(permissionArgs: readonly string[]): CodexHarnessSession {
    if (this.harnessSession) return this.harnessSession;
    if (this.injectedHarnessSession) {
      this.harnessSession = this.injectedHarnessSession;
      return this.harnessSession;
    }
    this.harnessSession = new CodexAppServerAdapter({
      model: this.options.model,
      cwd: this.options.cwd,
      timeoutMs: this.options.timeoutMs,
      sandboxMode: sandboxModeFromArgs(permissionArgs),
      systemPrompt: 'Kyberion governed Codex app-server subagent session.',
      approvalMode: 'strict',
    });
    return this.harnessSession;
  }

  async prompt(prompt: string): Promise<string> {
    return this.delegateTask(prompt);
  }
}

function resolveProfile(options?: { role?: string; profile?: string }): SubagentCapabilityProfile {
  const requested = options?.profile || options?.role || 'implementer';
  try {
    return getSubagentCapabilityProfile(requested);
  } catch {
    return getSubagentCapabilityProfile('implementer');
  }
}

function sandboxModeFromArgs(
  args: readonly string[]
): 'workspace-write' | 'read-only' | 'danger-full-access' {
  const sandboxIndex = args.indexOf('--sandbox');
  const mode = sandboxIndex >= 0 ? args[sandboxIndex + 1] : undefined;
  if (mode === 'read-only' || mode === 'danger-full-access' || mode === 'workspace-write') {
    return mode;
  }
  throw new Error(`[SUBAGENT_UNAVAILABLE] Codex sandbox projection is invalid: ${args.join(' ')}`);
}

function sandboxPolicyForArgs(args: readonly string[]): Record<string, unknown> {
  const mode = sandboxModeFromArgs(args);
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  return {
    type: 'workspaceWrite',
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function buildCodexCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CodexCliReasoningBackend {
  return new CodexCliReasoningBackend(buildCodexCliQueryOptionsFromEnv(env));
}
