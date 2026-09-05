/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * Shell Grok CLI Backend — spawns the local `grok` (Grok Build) CLI in
 * `-p --output-format json` mode for structured-output reasoning tasks.
 *
 * Designed for environments that already have Grok Build installed and
 * authenticated (`grok login` / OAuth). Each reasoning method becomes one
 * `grok -p` invocation with:
 *   --system-prompt-override <...>
 *   --json-schema <...>
 *   --output-format json
 *   --model <...>
 *
 * Structured results are read from the CLI JSON envelope's `structuredOutput`
 * field (camelCase; falls back to parsing `text` when absent).
 */

import { spawn, spawnSync } from 'node:child_process';
import { childDelegationEnv } from './operation-policy-gate.js';
import {
  buildProviderChildEnv,
  resolveEffectiveProviderPermissionProfile,
  resolveProviderPermissionArgs,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import { assertReasoningEgressAllowed } from './reasoning-egress-scope.js';
import {
  delegationChildHandleFromChildProcess,
  withWallClockBudget,
  DelegationWallClockExceededError,
} from './delegation-concurrency.js';
import { z, type ZodType } from 'zod';
import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { GrokAdapter, type AgentAskOptions, type AgentResponse } from './agent-adapter.js';
import type { NativeSubagentAdopter } from './native-subagent-adopter.js';
import type { ReasoningCallOptions } from './reasoning-backend.js';
import { getSubagentCapabilityProfile } from './subagent-capability-profiles.js';
import {
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  structuredReasoningSpecs,
  type StructuredOpSpec,
} from './structured-reasoning.js';
import type {
  ReasoningBackend,
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
} from './reasoning-backend.js';

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

const DEFAULT_MODEL = 'grok-4.6';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveGrokModelForTier(
  tier: 'fast' | 'standard' | 'deep' | undefined,
  defaultModel: string
): string {
  // Grok Build currently exposes a single primary model family; keep the
  // tier hook for parity with other CLI backends and future multi-model IDs.
  if (tier === 'fast' || tier === 'standard' || tier === 'deep') {
    return defaultModel || DEFAULT_MODEL;
  }
  return defaultModel || DEFAULT_MODEL;
}

export interface ShellGrokCliBackendOptions {
  /** CLI binary. Defaults to `grok` (resolved via PATH). */
  bin?: string;
  /** Model ID. Defaults to `grok-4.6`. */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Additional CLI args (e.g. --reasoning-effort high). */
  extraArgs?: string[];
  /** Test seam and runtime injection for the shared Grok ACP session. */
  harnessSession?: GrokHarnessSession;
}

export interface GrokHarnessSession {
  boot(): Promise<void>;
  ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  askNativeSubagent?(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  getRuntimeInfo?(): Record<string, unknown>;
  /**
   * Optional shutdown contract. Executed by resetSession() for backend-owned
   * sessions so the ACP process is torn down on failover. Injected harness
   * sessions are owned by the caller.
   */
  shutdown?(): Promise<void>;
}

export interface ShellGrokCliAvailability {
  available: boolean;
  reason?: string;
}

export class ShellGrokCliBackend implements ReasoningBackend {
  readonly name = 'shell-grok-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly injectedHarnessSession?: GrokHarnessSession;
  private harnessSession?: GrokHarnessSession;
  private harnessBoot?: Promise<void>;
  private harnessQueue: Promise<void> = Promise.resolve();
  private lastHarnessSubagentInfo: Record<string, unknown> | null = null;
  private readonly nativeSubagentAdopter: NativeSubagentAdopter;

  constructor(options: ShellGrokCliBackendOptions = {}) {
    this.bin = options.bin ?? 'grok';
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = options.extraArgs ?? [];
    this.injectedHarnessSession = options.harnessSession;
    this.nativeSubagentAdopter = {
      id: 'grok-acp',
      dispatch: (instruction, context, callOptions) =>
        this.dispatchNativeSubagent(instruction, context, callOptions),
      getInfo: () => (this.lastHarnessSubagentInfo ? { ...this.lastHarnessSubagentInfo } : null),
    };
  }

  private async runStructuredOp<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    return this.runStructured({
      systemPrompt: STRUCTURED_REASONING_SYSTEM_PROMPT,
      userPrompt: spec.buildUserPrompt(input),
      schema: spec.schema,
    }).then((result) => spec.extract(result));
  }

  divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    return this.runStructuredOp(structuredReasoningSpecs.divergePersonas, input);
  }

  crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    return this.runStructuredOp(structuredReasoningSpecs.crossCritique, input);
  }

  synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    return this.runStructuredOp(structuredReasoningSpecs.synthesizePersona, input);
  }

  forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    return this.runStructuredOp(structuredReasoningSpecs.forkBranches, input);
  }

  simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    return this.runStructuredOp(structuredReasoningSpecs.simulateBranches, input);
  }

  extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    return this.runStructuredOp(structuredReasoningSpecs.extractRequirements, input);
  }

  extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    return this.runStructuredOp(structuredReasoningSpecs.extractDesignSpec, input);
  }

  extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    return this.runStructuredOp(structuredReasoningSpecs.extractTestPlan, input);
  }

  decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    return this.runStructuredOp(structuredReasoningSpecs.decomposeIntoTasks, input);
  }

  async delegateTask(
    instruction: string,
    context?: string,
    options?: {
      model_tier?: 'fast' | 'standard' | 'deep';
      profile?: ProviderPermissionProfileName;
      advisory?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const model = resolveGrokModelForTier(options?.model_tier, this.model);
    const requestedProfile = options?.advisory ? 'planner' : options?.profile;
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('grok', requestedProfile);
    const permissionArgs = this.resolvePermissionArgs(effectiveProfile);
    // Historical default for unprofiled headless calls: auto-approve tools.
    // When a KD-05 profile is set, its permission projection owns the mode.
    const defaultPermissionArgs = effectiveProfile ? [] : ['--always-approve'];
    const prompt = [instruction.trim(), context ? `Context: ${context}` : '']
      .filter(Boolean)
      .join('\n\n');
    const args = [
      '-p',
      prompt,
      '--output-format',
      'plain',
      '--model',
      model,
      ...defaultPermissionArgs,
      '--disable-web-search',
      '--no-subagents',
      ...permissionArgs,
      ...this.extraArgs,
    ];
    return this.spawnCli(args, '', options?.signal);
  }

  private async dispatchNativeSubagent(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const profile = resolveGrokSubagentProfile(options);
    const previous = this.harnessQueue;
    let release!: () => void;
    this.harnessQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const session = this.getHarnessSession();
      if (!session.askNativeSubagent) {
        throw new Error(
          '[SUBAGENT_UNAVAILABLE] Grok ACP session has no native subagent operation.'
        );
      }
      if (!this.harnessBoot) {
        this.harnessBoot = session.boot().catch((err) => {
          this.harnessBoot = undefined;
          throw err;
        });
      }
      await this.harnessBoot;
      const response = await session.askNativeSubagent(
        [profile.systemPromptPrefix, context ? `Context:\n${context}` : '', `Task: ${instruction}`]
          .filter(Boolean)
          .join('\n\n'),
        {
          profile: profile.name,
          subagent: true,
          effort: options?.effort ?? 'medium',
          signal: options?.signal,
        }
      );
      if (response.stopReason === 'error') {
        throw new Error('[SUBAGENT_UNAVAILABLE] Grok ACP returned an error response.');
      }
      const nativeInfo = response.metadata?.nativeSubagent;
      if (!nativeInfo || typeof nativeInfo !== 'object') {
        throw new Error('[SUBAGENT_UNAVAILABLE] Grok ACP returned no native subagent metadata.');
      }
      this.lastHarnessSubagentInfo = { ...(nativeInfo as Record<string, unknown>) };
      return response.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('[SUBAGENT_UNAVAILABLE]')) throw error;
      throw new Error(`[SUBAGENT_UNAVAILABLE] Grok ACP harness failed: ${message}`);
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

  /**
   * QM-06: drop the active Grok ACP session on a failover switch.
   * An injected harness belongs to its caller and is never shut down here.
   */
  async resetSession(): Promise<void> {
    const session = this.harnessSession;
    this.harnessSession = undefined;
    this.harnessBoot = undefined;
    this.lastHarnessSubagentInfo = null;
    if (!session || session === this.injectedHarnessSession) return;
    await session.shutdown?.().catch(() => undefined);
  }

  private getHarnessSession(): GrokHarnessSession {
    if (this.harnessSession) return this.harnessSession;
    if (this.injectedHarnessSession) {
      this.harnessSession = this.injectedHarnessSession;
      return this.harnessSession;
    }
    this.harnessSession = new GrokAdapter({ bin: this.bin, model: this.model });
    return this.harnessSession;
  }

  async prompt(
    prompt: string,
    options?: {
      model_tier?: 'fast' | 'standard' | 'deep';
      profile?: ProviderPermissionProfileName;
    }
  ): Promise<string> {
    return this.delegateTask(prompt, undefined, options);
  }

  private resolvePermissionArgs(profile?: ProviderPermissionProfileName): string[] {
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('grok', profile);
    if (!effectiveProfile) return [];
    const resolution = resolveProviderPermissionArgs(effectiveProfile, 'grok');
    if (resolution.kind === 'refused') {
      throw new Error(
        `[shell-grok-cli] permission profile "${effectiveProfile}" refused: ${resolution.reason}`
      );
    }
    return [...resolution.args];
  }

  async runStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
  }): Promise<T> {
    assertReasoningEgressAllowed(this.name);
    const jsonSchema = z.toJSONSchema(params.schema) as Record<string, unknown>;
    if ('$schema' in jsonSchema) delete jsonSchema['$schema'];
    const activeProfile = resolveEffectiveProviderPermissionProfile('grok');
    const defaultPermissionArgs = activeProfile ? [] : ['--always-approve'];

    const args = [
      '-p',
      params.userPrompt,
      '--output-format',
      'json',
      '--system-prompt-override',
      params.systemPrompt,
      '--json-schema',
      JSON.stringify(jsonSchema),
      '--model',
      this.model,
      ...defaultPermissionArgs,
      '--disable-web-search',
      '--no-subagents',
      ...this.resolvePermissionArgs(),
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args, '');
    let cliResult: any;
    try {
      cliResult = parseSafeJsonInput(stdout, 'Grok CLI response');
    } catch (err: any) {
      throw new Error(
        `[shell-grok-cli] failed to parse CLI JSON output: ${err?.message ?? err}. Raw: ${stdout.slice(0, 500)}`
      );
    }

    const structured =
      cliResult.structuredOutput !== undefined
        ? cliResult.structuredOutput
        : cliResult.structured_output !== undefined
          ? cliResult.structured_output
          : parseStructuredFromText(cliResult.text);

    if (structured === undefined) {
      throw new Error(
        `[shell-grok-cli] CLI did not emit structuredOutput. Result: ${cliResult.text ?? JSON.stringify(cliResult).slice(0, 500)}`
      );
    }

    const parsed = params.schema.safeParse(structured);
    if (!parsed.success) {
      throw new Error(
        `[shell-grok-cli] schema validation failed: ${parsed.error.message}. Structured: ${JSON.stringify(structured).slice(0, 500)}`
      );
    }
    return parsed.data;
  }

  private spawnCli(args: string[], stdin: string, signal?: AbortSignal): Promise<string> {
    const child = spawn(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildProviderChildEnv({ provider: 'grok' }), ...childDelegationEnv() },
    });

    return withWallClockBudget(
      {
        provider: 'grok',
        budgetMs: this.timeoutMs,
        child: delegationChildHandleFromChildProcess(child),
        signal,
      },
      () =>
        new Promise<string>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
          child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
          child.on('close', (code) => {
            if (code !== 0) {
              reject(
                new Error(
                  `[shell-grok-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            resolve(stdout);
          });
          child.on('error', (err) => {
            reject(new Error(`[shell-grok-cli] spawn failed: ${err.message}`));
          });
          if (stdin) child.stdin.write(stdin);
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[shell-grok-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
  }
}

function resolveGrokSubagentProfile(options?: ReasoningCallOptions) {
  const requested = options?.profile || options?.role || 'implementer';
  try {
    const profile = getSubagentCapabilityProfile(requested);
    const effective = resolveEffectiveProviderPermissionProfile(
      'grok',
      profile.name as ProviderPermissionProfileName
    );
    return getSubagentCapabilityProfile(effective ?? profile.name);
  } catch {
    return getSubagentCapabilityProfile(
      resolveEffectiveProviderPermissionProfile('grok', 'implementer') ?? 'implementer'
    );
  }
}

function parseStructuredFromText(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return parseSafeJsonInput(text, 'Grok structured response');
  } catch {
    // Some envelopes wrap JSON in fences; strip a single outer fence if present.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
    if (!fenced) return undefined;
    try {
      return parseSafeJsonInput(fenced[1].trim(), 'Grok fenced structured response');
    } catch {
      return undefined;
    }
  }
}

// SYNC probe — version / path only; no live LLM call (mirrors checkClaude discovery).
export function probeShellGrokCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number } = {}
): ShellGrokCliAvailability {
  const bin = options.bin?.trim() || envText(env, 'KYBERION_GROK_CLI_BIN')?.trim() || 'grok';
  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      env: buildProviderChildEnv({ provider: 'grok', baseEnv: { ...process.env, ...env } }),
      shell: false,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error) {
      return { available: false, reason: result.error.message };
    }
    if (result.status !== 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      return {
        available: false,
        reason: stderr || stdout || `exit code ${result.status}`,
      };
    }
    return { available: true };
  } catch (err: any) {
    return { available: false, reason: err?.message ?? String(err) };
  }
}

export interface RunGrokCliQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  options?: ShellGrokCliBackendOptions;
}

export async function runGrokCliQuery<T>({
  systemPrompt,
  userPrompt,
  schema,
  options = {},
}: RunGrokCliQueryParams<T>): Promise<T> {
  const backend = new ShellGrokCliBackend(options);
  return backend.runStructured({ systemPrompt, userPrompt, schema });
}

export function buildGrokCliOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ShellGrokCliBackendOptions {
  const bin = envText(env, 'KYBERION_GROK_CLI_BIN')?.trim();
  const model = envText(env, 'KYBERION_GROK_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_GROK_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = envText(env, 'KYBERION_GROK_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function buildShellGrokCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => ShellGrokCliAvailability = probeShellGrokCliAvailability
): ShellGrokCliBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[shell-grok-cli] backend unavailable (bin=${envText(env, 'KYBERION_GROK_CLI_BIN')?.trim() || 'grok'}): ${availability.reason ?? 'failed health check'}`
    );
    return null;
  }

  const options = buildGrokCliOptionsFromEnv(env);
  const backend = new ShellGrokCliBackend(options);
  logger.info(
    `[shell-grok-cli] backend ready (bin=${options.bin ?? 'grok'}, model=${options.model ?? DEFAULT_MODEL})`
  );
  return backend;
}
