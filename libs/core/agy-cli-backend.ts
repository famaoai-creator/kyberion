import { spawn } from 'node:child_process';
import { z, type ZodType } from 'zod';
import { logger } from './core.js';
import { buildSafeExecEnv } from './secure-io.js';
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

export interface AgyCliBackendOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface RunAgyCliQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  options?: AgyCliBackendOptions;
}

export class AgyCliBackend implements ReasoningBackend {
  readonly name = 'agy-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: AgyCliBackendOptions = {}) {
    this.bin = options.bin ?? 'agy';
    this.model = options.model ?? 'agy';
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
  }

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
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
      systemPrompt: [
        'Generate divergent hypotheses from multiple personas independently.',
        'Return a JSON object with a single key: hypotheses.',
        `Each persona (${input.personas.join(', ')}) must contribute at least ${input.minPerPersona ?? 2} hypotheses.`,
        'Return ONLY JSON.',
      ].join('\n'),
      userPrompt: `Topic: ${input.topic}\nPersonas: ${input.personas.join(', ')}`,
      schema,
    });
    return result.hypotheses;
  }

  async crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    const schema = z.object({
      hypotheses: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt: [
        'Run a cross-critique pass on the provided hypotheses.',
        'Return a JSON object with a single key: hypotheses.',
        'Return ONLY JSON.',
      ].join('\n'),
      userPrompt: `Topic: ${input.topic}\nHypotheses: ${JSON.stringify(input.hypotheses)}`,
      schema,
    })) as CritiqueResult;
  }

  async synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    const schema = z.object({
      fidelity: z.enum(['low', 'medium', 'high']),
      identity: z.record(z.string(), z.any()),
      style_hints: z.record(z.string(), z.any()),
      ng_topics: z.array(z.string()),
      recent_history_summary: z.array(z.any()),
    });
    return this.runStructured({
      systemPrompt: 'Synthesize a counterparty persona. Return JSON only.',
      userPrompt: JSON.stringify(input.relationshipNode),
      schema,
    });
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    const schema = z.object({
      branches: z.array(z.any()),
    });
    const result = await this.runStructured({
      systemPrompt: 'Fork short-horizon branches. Return JSON only.',
      userPrompt: JSON.stringify(input.hypotheses),
      schema,
    });
    return result.branches;
  }

  async simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    const schema = z.object({
      branches: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt: 'Simulate branch execution. Return JSON only.',
      userPrompt: JSON.stringify(input.branches),
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
    });
    return (await this.runStructured({
      systemPrompt: [
        'Extract structured requirements from the provided text.',
        'Return a JSON object with the keys functional_requirements, non_functional_requirements, constraints, assumptions, open_questions.',
        'Return ONLY JSON.',
      ].join('\n'),
      userPrompt: input.sourceText,
      schema,
    })) as ExtractedRequirements;
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
      systemPrompt: 'Derive an architectural design spec from requirements. Return JSON only.',
      userPrompt: JSON.stringify(input.requirementsDraft),
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
      systemPrompt: 'Derive a test plan from requirements. Return JSON only.',
      userPrompt: JSON.stringify(input.requirementsDraft),
      schema,
    })) as ExtractedTestPlan;
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    const schema = z.object({
      strategy_summary: z.string().optional(),
      tasks: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt: 'Decompose requirements into an implementation task plan. Return JSON only.',
      userPrompt: JSON.stringify(input.requirementsDraft),
      schema,
    })) as DecomposedTaskPlan;
  }

  async delegateTask(instruction: string, context?: string): Promise<string> {
    return this.runPrompt([
      instruction,
      context ? `Context: ${context}` : '',
    ].filter(Boolean).join('\n\n'));
  }

  async prompt(prompt: string): Promise<string> {
    return this.delegateTask(prompt);
  }

  public async runStructured<T>(params: {
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
        `[agy-cli] failed to parse CLI JSON output: ${err?.message ?? err}. Raw: ${stdout.slice(0, 500)}`,
      );
    }
    if (cliResult.is_error) {
      throw new Error(`[agy-cli] CLI reported error: ${cliResult.result ?? JSON.stringify(cliResult)}`);
    }
    const structured = cliResult.structured_output;
    if (structured === undefined) {
      throw new Error(`[agy-cli] CLI did not emit structured_output. Result: ${cliResult.result}`);
    }
    const parsed = params.schema.safeParse(structured);
    if (!parsed.success) {
      throw new Error(
        `[agy-cli] schema validation failed: ${parsed.error.message}. Structured: ${JSON.stringify(structured).slice(0, 500)}`,
      );
    }
    return parsed.data;
  }

  private async runPrompt(prompt: string): Promise<string> {
    const args = [
      '-p',
      prompt,
      '-o',
      'json',
      '-y',
      '--dangerously-skip-permissions',
      '--model',
      this.model,
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args, '');
    const lines = stdout.split('\n');
    const jsonStartIdx = lines.findIndex((l) => l.trim().startsWith('{'));
    if (jsonStartIdx === -1) {
      return stdout.trim();
    }
    const cleanStdout = lines.slice(jsonStartIdx).join('\n');
    try {
      const cliResult = JSON.parse(cleanStdout);
      const responseStr: string | undefined = cliResult.response;
      if (responseStr === undefined || responseStr === null) {
        throw new Error('[agy-cli] CLI result missing "response" field');
      }
      return responseStr.trim() || stdout.trim();
    } catch (err: any) {
      if (err.message.startsWith('[agy-cli]')) throw err;
      return stdout.trim();
    }
  }

  private spawnCli(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeExecEnv(),
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`[agy-cli] timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`[agy-cli] CLI exited with code ${code}. stderr: ${stderr}`));
          return;
        }
        resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[agy-cli] spawn failed: ${err.message}`));
      });
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

export function buildAgyCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgyCliBackend | null {
  const bin = env.KYBERION_ANTIGRAVITY_CLI_BIN?.trim() || env.KYBERION_AGY_CLI_BIN?.trim();
  const model = env.KYBERION_AGY_CLI_MODEL?.trim();
  const timeoutRaw = env.KYBERION_AGY_CLI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const backend = new AgyCliBackend({
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
  });
  logger.info(`[agy-cli] backend ready (bin=${bin ?? 'agy'}, model=${model ?? 'agy'})`);
  return backend;
}

export async function runAgyCliQuery<T>(params: RunAgyCliQueryParams<T>): Promise<T> {
  const backendOptions = params.options || {};
  const backend = new AgyCliBackend(backendOptions);
  return backend.runStructured({ systemPrompt: params.systemPrompt, userPrompt: params.userPrompt, schema: params.schema });
}
