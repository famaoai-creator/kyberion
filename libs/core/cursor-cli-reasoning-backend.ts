/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * Cursor CLI Reasoning Backend — spawns the local `cursor-agent` CLI in
 * `-p --output-format json` mode for structured-output reasoning tasks.
 *
 * Cursor Agent has no native `--json-schema` flag, so structured ops reuse
 * {@link runStructuredReasoningOp} (prompt-enforced JSON + Zod validation).
 * Auth is `CURSOR_API_KEY` and/or an existing `cursor-agent login` session.
 */

import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
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
import * as pathResolver from './path-resolver.js';
import {
  runStructuredReasoningOp,
  structuredReasoningSpecs,
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  type StructuredOpSpec,
} from './structured-reasoning.js';
import { schemaHint } from './structured-schema-hint.js';
import type { AgentAskOptions, AgentResponse } from './agent-adapter.js';
import type { NativeSubagentAdopter } from './native-subagent-adopter.js';
import { getSubagentCapabilityProfile } from './subagent-capability-profiles.js';
import { CursorCliSessionAdapter } from './cursor-cli-session-adapter.js';
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
  ReasoningCallOptions,
} from './reasoning-backend.js';

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

function normalizePermissionProfile(
  value: string | undefined
): ProviderPermissionProfileName | undefined {
  if (!value) return undefined;
  if (value === 'implementer' || value === 'explorer' || value === 'planner') return value;
  throw new Error(`[cursor-cli] unsupported permission profile: ${value}`);
}

const DEFAULT_MODEL = 'auto';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BIN = 'cursor-agent';
const DEEP_MODEL = 'composer-2.5';
const FAST_MODEL = 'composer-2.5-fast';
const GOVERNED_ARGUMENTS = new Set([
  '-p',
  '--output-format',
  '--model',
  '--trust',
  '--workspace',
  '--mode',
  '--sandbox',
  '--force',
  '--continue',
  '--resume',
  '--worktree',
  '--worktree-base',
]);

export function resolveCursorModelForTier(
  tier: 'fast' | 'standard' | 'deep' | undefined,
  defaultModel: string
): string {
  if (tier === 'fast') {
    return defaultModel === 'auto' ? 'auto' : FAST_MODEL;
  }
  if (tier === 'deep') {
    return defaultModel === 'auto' ? DEEP_MODEL : defaultModel;
  }
  return defaultModel || DEFAULT_MODEL;
}

function isNamedModelUnavailableError(message: string): boolean {
  return /named models unavailable|free plans can only use auto/iu.test(message);
}

function validateExtraArgs(args: readonly string[]): string[] {
  for (const arg of args) {
    const flag = arg.split('=', 1)[0];
    if (GOVERNED_ARGUMENTS.has(flag)) {
      throw new Error(`[cursor-cli] extra args may not override governed flag: ${flag}`);
    }
  }
  return [...args];
}

const CursorCliEnvelopeSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  duration_ms: z.number().optional(),
  session_id: z.string().optional(),
  request_id: z.string().optional(),
});

export interface CursorCliReasoningBackendOptions {
  /** CLI binary. Defaults to `cursor-agent` (resolved via PATH). */
  bin?: string;
  /** Model ID. Defaults to `auto` (Free-plan compatible). */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Additional CLI args. */
  extraArgs?: string[];
  /** Workspace directory passed via `--workspace`. Defaults to repo root. */
  workspaceDir?: string;
  /** Test seam and runtime injection for the shared Cursor harness session. */
  harnessSession?: CursorCliHarnessSession;
  /**
   * Enable provider-native subagent dispatch via worktree-isolated spawns.
   * Defaults to true unless `KYBERION_CURSOR_NATIVE_SUBAGENT=0`.
   */
  nativeSubagent?: boolean;
}

export interface CursorCliHarnessSession {
  boot(): Promise<void>;
  ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  askNativeSubagent?(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  getRuntimeInfo?(): Record<string, unknown>;
  shutdown?(): Promise<void>;
}

export interface CursorCliAvailability {
  available: boolean;
  reason?: string;
  /** Present when an auth probe was attempted. */
  authenticated?: boolean;
}

export class CursorCliReasoningBackend implements ReasoningBackend {
  readonly name = 'cursor-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly workspaceDir: string;
  private sessionId?: string;
  private readonly injectedHarnessSession?: CursorCliHarnessSession;
  private readonly nativeSubagentEnabled: boolean;
  private harnessSession?: CursorCliHarnessSession;
  private harnessBoot?: Promise<void>;
  private harnessQueue: Promise<void> = Promise.resolve();
  private lastHarnessSubagentInfo: Record<string, unknown> | null = null;
  private readonly nativeSubagentAdopter: NativeSubagentAdopter;

  constructor(options: CursorCliReasoningBackendOptions = {}) {
    this.bin = options.bin ?? DEFAULT_BIN;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = validateExtraArgs(options.extraArgs ?? []);
    this.workspaceDir = options.workspaceDir ?? pathResolver.rootDir();
    this.injectedHarnessSession = options.harnessSession;
    this.nativeSubagentEnabled =
      options.nativeSubagent ?? getRegisteredEnvText('KYBERION_CURSOR_NATIVE_SUBAGENT') !== '0';
    this.nativeSubagentAdopter = {
      id: 'cursor-agent-cli',
      dispatch: (instruction, context, callOptions) =>
        this.dispatchNativeSubagent(instruction, context, callOptions),
      getInfo: () => (this.lastHarnessSubagentInfo ? { ...this.lastHarnessSubagentInfo } : null),
    };
  }

  private runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    return runStructuredReasoningOp(spec, input, (systemPrompt, userPrompt) =>
      this.complete(systemPrompt, userPrompt, {
        profile: 'planner',
        shapeHint: schemaHint(spec.schema),
      })
    );
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
    options?: ReasoningCallOptions
  ): Promise<string> {
    const profile = options?.advisory ? 'planner' : normalizePermissionProfile(options?.profile);
    return this.complete(
      STRUCTURED_REASONING_SYSTEM_PROMPT,
      [context ? `Context: ${context}` : '', `Task: ${instruction}`].filter(Boolean).join('\n\n'),
      { profile, signal: options?.signal, model: options?.model }
    );
  }

  async prompt(
    prompt: string,
    options?: {
      model_tier?: 'fast' | 'standard' | 'deep';
      profile?: ProviderPermissionProfileName;
    }
  ): Promise<string> {
    return this.complete(
      'You are a focused reasoning sub-agent. Return a concise, factual answer.',
      prompt,
      {
        profile: options?.profile ?? 'planner',
        model: resolveCursorModelForTier(options?.model_tier, this.model),
      }
    );
  }

  /** QM-06: drop the resumed CLI session on a failover switch. */
  async resetSession(): Promise<void> {
    this.sessionId = undefined;
    const session = this.harnessSession;
    this.harnessSession = undefined;
    this.harnessBoot = undefined;
    this.lastHarnessSubagentInfo = null;
    if (!session || session === this.injectedHarnessSession) return;
    await session.shutdown?.().catch(() => undefined);
  }

  /**
   * Worktree-isolated native subagent dispatch for HarnessSubagentDispatcher.
   * Kept separate from `delegateTask` so structured reasoning and ordinary
   * prompt delegation stay on the resumed parent-session spawn path.
   */
  private async dispatchNativeSubagent(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const profile = resolveCursorSubagentProfile(options);
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
          '[SUBAGENT_UNAVAILABLE] Cursor CLI session has no native subagent operation.'
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
        throw new Error('[SUBAGENT_UNAVAILABLE] Cursor CLI returned an error response.');
      }
      const nativeInfo = response.metadata?.nativeSubagent;
      if (!nativeInfo || typeof nativeInfo !== 'object') {
        throw new Error('[SUBAGENT_UNAVAILABLE] Cursor CLI returned no native subagent metadata.');
      }
      this.lastHarnessSubagentInfo = { ...(nativeInfo as Record<string, unknown>) };
      return response.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('[SUBAGENT_UNAVAILABLE]')) throw error;
      throw new Error(`[SUBAGENT_UNAVAILABLE] Cursor CLI harness failed: ${message}`);
    } finally {
      release();
    }
  }

  getNativeSubagentAdopter(): NativeSubagentAdopter | null {
    return this.nativeSubagentEnabled ? this.nativeSubagentAdopter : null;
  }

  requiresNativeSubagent(): boolean {
    return this.nativeSubagentEnabled;
  }

  private getHarnessSession(): CursorCliHarnessSession {
    if (this.harnessSession) return this.harnessSession;
    if (this.injectedHarnessSession) {
      this.harnessSession = this.injectedHarnessSession;
      return this.harnessSession;
    }
    this.harnessSession = new CursorCliSessionAdapter({
      bin: this.bin,
      model: this.model,
      timeoutMs: this.timeoutMs,
      extraArgs: this.extraArgs,
      workspaceDir: this.workspaceDir,
    });
    return this.harnessSession;
  }

  private resolvePermissionArgs(profile?: ProviderPermissionProfileName): string[] {
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('cursor', profile);
    if (!effectiveProfile) {
      // Safe default for unprofiled headless calls: ask mode (read-only Q&A).
      return ['--mode', 'ask'];
    }
    const resolution = resolveProviderPermissionArgs(effectiveProfile, 'cursor');
    if (resolution.kind === 'refused') {
      throw new Error(
        `[cursor-cli] permission profile "${effectiveProfile}" refused: ${resolution.reason}`
      );
    }
    return [...resolution.args];
  }

  private async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      profile?: ProviderPermissionProfileName;
      signal?: AbortSignal;
      model?: string;
      shapeHint?: string;
    }
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const model = options?.model?.trim() || this.model;
    const hint = options?.shapeHint?.trim()
      ? `\n\nRespond with exactly this JSON shape (top-level keys, nesting, and field names must match): ${options.shapeHint.trim()}`
      : '';
    const prompt = `${systemPrompt.trim()}\n\n${userPrompt.trim()}${hint}`.trim();
    const sessionArgs = this.sessionId ? ['--resume', this.sessionId] : [];
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--trust',
      '--workspace',
      this.workspaceDir,
      ...sessionArgs,
      ...this.resolvePermissionArgs(options?.profile),
      ...this.extraArgs,
      prompt,
    ];

    try {
      return await this.spawnAndParse(args, options?.signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (model !== 'auto' && isNamedModelUnavailableError(message)) {
        logger.warn(
          `[cursor-cli] model "${model}" unavailable on current plan; retrying once with auto`
        );
        const fallbackArgs = args.map((arg, index) =>
          index > 0 && args[index - 1] === '--model' ? 'auto' : arg
        );
        return this.spawnAndParse(fallbackArgs, options?.signal);
      }
      throw err;
    }
  }

  private async spawnAndParse(args: string[], signal?: AbortSignal): Promise<string> {
    const stdout = await this.spawnCli(args, signal);
    return this.parseEnvelope(stdout);
  }

  private parseEnvelope(stdout: string): string {
    let cliResult: unknown;
    try {
      cliResult = parseSafeJsonInput(stdout, 'Cursor CLI response');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[cursor-cli] failed to parse CLI JSON output: ${message}. Raw: ${stdout.slice(0, 500)}`
      );
    }

    const envelope = CursorCliEnvelopeSchema.safeParse(cliResult);
    if (!envelope.success) {
      throw new Error(
        `[cursor-cli] unexpected CLI envelope: ${JSON.stringify(cliResult).slice(0, 500)}`
      );
    }
    if (envelope.data.is_error) {
      throw new Error(
        `[cursor-cli] CLI reported error: ${typeof envelope.data.result === 'string' ? envelope.data.result : JSON.stringify(envelope.data.result).slice(0, 500)}`
      );
    }

    if (typeof envelope.data.session_id === 'string' && envelope.data.session_id.trim()) {
      this.sessionId = envelope.data.session_id.trim();
    }

    if (typeof envelope.data.result === 'string') {
      return envelope.data.result;
    }
    if (envelope.data.result !== undefined && envelope.data.result !== null) {
      return JSON.stringify(envelope.data.result);
    }
    throw new Error(
      `[cursor-cli] CLI did not emit result. Envelope: ${JSON.stringify(envelope.data).slice(0, 500)}`
    );
  }

  private spawnCli(args: string[], signal?: AbortSignal): Promise<string> {
    const child = spawn(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildProviderChildEnv({ provider: 'cursor' }), ...childDelegationEnv() },
    });

    return withWallClockBudget(
      {
        provider: 'cursor',
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
                  `[cursor-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            resolve(stdout);
          });
          child.on('error', (err) => {
            reject(new Error(`[cursor-cli] spawn failed: ${err.message}`));
          });
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[cursor-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
  }
}

/** SYNC probe — version / auth / path only; no live LLM call. */
export function probeCursorCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number; checkAuth?: boolean } = {}
): CursorCliAvailability {
  const bin = options.bin?.trim() || envText(env, 'KYBERION_CURSOR_CLI_BIN')?.trim() || DEFAULT_BIN;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const checkAuth = options.checkAuth ?? true;

  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      env: buildProviderChildEnv({ provider: 'cursor', baseEnv: { ...process.env, ...env } }),
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

    if (!checkAuth) {
      return { available: true };
    }

    if (envText(env, 'CURSOR_API_KEY')?.trim()) {
      return { available: true, authenticated: true };
    }

    const status = spawnSync(bin, ['status'], {
      encoding: 'utf8',
      env: buildProviderChildEnv({ provider: 'cursor', baseEnv: { ...process.env, ...env } }),
      shell: false,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const statusOut = `${status.stdout ?? ''}\n${status.stderr ?? ''}`.trim();
    const authenticated = status.status === 0 && /logged in|✓/iu.test(statusOut);
    if (!authenticated) {
      return {
        available: true,
        authenticated: false,
        reason: statusOut || 'cursor-agent status did not report a logged-in session',
      };
    }
    return { available: true, authenticated: true };
  } catch (err: unknown) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildCursorCliOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CursorCliReasoningBackendOptions {
  const bin = envText(env, 'KYBERION_CURSOR_CLI_BIN')?.trim();
  const model = envText(env, 'KYBERION_CURSOR_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_CURSOR_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = envText(env, 'KYBERION_CURSOR_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function buildCursorCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => CursorCliAvailability = probeCursorCliAvailability,
  model?: string
): CursorCliReasoningBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[cursor-cli] backend unavailable (bin=${envText(env, 'KYBERION_CURSOR_CLI_BIN')?.trim() || DEFAULT_BIN}): ${availability.reason ?? 'failed health check'}`
    );
    return null;
  }
  if (availability.authenticated === false) {
    logger.warn(
      `[cursor-cli] backend installed but not authenticated: ${availability.reason ?? 'run cursor-agent login or set CURSOR_API_KEY'}`
    );
    return null;
  }

  const options = {
    ...buildCursorCliOptionsFromEnv(env),
    ...(model ? { model } : {}),
  };
  const backend = new CursorCliReasoningBackend(options);
  logger.info(
    `[cursor-cli] backend ready (bin=${options.bin ?? DEFAULT_BIN}, model=${options.model ?? DEFAULT_MODEL})`
  );
  return backend;
}

function resolveCursorSubagentProfile(options?: ReasoningCallOptions) {
  const requested = options?.profile || options?.role || 'implementer';
  try {
    const profile = getSubagentCapabilityProfile(requested);
    const effective = resolveEffectiveProviderPermissionProfile(
      'cursor',
      profile.name as ProviderPermissionProfileName
    );
    return getSubagentCapabilityProfile(effective ?? profile.name);
  } catch {
    return getSubagentCapabilityProfile(
      resolveEffectiveProviderPermissionProfile('cursor', 'implementer') ?? 'implementer'
    );
  }
}
