import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { readTextFile } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeReaddir,
  safeWriteFile,
  validateUrl,
} from './secure-io.js';
import { redactSensitiveObject } from './network.js';
import { advanceToolLoopGuardrail, createToolLoopGuardrailState } from './tool-loop-guardrail.js';
import {
  resolveOpenRouterModelPolicy,
  validateOpenRouterModelRecord,
  type OpenRouterModelRecord,
} from './openrouter-model-policy.js';
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
import { runStructuredReasoningOp, structuredReasoningSpecs } from './structured-reasoning.js';
import { assertReasoningEgressAllowedAtEndpoint } from './reasoning-egress-scope.js';
import type { ReasoningToolName } from './reasoning-route-resolver.js';

export interface OpenRouterBackendOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  toolsEnabled?: boolean;
  allowedTools?: ReasoningToolName[];
}

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

export interface OpenRouterBackendOverrides {
  toolsEnabled?: boolean;
  allowedTools?: ReasoningToolName[];
}

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: 'auto' | 'none';
}

interface ChatCompletionResponse {
  choices: Array<{
    message: ChatMessage;
  }>;
  error?: {
    message?: string;
  };
}

function normalizeBaseUrl(baseURL: string): string {
  const trimmed = baseURL.trim();
  if (!trimmed) throw new Error('Missing baseURL for OpenRouter backend');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function joinEndpoint(baseURL: string, suffix: string): string {
  const url = new URL(suffix.replace(/^\//, ''), normalizeBaseUrl(baseURL));
  return url.toString();
}

function buildAbortSignal(timeoutMs: number): AbortSignal | undefined {
  if (!globalThis.AbortController) return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return String(content);
}

function createToolDefinitions(
  allowedTools: ReadonlySet<ReasoningToolName>
): ChatCompletionRequest['tools'] {
  const definitions: NonNullable<ChatCompletionRequest['tools']> = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file within the Kyberion workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path from project root' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write or overwrite a file in the Kyberion workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path from project root' },
            content: { type: 'string', description: 'String content to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List the contents of a directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path from project root' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'shell_exec',
        description: 'Execute a shell command within the governed workspace.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command' },
          },
          required: ['command'],
        },
      },
    },
  ];
  return definitions.filter((tool) => allowedTools.has(tool.function.name as ReasoningToolName));
}

function safeJsonParse(text: string): unknown {
  try {
    return parseSafeJsonInput(text, 'OpenRouter response');
  } catch {
    return null;
  }
}

function parseChatMessage(value: unknown, label: string): ChatMessage | null {
  try {
    const record = parseSafeJsonObjectValue(value, label);
    if (
      record.role !== 'system' &&
      record.role !== 'user' &&
      record.role !== 'assistant' &&
      record.role !== 'tool'
    ) {
      return null;
    }
    if (
      record.content !== undefined &&
      record.content !== null &&
      typeof record.content !== 'string'
    ) {
      return null;
    }
    if (record.tool_call_id !== undefined && typeof record.tool_call_id !== 'string') return null;
    let toolCalls: ChatMessage['tool_calls'];
    if (record.tool_calls !== undefined) {
      if (!Array.isArray(record.tool_calls)) return null;
      toolCalls = [];
      for (const [index, rawCall] of record.tool_calls.entries()) {
        const call = parseSafeJsonObjectValue(rawCall, `${label}.tool_calls[${index}]`);
        const fn = parseSafeJsonObjectValue(
          call.function,
          `${label}.tool_calls[${index}].function`
        );
        if (
          typeof call.id !== 'string' ||
          call.type !== 'function' ||
          typeof fn.name !== 'string' ||
          typeof fn.arguments !== 'string'
        ) {
          return null;
        }
        toolCalls.push({
          id: call.id,
          type: 'function',
          function: { name: fn.name, arguments: fn.arguments },
        });
      }
    }
    return {
      role: record.role,
      ...(record.content !== undefined ? { content: record.content as string | null } : {}),
      ...(typeof record.tool_call_id === 'string' ? { tool_call_id: record.tool_call_id } : {}),
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
    };
  } catch {
    return null;
  }
}

function parseChatCompletionPayload(value: unknown): ChatCompletionResponse | null {
  try {
    const root = parseSafeJsonObjectValue(value, 'OpenRouter response');
    let error: ChatCompletionResponse['error'];
    if (root.error !== undefined) {
      const parsedError = parseSafeJsonObjectValue(root.error, 'OpenRouter response.error');
      if (parsedError.message !== undefined && typeof parsedError.message !== 'string') return null;
      error = {
        ...(typeof parsedError.message === 'string' ? { message: parsedError.message } : {}),
      };
    }
    if (root.choices === undefined) return error ? { choices: [], error } : null;
    if (!Array.isArray(root.choices)) return null;
    const choices: ChatCompletionResponse['choices'] = [];
    for (const [index, rawChoice] of root.choices.entries()) {
      const choice = parseSafeJsonObjectValue(rawChoice, `OpenRouter response.choices[${index}]`);
      const message = parseChatMessage(
        choice.message,
        `OpenRouter response.choices[${index}].message`
      );
      if (!message) return null;
      choices.push({ message });
    }
    return { choices, ...(error ? { error } : {}) };
  } catch {
    return null;
  }
}

function parseOpenRouterModelRecord(value: unknown): OpenRouterModelRecord | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'OpenRouter model record');
    if (
      (record.id !== undefined && typeof record.id !== 'string') ||
      (record.canonical_slug !== undefined && typeof record.canonical_slug !== 'string')
    ) {
      return null;
    }
    let pricing: OpenRouterModelRecord['pricing'];
    if (record.pricing !== undefined) {
      const parsedPricing = parseSafeJsonObjectValue(record.pricing, 'OpenRouter model pricing');
      if (
        Object.values(parsedPricing).some(
          (value) =>
            value !== null &&
            value !== undefined &&
            typeof value !== 'string' &&
            typeof value !== 'number'
        )
      ) {
        return null;
      }
      pricing = parsedPricing as OpenRouterModelRecord['pricing'];
    }
    let supportedParameters: string[] | undefined;
    if (record.supported_parameters !== undefined) {
      if (
        !Array.isArray(record.supported_parameters) ||
        record.supported_parameters.some((parameter) => typeof parameter !== 'string')
      ) {
        return null;
      }
      supportedParameters = record.supported_parameters;
    }
    return {
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.canonical_slug === 'string'
        ? { canonical_slug: record.canonical_slug }
        : {}),
      ...(pricing ? { pricing } : {}),
      ...(supportedParameters ? { supported_parameters: supportedParameters } : {}),
    };
  } catch {
    return null;
  }
}

export class OpenRouterBackend implements ReasoningBackend {
  readonly name = 'openrouter';
  readonly egressEndpoint: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly toolsEnabled: boolean;
  private readonly allowedTools: ReadonlySet<ReasoningToolName>;

  constructor(options: OpenRouterBackendOptions) {
    this.baseURL = normalizeBaseUrl(options.baseURL || 'https://openrouter.ai/api/v1');
    validateUrl(this.baseURL);
    this.egressEndpoint = this.baseURL;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.toolsEnabled = options.toolsEnabled === true;
    this.allowedTools = new Set(options.allowedTools ?? []);
  }

  getModel(): string {
    return this.model;
  }

  private async fetchChatCompletion(
    messages: ChatMessage[],
    opts: { useTools?: boolean } = {}
  ): Promise<ChatCompletionResponse> {
    assertReasoningEgressAllowedAtEndpoint(this.name, this.baseURL);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/famaoai-creator/kyberion',
      'X-Title': 'Kyberion',
    };

    const body: ChatCompletionRequest = {
      model: this.model,
      messages: redactSensitiveObject(messages),
      ...((opts.useTools ?? this.toolsEnabled) && this.allowedTools.size > 0
        ? { tools: createToolDefinitions(this.allowedTools), tool_choice: 'auto' }
        : {}),
    };

    const response = await fetch(joinEndpoint(this.baseURL, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: buildAbortSignal(this.timeoutMs),
    });

    const text = await response.text();
    const parsed = parseChatCompletionPayload(safeJsonParse(text));
    if (!response.ok) {
      const message = parsed?.error?.message || text || `HTTP ${response.status}`;
      throw new Error(`[openrouter] chat completion failed: ${message}`);
    }
    if (!parsed || !parsed.choices || parsed.choices.length === 0) {
      throw new Error(`[openrouter] invalid chat completion response: ${text.slice(0, 500)}`);
    }
    return parsed;
  }

  private async handleToolCall(name: string, rawArguments: string): Promise<string> {
    if (!this.toolsEnabled || !this.allowedTools.has(name as ReasoningToolName)) {
      return `Error: Tool ${name} is not enabled for this reasoning route.`;
    }
    let args: Record<string, unknown>;
    try {
      args = parseSafeJsonObjectValue(safeJsonParse(rawArguments), 'OpenRouter tool arguments');
    } catch {
      return 'Error: OpenRouter tool arguments must be a JSON object.';
    }
    logger.info(`[OPENROUTER] Tool Call: ${name}(${JSON.stringify(redactSensitiveObject(args))})`);

    try {
      switch (name) {
        case 'read_file':
          return readTextFile(assertSafeRepositoryPath(String(args.path ?? '')));
        case 'write_file': {
          const filePath = assertSafeRepositoryPath(String(args.path ?? ''), {
            allowMissingLeaf: true,
          });
          safeWriteFile(filePath, String(args.content ?? ''), {
            mkdir: true,
            encoding: 'utf8',
          });
          return 'Success: File written.';
        }
        case 'list_directory':
          return JSON.stringify(safeReaddir(assertSafeRepositoryPath(String(args.path ?? ''))));
        case 'shell_exec':
          return safeExec('bash', ['-lc', String(args.command ?? '')], {
            cwd: pathResolver.rootDir(),
          });
        default:
          return `Error: Unknown tool ${name}`;
      }
    } catch (err: any) {
      return `Error: ${err?.message ?? String(err)}`;
    }
  }

  async prompt(prompt: string, context?: unknown): Promise<string> {
    const redactedContext = context === undefined ? undefined : redactSensitiveObject(context);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are Kyberion. Use the provided tools for workspace file operations. ' +
          'Prefer governed, minimal edits and explain the reasoning when useful.',
      },
      {
        role: 'user',
        content: [
          prompt,
          redactedContext
            ? `Context:\n${typeof redactedContext === 'string' ? redactedContext : JSON.stringify(redactedContext, null, 2)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ];

    let response = await this.fetchChatCompletion(messages);
    let message = response.choices[0].message;
    let guardrailState = createToolLoopGuardrailState();

    while (message.tool_calls && message.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: extractTextContent(message.content),
        tool_calls: message.tool_calls,
      });
      for (const toolCall of message.tool_calls) {
        const guardrailDecision = advanceToolLoopGuardrail(guardrailState, {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
        guardrailState = guardrailDecision.state;
        if (guardrailDecision.shouldStop) {
          logger.warn(`[OPENROUTER] Tool loop guardrail triggered: ${guardrailDecision.reason}`);
          return `${extractTextContent(message.content)}\n\n${guardrailDecision.reason}`.trim();
        }
        const result = await this.handleToolCall(
          toolCall.function.name,
          toolCall.function.arguments
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
      response = await this.fetchChatCompletion(messages);
      message = response.choices[0].message;
    }

    return extractTextContent(message.content);
  }

  /** Single toolless completion returning raw model text — used for structured reasoning. */
  private async completeStructured(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.fetchChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { useTools: false }
    );
    return extractTextContent(response.choices[0].message.content);
  }

  private readonly runStructured = (systemPrompt: string, userPrompt: string) =>
    this.completeStructured(systemPrompt, userPrompt);

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.divergePersonas,
      input,
      this.runStructured
    );
  }

  async crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.crossCritique,
      input,
      this.runStructured
    );
  }

  async synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.synthesizePersona,
      input,
      this.runStructured
    );
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.forkBranches,
      input,
      this.runStructured
    );
  }

  async simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.simulateBranches,
      input,
      this.runStructured
    );
  }

  async extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.extractRequirements,
      input,
      this.runStructured
    );
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.extractDesignSpec,
      input,
      this.runStructured
    );
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.extractTestPlan,
      input,
      this.runStructured
    );
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    return runStructuredReasoningOp(
      structuredReasoningSpecs.decomposeIntoTasks,
      input,
      this.runStructured
    );
  }

  async delegateTask(instruction: string, context?: string): Promise<string> {
    return this.prompt(`Task: ${instruction}\nContext: ${context ?? 'none'}`);
  }
}

export function buildOpenRouterBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
  overrides: OpenRouterBackendOverrides = {}
): OpenRouterBackend | null {
  const apiKey =
    envText(env, 'KYBERION_OPENROUTER_KEY')?.trim() || envText(env, 'OPENROUTER_API_KEY')?.trim();
  if (!apiKey) return null;
  const model = resolveOpenRouterModelPolicy(env, modelOverride).model;
  const baseURL = envText(env, 'KYBERION_OPENROUTER_URL')?.trim();
  return new OpenRouterBackend({ apiKey, model, baseURL, ...overrides });
}

/** Probe OpenRouter without consuming model tokens. */
export async function probeOpenRouterBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ available: boolean; reason?: string }> {
  const apiKey =
    envText(env, 'KYBERION_OPENROUTER_KEY')?.trim() || envText(env, 'OPENROUTER_API_KEY')?.trim();
  if (!apiKey) {
    return {
      available: false,
      reason: 'OPENROUTER_API_KEY or KYBERION_OPENROUTER_KEY is not set',
    };
  }

  const baseURL = envText(env, 'KYBERION_OPENROUTER_URL')?.trim() || 'https://openrouter.ai/api/v1';
  try {
    const normalizedBaseURL = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
    const modelsURL = new URL('models', normalizedBaseURL);
    if (modelsURL.protocol !== 'https:' && modelsURL.protocol !== 'http:') {
      return {
        available: false,
        reason: `unsupported OpenRouter URL protocol: ${modelsURL.protocol}`,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(modelsURL, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { available: false, reason: `OpenRouter probe returned HTTP ${response.status}` };
      }
      const body = parseSafeJsonObjectValue(
        safeJsonParse(await response.text()),
        'OpenRouter models response'
      );
      if (!Array.isArray(body.data)) {
        return { available: false, reason: 'OpenRouter probe returned an invalid models response' };
      }
      const modelPolicy = resolveOpenRouterModelPolicy(env);
      const modelRecord = body.data
        .map(parseOpenRouterModelRecord)
        .find(
          (record) =>
            record?.id === modelPolicy.model || record?.canonical_slug === modelPolicy.model
        );
      if (!modelRecord) {
        return {
          available: false,
          reason: `OpenRouter model is unavailable: ${modelPolicy.model}`,
        };
      }
      const failures = validateOpenRouterModelRecord(modelRecord, modelPolicy);
      if (failures.length > 0) {
        return { available: false, reason: failures.join('; ') };
      }
      return { available: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
