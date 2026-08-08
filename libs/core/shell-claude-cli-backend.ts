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

import { spawn, spawnSync } from 'node:child_process';
import { childDelegationEnv } from './operation-policy-gate.js';
import {
  buildProviderChildEnv,
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
import { isClaudeCliAuthenticated } from './claude-cli-auth-status.js';
import {
  CLAUDE_CLI_PLACEHOLDER_SIGNATURE,
  isClaudeCliPlaceholderFailure,
  resolveClaudeCliFallbackCandidates,
} from './claude-cli-resolution.js';
export {
  CLAUDE_CLI_PLACEHOLDER_SIGNATURE,
  type ClaudeCliFallbackCandidateOptions,
  isClaudeCliPlaceholderFailure,
  resolveClaudeCliFallbackCandidates,
} from './claude-cli-resolution.js';
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

/**
 * Task-weight → claude model mapping (①モデル振り分け): fast tasks run on
 * haiku, standard on sonnet, deep on the backend's configured heavy model.
 */
export function resolveClaudeModelForTier(
  tier: 'fast' | 'standard' | 'deep' | undefined,
  defaultModel: string
): string {
  if (tier === 'fast') return 'haiku';
  if (tier === 'standard') return 'sonnet';
  if (tier === 'deep') return defaultModel || 'opus';
  return defaultModel;
}

export interface ShellClaudeCliBackendOptions {
  /** CLI binary. Defaults to `claude` (resolved via PATH). */
  bin?: string;
  /** Model alias. Defaults to 'opus'. */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Additional CLI args to inject (e.g. --effort high). */
  extraArgs?: string[];
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
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: ShellClaudeCliBackendOptions = {}) {
    this.bin = options.bin ?? 'claude';
    this.model = options.model ?? 'opus';
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
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

  async delegateTask(
    instruction: string,
    context?: string,
    options?: {
      model_tier?: 'fast' | 'standard' | 'deep';
      /**
       * XP-02 follow-up: KD-05 capability profile. When set, its provider
       * permission mapping (see {@link resolveProviderPermissionArgs}) is
       * appended to argv. Omit (the historical default) to keep argv
       * byte-identical to callers that predate this option.
       */
      profile?: ProviderPermissionProfileName;
      advisory?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    const model = resolveClaudeModelForTier(options?.model_tier, this.model);
    const permissionArgs = this.resolvePermissionArgs(
      options?.advisory ? 'planner' : options?.profile
    );
    const args = [
      '-p',
      `${instruction}\n\nContext: ${context ?? 'none'}`,
      '--model',
      model,
      ...permissionArgs,
      ...this.extraArgs,
    ];
    return this.spawnCli(args, '', options?.signal);
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

  /**
   * XP-02 follow-up: resolve a KD-05 capability profile to claude CLI argv
   * fragments. No profile ⇒ `[]` (argv unchanged from pre-XP-02 behavior).
   * A typed refusal (see the profile × provider matrix in
   * provider-permission-profiles.ts) throws before any spawn is attempted.
   */
  private resolvePermissionArgs(profile?: ProviderPermissionProfileName): string[] {
    if (!profile) return [];
    const resolution = resolveProviderPermissionArgs(profile, 'claude');
    if (resolution.kind === 'refused') {
      throw new Error(
        `[shell-claude-cli] permission profile "${profile}" refused: ${resolution.reason}`
      );
    }
    return [...resolution.args];
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
      '--dangerously-skip-permissions',
      '-p',
      prompt,
      ...(input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : []),
      ...this.extraArgs,
    ];

    return this.spawnCli(args, '');
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
      '--dangerously-skip-permissions',
      '-p',
      prompt,
      ...(input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : []),
      ...this.extraArgs,
    ];

    return this.spawnCli(args, '');
  }

  async runStructured<T>(params: {
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
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args, params.userPrompt);
    let cliResult: any;
    try {
      cliResult = JSON.parse(stdout);
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
  private spawnCli(args: string[], stdin: string, signal?: AbortSignal): Promise<string> {
    const child = spawn(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // XP-02: minimal allowlisted env (no cross-provider credential
      // leakage); SA-05: one delegation hop deeper than us.
      env: { ...buildProviderChildEnv({ provider: 'claude' }), ...childDelegationEnv() },
    });

    return withWallClockBudget(
      {
        provider: 'claude',
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
                  `[shell-claude-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            resolve(stdout);
          });
          child.on('error', (err) => {
            reject(new Error(`[shell-claude-cli] spawn failed: ${err.message}`));
          });
          child.stdin.write(stdin);
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[shell-claude-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
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
  const explicitBin = options.bin?.trim() || env.KYBERION_CLAUDE_CLI_BIN?.trim();
  const bin = explicitBin || 'claude';
  const timeoutMs = options.timeoutMs ?? 5_000;

  const primary = probeClaudeBinOnce(bin, env, timeoutMs);
  if (primary.available) {
    return { ...primary, bin };
  }

  // LC-03 fallback: only when no binary was explicitly requested and the
  // failure carries the pnpm placeholder signature — never second-guess an
  // operator-pinned KYBERION_CLAUDE_CLI_BIN.
  if (!explicitBin && isClaudeCliPlaceholderFailure(primary.reason)) {
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
    const versionResult = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      // XP-02: minimal allowlisted env; overrides in `env` (e.g. a test's
      // KYBERION_CLAUDE_CLI_BIN, or the KYBERION_PROVIDER_ENV_ALLOWLIST=0
      // escape hatch) are applied before allowlisting so they still take
      // effect.
      env: childEnv,
      shell: false,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    const authResult = spawnSync(bin, ['auth', 'status'], {
      encoding: 'utf8',
      env: childEnv,
      shell: false,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
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

export function buildClaudeCliOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ShellClaudeCliBackendOptions {
  const bin = env.KYBERION_CLAUDE_CLI_BIN?.trim();
  const model = env.KYBERION_CLAUDE_CLI_MODEL?.trim();
  const timeoutRaw = env.KYBERION_CLAUDE_CLI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = env.KYBERION_CLAUDE_CLI_EXTRA_ARGS?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function buildShellClaudeCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => ShellClaudeCliAvailability = probeShellClaudeCliAvailability
): ShellClaudeCliBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[shell-claude-cli] backend unavailable (bin=${env.KYBERION_CLAUDE_CLI_BIN?.trim() || 'claude'}): ${availability.reason ?? 'failed health check'}. If the reason mentions "${CLAUDE_CLI_PLACEHOLDER_SIGNATURE}", run \`pnpm approve-builds\` (approve @anthropic-ai/claude-code) or set KYBERION_CLAUDE_CLI_BIN=$HOME/.local/bin/claude.`
    );
    return null;
  }

  // Prefer an explicit pin; otherwise honor the binary the probe actually
  // validated (LC-03: may be a fallback outside node_modules/.bin).
  const bin = env.KYBERION_CLAUDE_CLI_BIN?.trim() || availability.bin?.trim();
  const model = env.KYBERION_CLAUDE_CLI_MODEL?.trim();
  const timeoutRaw = env.KYBERION_CLAUDE_CLI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = env.KYBERION_CLAUDE_CLI_EXTRA_ARGS?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  const backend = new ShellClaudeCliBackend({
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  });
  logger.info(
    `[shell-claude-cli] backend ready (bin=${bin ?? 'claude'}, model=${model ?? 'opus'})`
  );
  return backend;
}
