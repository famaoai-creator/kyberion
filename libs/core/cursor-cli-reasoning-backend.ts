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
const GOVERNED_ARGUMENTS = new Set([
  '-p',
  '--output-format',
  '--model',
  '--trust',
  '--workspace',
  '--mode',
  '--sandbox',
  '--force',
]);

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
}

export interface CursorCliAvailability {
  available: boolean;
  reason?: string;
}

export class CursorCliReasoningBackend implements ReasoningBackend {
  readonly name = 'cursor-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly workspaceDir: string;

  constructor(options: CursorCliReasoningBackendOptions = {}) {
    this.bin = options.bin ?? DEFAULT_BIN;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = validateExtraArgs(options.extraArgs ?? []);
    this.workspaceDir = options.workspaceDir ?? pathResolver.rootDir();
  }

  private runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    return runStructuredReasoningOp(spec, input, (systemPrompt, userPrompt) =>
      this.complete(systemPrompt, userPrompt, { profile: 'planner' })
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
      { profile: options?.profile ?? 'planner' }
    );
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
    }
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const model = options?.model?.trim() || this.model;
    const prompt = `${systemPrompt.trim()}\n\n${userPrompt.trim()}`.trim();
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--trust',
      '--workspace',
      this.workspaceDir,
      ...this.resolvePermissionArgs(options?.profile),
      ...this.extraArgs,
      prompt,
    ];

    const stdout = await this.spawnCli(args, options?.signal);
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

/** SYNC probe — version / path only; no live LLM call. */
export function probeCursorCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number } = {}
): CursorCliAvailability {
  const bin = options.bin?.trim() || envText(env, 'KYBERION_CURSOR_CLI_BIN')?.trim() || DEFAULT_BIN;
  const timeoutMs = options.timeoutMs ?? 5_000;

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
    return { available: true };
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
