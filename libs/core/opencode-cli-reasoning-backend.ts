/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * OpenCode CLI Reasoning Backend — spawns the local `opencode` CLI in
 * `run --format json` mode for structured-output reasoning tasks.
 *
 * `opencode run` emits NDJSON events (`step_start` / `text` / `step_finish`,
 * …); the answer text is collected from `text` parts. There is no native
 * `--json-schema` flag, so structured ops reuse {@link runStructuredReasoningOp}
 * (prompt-enforced JSON + Zod validation) — the same shape as the Cursor CLI
 * backend.
 *
 * Auth is the ambient `opencode` login session (`opencode auth login` /
 * `~/.local/share/opencode/auth.json`, e.g. the `opencode` provider for
 * Muse Spark). No API-key env is required. `--auto` is never passed: planner /
 * explorer profiles run on the read-only `plan` agent, implementer runs on
 * `build`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
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
  throw new Error(`[opencode-cli] unsupported permission profile: ${value}`);
}

const DEFAULT_MODEL = 'opencode/muse-spark-1.3-contributor-free';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BIN = 'opencode';
const DEFAULT_PLAN_AGENT = 'plan';
const DEFAULT_BUILD_AGENT = 'build';
const GOVERNED_ARGUMENTS = new Set([
  '--model',
  '--agent',
  '--dir',
  '--format',
  '--session',
  '--continue',
  '--fork',
  '--share',
  '--attach',
  '--port',
  '--password',
  '--username',
  '--command',
  '--file',
  '--title',
  '--variant',
  '--thinking',
  '--interactive',
  '--auto',
]);

function validateExtraArgs(args: readonly string[]): string[] {
  for (const arg of args) {
    const flag = arg.split('=', 1)[0];
    if (GOVERNED_ARGUMENTS.has(flag)) {
      throw new Error(`[opencode-cli] extra args may not override governed flag: ${flag}`);
    }
  }
  return [...args];
}

/**
 * Render a compact shape hint from a spec's Zod schema (e.g.
 * `{ hypotheses: array of { id: string, proposed_by: string, ... } }`).
 *
 * `opencode run` has no `--json-schema` flag, so prompt-only structured ops
 * depend on the model reproducing the exact key layout. Free-tier small
 * models guess a plausible-but-wrong shape without an explicit hint; this
 * keeps the hint backend-local instead of changing the shared specs.
 */
function zodDefOf(schema: z.ZodTypeAny): { type?: string; [key: string]: unknown } {
  const withInternals = schema as unknown as {
    _zod?: { def?: { type?: string; [key: string]: unknown } };
  };
  return withInternals._zod?.def ?? {};
}

function zodShape(schema: z.ZodTypeAny): string {
  const def = zodDefOf(schema);
  if (def.type === 'optional' || def.type === 'default' || def.type === 'prefault') {
    const inner = def.innerType as z.ZodTypeAny | undefined;
    const rendered = inner ? zodShape(inner) : 'value';
    return def.type === 'optional' ? `${rendered} (optional)` : rendered;
  }
  if (def.type === 'array') {
    const element = def.element as z.ZodTypeAny | undefined;
    return `array of ${element ? zodShape(element) : 'value'}`;
  }
  if (def.type === 'object') {
    const shape = def.shape as Record<string, z.ZodTypeAny> | undefined;
    const entries = Object.entries(shape ?? {}).map(([key, value]) => `${key}: ${zodShape(value)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (def.type === 'enum') {
    const values = def.values as unknown;
    return Array.isArray(values) ? `one of ${values.join('/')}` : 'string';
  }
  if (def.type === 'string') return 'string';
  if (def.type === 'number') return 'number';
  if (def.type === 'boolean') return 'boolean';
  // Pipes / transforms / prefaults wrap an inner schema — describe the inner shape.
  const inner = def.innerType as z.ZodTypeAny | undefined;
  if (inner) return zodShape(inner);
  return 'value';
}

function schemaHint(schema: z.ZodTypeAny): string {
  try {
    return zodShape(schema);
  } catch {
    return 'a JSON object';
  }
}

export interface OpencodeCliReasoningBackendOptions {
  /** CLI binary. Defaults to `opencode` (resolved via PATH). */
  bin?: string;
  /** Model ID in `provider/model` form. Defaults to Muse Spark via the opencode provider. */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Additional CLI args. */
  extraArgs?: string[];
  /** Working directory passed via `--dir`. Defaults to repo root. */
  workspaceDir?: string;
  /** Agent for read-only profiles. Defaults to `plan`. */
  planAgent?: string;
  /** Agent for the implementer profile. Defaults to `build`. */
  buildAgent?: string;
}

export interface OpencodeCliAvailability {
  available: boolean;
  reason?: string;
}

export class OpencodeCliReasoningBackend implements ReasoningBackend {
  readonly name = 'opencode-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly workspaceDir: string;
  private readonly planAgent: string;
  private readonly buildAgent: string;

  constructor(options: OpencodeCliReasoningBackendOptions = {}) {
    this.bin = options.bin ?? DEFAULT_BIN;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = validateExtraArgs(options.extraArgs ?? []);
    this.workspaceDir = options.workspaceDir ?? pathResolver.rootDir();
    this.planAgent = options.planAgent ?? DEFAULT_PLAN_AGENT;
    this.buildAgent = options.buildAgent ?? DEFAULT_BUILD_AGENT;
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
      { profile: options?.profile ?? 'planner' }
    );
  }

  private resolveAgentArgs(profile?: ProviderPermissionProfileName): string[] {
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('opencode', profile);
    if (!effectiveProfile) {
      // Safe default for unprofiled headless calls: read-only planning agent.
      return ['--agent', this.planAgent];
    }
    const resolution = resolveProviderPermissionArgs(effectiveProfile, 'opencode');
    if (resolution.kind === 'refused') {
      throw new Error(
        `[opencode-cli] permission profile "${effectiveProfile}" refused: ${resolution.reason}`
      );
    }
    // The matrix is authoritative for allow/refuse; the concrete agent name
    // follows this backend's configuration so custom agents keep working.
    const agent = effectiveProfile === 'implementer' ? this.buildAgent : this.planAgent;
    return ['--agent', agent];
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
      'run',
      '--format',
      'json',
      '--model',
      model,
      ...this.resolveAgentArgs(options?.profile),
      '--dir',
      this.workspaceDir,
      ...this.extraArgs,
      prompt,
    ];

    const stdout = await this.spawnCli(args, options?.signal);
    return parseOpencodeRunJson(stdout);
  }

  private spawnCli(args: string[], signal?: AbortSignal): Promise<string> {
    const child = spawn(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildProviderChildEnv({ provider: 'opencode' }), ...childDelegationEnv() },
    });

    return withWallClockBudget(
      {
        provider: 'opencode',
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
                  `[opencode-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            resolve(stdout);
          });
          child.on('error', (err) => {
            reject(new Error(`[opencode-cli] spawn failed: ${err.message}`));
          });
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[opencode-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
  }
}

/**
 * Collect answer text from `opencode run --format json` NDJSON output.
 * Each line is one event; `text` events carry `{ part: { type: 'text', text } }`.
 */
export function parseOpencodeRunJson(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `[opencode-cli] failed to parse CLI JSON line: ${trimmed.slice(0, 200)}. Raw: ${stdout.slice(0, 500)}`
      );
    }
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record['type'] === 'error') {
      const message =
        typeof record['message'] === 'string'
          ? record['message']
          : JSON.stringify(event).slice(0, 500);
      throw new Error(`[opencode-cli] CLI reported error: ${message}`);
    }
    if (record['type'] !== 'text') continue;
    const part = record['part'];
    if (typeof part !== 'object' || part === null) continue;
    const partRecord = part as Record<string, unknown>;
    if (partRecord['type'] !== 'text' || typeof partRecord['text'] !== 'string') continue;
    texts.push(partRecord['text']);
  }
  const result = texts.join('').trim();
  if (!result) {
    throw new Error(`[opencode-cli] CLI did not emit text. Raw: ${stdout.slice(0, 500)}`);
  }
  return result;
}

/** SYNC probe — version / path only; no live LLM call. */
export function probeOpencodeCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number } = {}
): OpencodeCliAvailability {
  const bin =
    options.bin?.trim() || envText(env, 'KYBERION_OPENCODE_CLI_BIN')?.trim() || DEFAULT_BIN;
  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      env: buildProviderChildEnv({ provider: 'opencode', baseEnv: { ...process.env, ...env } }),
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

export function buildOpencodeCliOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): OpencodeCliReasoningBackendOptions {
  const bin = envText(env, 'KYBERION_OPENCODE_CLI_BIN')?.trim();
  const model = envText(env, 'KYBERION_OPENCODE_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_OPENCODE_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = envText(env, 'KYBERION_OPENCODE_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function buildOpencodeCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => OpencodeCliAvailability = probeOpencodeCliAvailability,
  model?: string
): OpencodeCliReasoningBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[opencode-cli] backend unavailable (bin=${envText(env, 'KYBERION_OPENCODE_CLI_BIN')?.trim() || DEFAULT_BIN}): ${availability.reason ?? 'failed health check'}`
    );
    return null;
  }

  const options = {
    ...buildOpencodeCliOptionsFromEnv(env),
    ...(model ? { model } : {}),
  };
  const backend = new OpencodeCliReasoningBackend(options);
  logger.info(
    `[opencode-cli] backend ready (bin=${options.bin ?? DEFAULT_BIN}, model=${options.model ?? DEFAULT_MODEL})`
  );
  return backend;
}
