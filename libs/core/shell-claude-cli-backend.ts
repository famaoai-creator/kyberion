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
import { z, type ZodType } from 'zod';
import { logger } from './core.js';
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

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    const minPer = Math.max(1, input.minPerPersona ?? 2);
    const schema = z.object({
      hypotheses: z.array(
        z.object({
          id: z.string(),
          proposed_by: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'survived', 'rejected']).optional(),
        }),
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
          critiques: z
            .array(z.object({ by: z.string(), content: z.string() }))
            .optional(),
        }),
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
        }),
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
        }),
      ),
    });
    return (await this.runStructured({
      systemPrompt:
        'You simulate short-horizon execution of branches toward a goal, reporting first-failure / first-success modes. ' +
        'Do not actually execute anything — produce a reasoned simulation narrative per branch.',
      userPrompt: [
        `Goal: ${input.goal}`,
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
        'Be exhaustive but do not invent — flag unknowns as open_questions.',
      userPrompt: [
        input.projectName ? `Project: ${input.projectName}` : '',
        input.language ? `Source language: ${input.language}` : '',
        input.customer ? `Customer: ${JSON.stringify(input.customer)}` : '',
        '',
        'Source text:',
        input.sourceText,
        '',
        input.priorDraft ? `Prior draft to refine:\n${JSON.stringify(input.priorDraft, null, 2)}` : '',
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

  async delegateTask(instruction: string, context?: string): Promise<string> {
    const args = [
      '-p',
      `${instruction}\n\nContext: ${context ?? 'none'}`,
      ...this.extraArgs,
    ];
    return this.spawnCli(args, '');
  }

  async prompt(prompt: string): Promise<string> {
    return this.delegateTask(prompt);
  }

  private async runStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
  }): Promise<T> {
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
        `[shell-claude-cli] failed to parse CLI JSON output: ${err?.message ?? err}. Raw: ${stdout.slice(0, 500)}`,
      );
    }
    if (cliResult.is_error) {
      throw new Error(`[shell-claude-cli] CLI reported error: ${cliResult.result ?? JSON.stringify(cliResult)}`);
    }
    const structured = cliResult.structured_output;
    if (structured === undefined) {
      throw new Error(`[shell-claude-cli] CLI did not emit structured_output. Result: ${cliResult.result}`);
    }
    const parsed = params.schema.safeParse(structured);
    if (!parsed.success) {
      throw new Error(
        `[shell-claude-cli] schema validation failed: ${parsed.error.message}. Structured: ${JSON.stringify(structured).slice(0, 500)}`,
      );
    }
    return parsed.data;
  }

  private spawnCli(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`[shell-claude-cli] timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`[shell-claude-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[shell-claude-cli] spawn failed: ${err.message}`));
      });
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

export function probeShellClaudeCliAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: { bin?: string; timeoutMs?: number } = {},
): ShellClaudeCliAvailability {
  const bin = options.bin?.trim() || env.KYBERION_CLAUDE_CLI_BIN?.trim() || 'claude';
  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const result = spawnSync(bin, ['-p', 'Return the word ok.', '--output-format', 'json', '--model', 'opus'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
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

export function buildShellClaudeCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  probe: (env: NodeJS.ProcessEnv) => ShellClaudeCliAvailability = probeShellClaudeCliAvailability,
): ShellClaudeCliBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[shell-claude-cli] backend unavailable (bin=${env.KYBERION_CLAUDE_CLI_BIN?.trim() || 'claude'}): ${availability.reason ?? 'failed health check'}`,
    );
    return null;
  }

  const bin = env.KYBERION_CLAUDE_CLI_BIN?.trim();
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
    `[shell-claude-cli] backend ready (bin=${bin ?? 'claude'}, model=${model ?? 'opus'})`,
  );
  return backend;
}
