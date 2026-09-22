/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * Devin CLI Reasoning Backend — spawns the local `devin` CLI in `-p`
 * (print) mode for reasoning tasks.
 *
 * `devin -p -- <prompt>` writes the model's answer text to stdout and exits;
 * there is no native JSON/structured-output flag, so structured ops reuse
 * {@link runStructuredReasoningOp} (prompt-enforced JSON + Zod validation) —
 * the same shape as the OpenCode CLI backend.
 *
 * Auth is the ambient Devin CLI login session (`devin auth login`), so no
 * API-key env is required. `--respect-workspace-trust false` is always passed:
 * non-interactive print mode cannot render the workspace-trust prompt and
 * would otherwise fail outright in an untrusted directory.
 *
 * Permission tiers project onto `--permission-mode`:
 *   implementer → bypass (auto-approves every tool call)
 *   explorer    → normal (read-only tools auto-approve; write/exec prompts
 *                 have no one to answer under `-p` and fail closed)
 *   planner     → refused (the no-tools Plan/Ask agent modes are
 *                 interactive-only, so no honest headless projection exists)
 */

import { spawn, spawnSync } from 'node:child_process';
import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
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
import {
  runStructuredReasoningOp,
  structuredReasoningSpecs,
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  type StructuredOpSpec,
} from './structured-reasoning.js';
import { schemaHint } from './structured-schema-hint.js';
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
  throw new Error(`[devin-cli] unsupported permission profile: ${value}`);
}

const DEFAULT_MODEL = 'swe';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BIN = 'devin';
const GOVERNED_ARGUMENTS = new Set([
  '--model',
  '--permission-mode',
  '--sandbox',
  '--print',
  '-p',
  '--prompt-file',
  '--config',
  '--export',
  '--respect-workspace-trust',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--',
]);

function validateExtraArgs(args: readonly string[]): string[] {
  for (const arg of args) {
    // `--` terminates option parsing: extra args are injected before the
    // backend-owned `-p --`, so a bare `--` would demote them to positional
    // arguments and restructure the governed invocation.
    if (arg === '--') {
      throw new Error('[devin-cli] extra args may not restructure option parsing: --');
    }
    const flag = arg.split('=', 1)[0];
    if (GOVERNED_ARGUMENTS.has(flag)) {
      throw new Error(`[devin-cli] extra args may not override governed flag: ${flag}`);
    }
  }
  return [...args];
}

export interface DevinCliReasoningBackendOptions {
  /** CLI binary. Defaults to `devin` (resolved via PATH). */
  bin?: string;
  /** Model ID or family alias (`swe`, `opus`, `gpt`, …). Defaults to `swe`. */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Additional CLI args. May not override governed flags. */
  extraArgs?: string[];
}

export interface DevinCliAvailability {
  available: boolean;
  reason?: string;
}

export class DevinCliReasoningBackend implements ReasoningBackend {
  readonly name = 'devin-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: DevinCliReasoningBackendOptions = {}) {
    this.bin = options.bin ?? DEFAULT_BIN;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = validateExtraArgs(options.extraArgs ?? []);
  }

  private runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    return runStructuredReasoningOp(spec, input, (systemPrompt, userPrompt) =>
      this.complete(systemPrompt, userPrompt, {
        // Devin has no headless no-tools mode; explorer is the strictest
        // honest tier (read-only tools only, writes fail closed).
        profile: 'explorer',
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
    const profile = options?.advisory ? 'explorer' : normalizePermissionProfile(options?.profile);
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
      { profile: options?.profile ?? 'explorer' }
    );
  }

  private resolvePermissionArgs(profile?: ProviderPermissionProfileName): string[] {
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('devin', profile);
    if (!effectiveProfile) {
      // Safe default for unprofiled headless calls: read-only tools run,
      // anything mutating stalls on an unanswerable prompt and fails closed.
      return ['--permission-mode', 'normal'];
    }
    const resolution = resolveProviderPermissionArgs(effectiveProfile, 'devin');
    if (resolution.kind === 'refused') {
      throw new Error(
        `[devin-cli] permission profile "${effectiveProfile}" refused: ${resolution.reason}`
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
    const args = [
      '--model',
      model,
      ...this.resolvePermissionArgs(options?.profile),
      '--respect-workspace-trust',
      'false',
      ...this.extraArgs,
      '-p',
      '--',
      prompt,
    ];

    const stdout = await this.spawnCli(args, options?.signal);
    const result = stdout.trim();
    if (!result) {
      throw new Error('[devin-cli] CLI returned no text');
    }
    return result;
  }

  private spawnCli(args: string[], signal?: AbortSignal): Promise<string> {
    const child = spawn(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildProviderChildEnv({ provider: 'devin' }), ...childDelegationEnv() },
    });

    return withWallClockBudget(
      {
        provider: 'devin',
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
                  `[devin-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            resolve(stdout);
          });
          child.on('error', (err) => {
            reject(new Error(`[devin-cli] spawn failed: ${err.message}`));
          });
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[devin-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
  }
}

/** SYNC probe — version / path only; no live LLM call. */
export function probeDevinCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number } = {}
): DevinCliAvailability {
  const bin = options.bin?.trim() || envText(env, 'KYBERION_DEVIN_CLI_BIN')?.trim() || DEFAULT_BIN;
  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      env: buildProviderChildEnv({ provider: 'devin', baseEnv: { ...process.env, ...env } }),
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
  } catch (err: unknown) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildDevinCliOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): DevinCliReasoningBackendOptions {
  const bin = envText(env, 'KYBERION_DEVIN_CLI_BIN')?.trim();
  const model = envText(env, 'KYBERION_DEVIN_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_DEVIN_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = envText(env, 'KYBERION_DEVIN_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function buildDevinCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => DevinCliAvailability = probeDevinCliAvailability,
  model?: string
): DevinCliReasoningBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[devin-cli] backend unavailable (bin=${envText(env, 'KYBERION_DEVIN_CLI_BIN')?.trim() || DEFAULT_BIN}): ${availability.reason ?? 'failed health check'}`
    );
    return null;
  }

  const options = {
    ...buildDevinCliOptionsFromEnv(env),
    ...(model ? { model } : {}),
  };
  const backend = new DevinCliReasoningBackend(options);
  logger.info(
    `[devin-cli] backend ready (bin=${options.bin ?? DEFAULT_BIN}, model=${options.model ?? DEFAULT_MODEL})`
  );
  return backend;
}
