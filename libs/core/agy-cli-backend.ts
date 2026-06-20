import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { z, type ZodType } from 'zod';
import { logger } from './core.js';
import { buildSafeExecEnv } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
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
  sandbox?: boolean;
  logFile?: string;
}

export interface RunAgyCliQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  options?: AgyCliBackendOptions;
}

const PrioritySchema = z.enum(['must', 'should', 'could', 'wont']);

const SourceRefSchema = z.object({
  ref: z.string().optional(),
  quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const OptionalArraySchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.preprocess(
    (value) => (value === null ? undefined : value),
    z.array(itemSchema).optional(),
  );

const OptionalSchema = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

const FunctionalRequirementSchema = z.object({
  id: z.string().regex(/^FR-[0-9A-Z]+$/u),
  description: z.string().min(1),
  priority: PrioritySchema,
  acceptance_criteria: OptionalArraySchema(z.string()),
  source_refs: OptionalArraySchema(SourceRefSchema),
  depends_on: OptionalArraySchema(z.string()),
});

const NonFunctionalRequirementSchema = z.object({
  id: z.string().regex(/^NFR-[0-9A-Z]+$/u),
  category: z.enum([
    'performance',
    'security',
    'availability',
    'usability',
    'compatibility',
    'maintainability',
    'compliance',
    'cost',
    'other',
  ]),
  description: z.string().min(1),
  target: OptionalSchema(z.string()),
  priority: OptionalSchema(PrioritySchema),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const ConstraintSchema = z.object({
  category: z.enum(['budget', 'timeline', 'technical', 'legal', 'organizational', 'other']),
  description: z.string(),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const AssumptionSchema = z.object({
  description: z.string(),
  confidence: OptionalSchema(z.enum(['low', 'medium', 'high'])),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const OpenQuestionSchema = z.object({
  question: z.string(),
  raised_by: OptionalSchema(z.string()),
  status: OptionalSchema(z.enum(['open', 'answered', 'deferred'])),
  blocking: OptionalSchema(z.boolean()),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const ExtractedRequirementsSchema = z.object({
  functional_requirements: z.array(FunctionalRequirementSchema).min(1),
  non_functional_requirements: z.array(NonFunctionalRequirementSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),
  assumptions: z.array(AssumptionSchema).default([]),
  open_questions: z.array(OpenQuestionSchema).default([]),
  scope: z
    .object({
      in_scope: z.array(z.string()).default([]),
      out_of_scope: z.array(z.string()).default([]),
    })
    .optional(),
});

export class AgyCliBackend implements ReasoningBackend {
  readonly name = 'agy-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly sandbox: boolean;
  private readonly logFile: string;

  constructor(options: AgyCliBackendOptions = {}) {
    this.bin = options.bin ?? 'agy';
    this.model = options.model ?? 'agy';
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
    this.sandbox = options.sandbox ?? process.env.KYBERION_AGY_SANDBOX !== '0';
    this.logFile = options.logFile ?? path.join(
      pathResolver.sharedTmp(),
      `agy-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
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
      hypotheses: z.array(
        z.object({
          id: z.string(),
          proposed_by: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'survived', 'rejected']),
          survived: z.boolean(),
          rejection_reason: OptionalSchema(z.string()),
          critiques: z.array(z.object({ by: z.string(), content: z.string() })).optional(),
        }),
      ),
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
    return (await this.runStructured({
      systemPrompt: [
        'Extract a structured requirements draft from the source text.',
        'Use the source transcript to derive concrete requirements, but keep open_questions extremely sparse.',
        'Only emit open_questions when the answer is required to define the current MVP and cannot be inferred from the transcript.',
        'Questions about future phases, implementation preferences, vendor selection, or tuning details should become assumptions or deferred items, not open blockers.',
        'Prefer status="deferred" over status="open" whenever the core scope can proceed without the answer.',
        'When an open question is genuinely blocking the MVP, set blocking=true; otherwise leave it false or omit it.',
        'Do not convert the interviewer/Kyberion follow-up questions into open_questions unless the customer explicitly says the detail is unknown or blocking.',
        'Return ONLY JSON.',
      ].join('\n'),
      userPrompt: input.sourceText,
      schema: ExtractedRequirementsSchema,
    })) as ExtractedRequirements;
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    const schema = z.object({
      architecture_summary: OptionalSchema(z.string()),
      components: z.array(z.any()),
      data_flows: z.array(z.any()).default([]),
      cross_cutting_concerns: OptionalSchema(z.record(z.string(), z.string())),
      trade_offs: z.array(z.any()).default([]),
      risks: z.array(z.any()).default([]),
      open_decisions: z.array(z.any()).default([]),
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
      coverage_strategy: OptionalSchema(z.string()),
    });
    return (await this.runStructured({
      systemPrompt: 'Derive a test plan from requirements. Return JSON only.',
      userPrompt: JSON.stringify(input.requirementsDraft),
      schema,
    })) as ExtractedTestPlan;
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    const schema = z.object({
      strategy_summary: OptionalSchema(z.string()),
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

    const prompt = [
      params.systemPrompt.trim(),
      '',
      'Return exactly one JSON object that matches the schema below.',
      'Do not wrap the JSON in markdown fences.',
      'Do not include commentary, code fences, or extra keys.',
      '',
      'Schema:',
      JSON.stringify(jsonSchema, null, 2),
      '',
      'User input:',
      params.userPrompt.trim(),
    ].join('\n');

    const args = [
      '--log-file',
      this.logFile,
      '--model',
      this.model,
      ...(this.sandbox ? ['--sandbox'] : []),
      '--dangerously-skip-permissions',
      '-p',
      prompt,
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args);
    let cliResult: any;
    try {
      cliResult = JSON.parse(extractJsonPayload(stdout));
    } catch (err: any) {
      throw new Error(
        `[agy-cli] failed to parse CLI JSON output: ${err?.message ?? err}. Raw: ${stdout.slice(0, 500)}`,
      );
    }
    if (cliResult.is_error) {
      throw new Error(`[agy-cli] CLI reported error: ${cliResult.result ?? JSON.stringify(cliResult)}`);
    }
    const structured = cliResult.structured_output ?? cliResult.response ?? cliResult;
    if (structured === undefined || structured === null) {
      throw new Error(`[agy-cli] CLI did not emit structured output. Result: ${cliResult.result ?? stdout.slice(0, 500)}`);
    }
    let structuredValue: unknown = structured;
    if (typeof structured === 'string') {
      try {
        structuredValue = JSON.parse(extractJsonPayload(structured));
      } catch (err: any) {
        throw new Error(
          `[agy-cli] structured output was not valid JSON: ${err?.message ?? String(err)}. Structured: ${structured.slice(0, 500)}`,
        );
      }
    }
    const parsed = params.schema.safeParse(structuredValue);
    if (!parsed.success) {
      throw new Error(
        `[agy-cli] schema validation failed: ${parsed.error.message}. Structured: ${JSON.stringify(structured).slice(0, 500)}`,
      );
    }
    return parsed.data;
  }

  private async runPrompt(prompt: string): Promise<string> {
    const args = [
      '--log-file',
      this.logFile,
      '--model',
      this.model,
      ...(this.sandbox ? ['--sandbox'] : []),
      '--dangerously-skip-permissions',
      '-p',
      prompt,
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args);
    try {
      const cliResult = JSON.parse(extractJsonPayload(stdout));
      const responseStr: string | undefined = cliResult.response;
      if (responseStr === undefined || responseStr === null) {
        return stdout.trim();
      }
      return responseStr.trim() || stdout.trim();
    } catch (err: any) {
      if (err.message.startsWith('[agy-cli]')) throw err;
      return stdout.trim();
    }
  }

  private spawnCli(args: string[]): Promise<string> {
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
  const sandbox = env.KYBERION_AGY_SANDBOX?.trim();
  const sandboxEnabled = sandbox === undefined ? undefined : sandbox !== '0';
  const logFile = env.KYBERION_AGY_CLI_LOG_FILE?.trim();
  const backend = new AgyCliBackend({
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(sandboxEnabled !== undefined ? { sandbox: sandboxEnabled } : {}),
    ...(logFile ? { logFile } : {}),
  });
  logger.info(`[agy-cli] backend ready (bin=${bin ?? 'agy'}, model=${model ?? 'agy'})`);
  return backend;
}

export async function runAgyCliQuery<T>(params: RunAgyCliQueryParams<T>): Promise<T> {
  const backendOptions = params.options || {};
  const backend = new AgyCliBackend(backendOptions);
  return backend.runStructured({ systemPrompt: params.systemPrompt, userPrompt: params.userPrompt, schema: params.schema });
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/u) || trimmed.match(/```\s*([\s\S]*?)```/u);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}
