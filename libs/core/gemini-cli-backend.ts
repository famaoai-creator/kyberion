/**
 * Gemini CLI Backend — spawns the local `gemini` CLI in `-p -o json -y`
 * mode to run structured-output reasoning tasks.
 */

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

export interface GeminiCliBackendOptions {
  /** CLI binary. Defaults to `gemini` (resolved via PATH). */
  bin?: string;
  /** Model alias. Defaults to 'gemini-2.0-flash-exp'. */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Additional CLI args to inject. */
  extraArgs?: string[];
}

export class GeminiCliBackend implements ReasoningBackend {
  readonly name = 'gemini-cli';
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: GeminiCliBackendOptions = {}) {
    this.bin = options.bin ?? 'gemini';
    this.model = options.model ?? '';
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
        'You MUST return a JSON object with EXACTLY this key:',
        '  hypotheses: array of { id: string, proposed_by: string, content: string, status: "pending"|"survived"|"rejected" }',
        `Each persona (${input.personas.join(', ')}) must contribute at least ${input.minPerPersona ?? 2} hypotheses.`,
        'Return ONLY the JSON object. No markdown fences, no extra text.',
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
        'You MUST return a JSON object with EXACTLY this key:',
        '  hypotheses: array of { id, persona, hypothesis, critiques: [{ persona, content, verdict }], final_score }',
        'Return ONLY the JSON object. No markdown fences, no extra text.',
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
      systemPrompt: 'Synthesize a counterparty persona. Output JSON ONLY.',
      userPrompt: JSON.stringify(input.relationshipNode),
      schema,
    });
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    const schema = z.object({
      branches: z.array(z.any()),
    });
    const result = await this.runStructured({
      systemPrompt: 'Fork short-horizon branches. Output JSON ONLY.',
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
      systemPrompt: 'Simulate branch execution. Output JSON ONLY.',
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
        'You MUST return a JSON object with EXACTLY these keys (all required, all arrays):',
        '  functional_requirements: array of { id, title, description, priority, source }',
        '  non_functional_requirements: array of { id, title, description, category }',
        '  constraints: array of { id, description }',
      '  assumptions: array of { id, description }',
      '  open_questions: array of { id, question }',
      'Set open_questions[].blocking=true only when the unanswered item blocks the current MVP; otherwise omit it or set it false.',
      'Do not convert interviewer follow-up questions into open questions unless the customer explicitly says the detail is unknown or blocking.',
      'Return ONLY the JSON object. No markdown fences, no extra text.',
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
      trade_offs: z.array(z.any()),
      risks: z.array(z.any()),
      open_decisions: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt: 'Derive architectural design spec. Output JSON ONLY.',
      userPrompt: JSON.stringify(input.requirementsDraft),
      schema,
    })) as ExtractedDesignSpec;
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    const schema = z.object({
      app_id: z.string(),
      cases: z.array(z.any()),
    });
    return (await this.runStructured({
      systemPrompt: 'Derive test plan. Output JSON ONLY.',
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
      systemPrompt: 'Decompose into task plan. Output JSON ONLY.',
      userPrompt: JSON.stringify(input.requirementsDraft),
      schema,
    })) as DecomposedTaskPlan;
  }

  async delegateTask(instruction: string, context?: string): Promise<string> {
    const args = [
      '-p',
      `${instruction}\n\nContext: ${context ?? 'none'}`,
      '-y', // YOLO mode for autonomous task execution
      ...(this.model ? ['--model', this.model] : []),
      ...this.extraArgs,
    ];
    // For delegation, we don't necessarily want JSON format, we want it to just do the work.
    // However, the caller expects a string result (the report).
    const stdout = await this.spawnCli(args);
    const lines = stdout.split('\n');
    const jsonStartIdx = lines.findIndex(l => l.trim().startsWith('{'));
    if (jsonStartIdx === -1) {
      return stdout.trim(); // Fallback if no JSON envelope at all
    }
    const cleanStdout = lines.slice(jsonStartIdx).join('\n');
    try {
      const cliResult = JSON.parse(cleanStdout);
      return (cliResult.response || stdout).trim();
    } catch (_) {
      return stdout.trim();
    }
  }

  async prompt(prompt: string): Promise<string> {
    return this.runPrompt(prompt);
  }

  private async runStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
  }): Promise<T> {
    const args = [
      '-p',
      `${params.systemPrompt}\n\n${params.userPrompt}`,
      '-o',
      'json',
      ...(this.model ? ['--model', this.model] : []),
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args);
    
    // Extract only the JSON part from stdout (Gemini CLI might print "YOLO mode enabled" etc)
    const lines = stdout.split('\n');
    const jsonStartIdx = lines.findIndex(l => l.trim().startsWith('{'));
    if (jsonStartIdx === -1) {
      throw new Error(`[gemini-cli] could not find JSON in stdout: ${stdout}`);
    }
    const cleanStdout = lines.slice(jsonStartIdx).join('\n');

    let cliResult: any;
    try {
      cliResult = JSON.parse(cleanStdout);
    } catch (err: any) {
      throw new Error(`[gemini-cli] failed to parse CLI JSON output: ${err.message}. Raw: ${cleanStdout.slice(0, 500)}`);
    }

    const responseStr = cliResult.response;
    if (!responseStr) {
      throw new Error(`[gemini-cli] CLI result missing 'response' field: ${JSON.stringify(cliResult)}`);
    }

    // Attempt to extract JSON from the response string (it might be wrapped in ```json ... ```)
    const jsonMatch = responseStr.match(/```json\n([\s\S]*?)\n```/) || responseStr.match(/{[\s\S]*}/);
    const cleanJson = jsonMatch ? jsonMatch[1] || jsonMatch[0] : responseStr;

    try {
      const structured = JSON.parse(cleanJson);
      const parsed = params.schema.safeParse(structured);
      if (!parsed.success) {
        throw new Error(`[gemini-cli] schema validation failed: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (err: any) {
      throw new Error(`[gemini-cli] failed to parse inner JSON: ${err.message}. Raw response: ${responseStr.slice(0, 500)}`);
    }
  }

  private async runPrompt(prompt: string): Promise<string> {
    const args = [
      '-p',
      prompt,
      '-o',
      'json',
      ...(this.model ? ['--model', this.model] : []),
      ...this.extraArgs,
    ];

    const stdout = await this.spawnCli(args);
    const lines = stdout.split('\n');
    const jsonStartIdx = lines.findIndex((l) => l.trim().startsWith('{'));
    if (jsonStartIdx === -1) {
      return stdout.trim();
    }
    const cleanStdout = lines.slice(jsonStartIdx).join('\n');
    try {
      const cliResult = JSON.parse(cleanStdout);
      if (cliResult.error) {
        throw new Error(`[gemini-cli] CLI returned error: ${JSON.stringify(cliResult.error)}`);
      }
      const responseStr: string | undefined = cliResult.response;
      if (responseStr === undefined || responseStr === null) {
        throw new Error('[gemini-cli] CLI result missing "response" field');
      }
      return responseStr.trim() || stdout.trim();
    } catch (err: any) {
      if (err.message.startsWith('[gemini-cli]')) throw err;
      return stdout.trim();
    }
  }

  private spawnCli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`[gemini-cli] timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`[gemini-cli] CLI exited with code ${code}. stderr: ${stderr}`));
          return;
        }
        resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[gemini-cli] spawn failed: ${err.message}`));
      });
      child.stdin.end();
    });
  }
}

export function buildGeminiCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): GeminiCliBackend | null {
  const bin = env.KYBERION_GEMINI_CLI_BIN?.trim();
  const model = modelOverride || env.KYBERION_GEMINI_CLI_MODEL?.trim();
  const timeoutRaw = env.KYBERION_GEMINI_CLI_TIMEOUT?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const backend = new GeminiCliBackend({
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !isNaN(timeoutMs) ? { timeoutMs } : {}),
  });
  logger.info(`[gemini-cli] backend ready (bin=${bin ?? 'gemini'}, model=${model ?? 'gemini-2.0-flash-exp'})`);
  return backend;
}

export async function runGeminiCliQuery<T>(params: {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  options?: GeminiCliBackendOptions;
}): Promise<T> {
  const backendOptions = params.options || {};
  const bin = backendOptions.bin ?? 'gemini';
  const model = backendOptions.model ?? '';
  const timeoutMs = backendOptions.timeoutMs ?? 5 * 60 * 1000;
  const extraArgs = backendOptions.extraArgs ?? [];

  const args = [
    '-p',
    `${params.systemPrompt}\n\n${params.userPrompt}`,
    '-o',
    'json',
    '-y',
    ...(model ? ['--model', model] : []),
    ...extraArgs,
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeExecEnv(),
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`[gemini-cli] timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk.toString()));
    child.stderr.on('data', (chunk) => (err += chunk.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`[gemini-cli] CLI exited with code ${code}. stderr: ${err}`));
        return;
      }
      resolve(out);
    });
    child.on('error', (spawnErr) => {
      clearTimeout(timer);
      reject(new Error(`[gemini-cli] spawn failed: ${(spawnErr as Error).message}`));
    });
    child.stdin.end();
  });

  const lines = stdout.split('\n');
  const jsonStartIdx = lines.findIndex((l) => l.trim().startsWith('{'));
  if (jsonStartIdx === -1) {
    throw new Error(`[gemini-cli] could not find JSON in stdout: ${stdout}`);
  }
  const cleanStdout = lines.slice(jsonStartIdx).join('\n');
  const cliResult = JSON.parse(cleanStdout);
  const responseStr = cliResult.response;
  if (!responseStr) {
    throw new Error(`[gemini-cli] CLI result missing 'response' field: ${JSON.stringify(cliResult)}`);
  }
  const jsonMatch = responseStr.match(/```json\n([\s\S]*?)\n```/) || responseStr.match(/{[\s\S]*}/);
  const cleanJson = jsonMatch ? jsonMatch[1] || jsonMatch[0] : responseStr;
  const structured = JSON.parse(cleanJson);
  const parsed = params.schema.safeParse(structured);
  if (!parsed.success) {
    throw new Error(`[gemini-cli] schema validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}
