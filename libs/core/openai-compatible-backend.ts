import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExec, safeReadFile, safeReaddir, safeWriteFile, validateUrl } from './secure-io.js';
import { redactSensitiveObject } from './network.js';
import { advanceToolLoopGuardrail, createToolLoopGuardrailState } from './tool-loop-guardrail.js';
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
import {
  computeCompletionTokenBudget,
  estimateRequestInputTokens,
  resolveConfiguredContextWindowTokens,
} from './completion-token-budget.js';
import { StablePrefixGuard, type StablePrefixSnapshot } from './prompt-cache-discipline.js';
import type { ReasoningToolName, SamplingParams } from './reasoning-route-resolver.js';

export type LocalLlmProviderPreset =
  | 'generic'
  | 'ollama'
  | 'vllm'
  | 'lmstudio'
  | 'llamacpp'
  | 'mlx'
  | 'localai';

export interface OpenAiCompatibleBackendOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  providerPreset?: LocalLlmProviderPreset;
  endpointPolicy?: 'local' | 'public';
  toolsEnabled?: boolean;
  allowedTools?: ReasoningToolName[];
  timeoutMs?: number;
  /** KC-09: model context window in tokens; unset = unknown → no max_tokens sent. */
  contextWindowTokens?: number;
  /** KC-09: upper bound for the per-request completion budget. */
  maxCompletionTokens?: number;
  /** Provider-normalized sampling parameters. Unsupported values are rejected by the route resolver. */
  samplingParams?: SamplingParams;
}

export interface OpenAiCompatibleBackendAvailability {
  available: boolean;
  reason?: string;
}

export interface OpenAiCompatibleBackendEnvNames {
  baseURL: string[];
  apiKey: string[];
  model: string[];
  defaultModel: string;
  unavailableReason: string;
  probeLabel: string;
  providerPreset?: LocalLlmProviderPreset;
  endpointPolicy: 'local' | 'public';
}

export interface OpenAiCompatibleBackendOverrides {
  model?: string;
  samplingParams?: SamplingParams;
  contextWindowTokens?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
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
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string | string[];
}

interface ChatCompletionResponse {
  choices: Array<{
    message: ChatMessage;
  }>;
  error?: {
    message?: string;
  };
}

function normalizeBaseUrl(baseURL: string, providerPreset?: LocalLlmProviderPreset): string {
  let trimmed = baseURL.trim();
  if (!trimmed) throw new Error('Missing baseURL for OpenAI-compatible backend');
  if (
    providerPreset === 'ollama' &&
    !trimmed.endsWith('/v1') &&
    !trimmed.endsWith('/v1/') &&
    (trimmed.includes(':11434') || trimmed.endsWith('/api'))
  ) {
    trimmed = trimmed.replace(/\/api\/?$/, '');
    trimmed = `${trimmed}/v1`;
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function resolveDefaultContextWindowForPreset(preset?: LocalLlmProviderPreset): number | undefined {
  // A runtime preset does not identify the loaded model or its tokenizer.
  // Context defaults belong to the model registry or an explicit operator
  // setting; guessing here silently creates truncation/overflow bugs.
  void preset;
  return undefined;
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1'
  ) {
    return true;
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(normalized)) return true;
  if (/^\[::ffff:127\./.test(normalized)) return true;
  return false;
}

function assertLocalCompatibleEndpoint(baseURL: string): URL {
  const url = new URL(normalizeBaseUrl(baseURL));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported local LLM protocol: ${url.protocol}`);
  }
  if (!isLocalHost(url.hostname)) {
    throw new Error(
      `Local LLM endpoint must resolve to localhost or a private address: ${url.hostname}`
    );
  }
  return url;
}

function assertHttpEndpoint(baseURL: string): URL {
  const url = new URL(normalizeBaseUrl(baseURL));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported OpenAI-compatible protocol: ${url.protocol}`);
  }
  return url;
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
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstConfiguredEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function buildBackendFromEnvNames(
  env: NodeJS.ProcessEnv,
  names: OpenAiCompatibleBackendEnvNames,
  overrides: OpenAiCompatibleBackendOverrides = {}
): OpenAiCompatibleBackend | null {
  const baseURL = firstConfiguredEnv(env, names.baseURL);
  if (!baseURL) return null;
  const apiKey = firstConfiguredEnv(env, names.apiKey) || 'not-needed';
  const model = overrides.model || firstConfiguredEnv(env, names.model) || names.defaultModel;
  return new OpenAiCompatibleBackend({
    baseURL,
    apiKey,
    model,
    providerPreset: names.providerPreset,
    endpointPolicy: names.endpointPolicy,
    samplingParams: overrides.samplingParams,
    contextWindowTokens: overrides.contextWindowTokens,
    maxCompletionTokens: overrides.maxCompletionTokens,
    timeoutMs: overrides.timeoutMs,
    toolsEnabled: overrides.toolsEnabled,
    allowedTools: overrides.allowedTools,
  });
}

async function probeBackendAvailabilityFromEnvNames(
  env: NodeJS.ProcessEnv,
  names: OpenAiCompatibleBackendEnvNames,
  options: { allowPublicEndpoint: boolean }
): Promise<OpenAiCompatibleBackendAvailability> {
  const baseURL = firstConfiguredEnv(env, names.baseURL);
  if (!baseURL) {
    return {
      available: false,
      reason: `${names.unavailableReason} is not set`,
    };
  }

  try {
    const url = options.allowPublicEndpoint
      ? assertHttpEndpoint(normalizeBaseUrl(baseURL, names.providerPreset))
      : assertLocalCompatibleEndpoint(normalizeBaseUrl(baseURL, names.providerPreset));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const headers: Record<string, string> = {};
      const apiKey = firstConfiguredEnv(env, names.apiKey);
      if (apiKey && apiKey !== 'not-needed') {
        headers.authorization = `Bearer ${apiKey}`;
      }
      const response = await fetch(new URL('models', url).toString(), {
        method: 'GET',
        signal: controller.signal,
        headers,
      });
      if (!response.ok) {
        return {
          available: false,
          reason: `${names.probeLabel} probe returned HTTP ${response.status}`,
        };
      }
      return { available: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    return { available: false, reason: err?.message ?? String(err) };
  }
}

/**
 * KD-08: this backend never edits `messages[0]` (the fixed system message) or
 * recomputes `tools` from anything but constructor-level state, so the
 * stable-prefix invariant already holds by construction; `StablePrefixGuard`
 * in `prompt()` only makes that invariant an assertion instead of an
 * assumption. Note also this class does not attempt any mid-history rewrite
 * of earlier turns (kimi-code's rejected "micro-compaction" — see
 * prompt-cache-discipline.ts) — the only history-shrinking path is OH-01's
 * boundary compaction in `worker-context-compaction.ts`.
 */
export class OpenAiCompatibleBackend implements ReasoningBackend {
  readonly name = 'openai-compatible';
  readonly egressEndpoint: string;
  readonly providerPreset: LocalLlmProviderPreset;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly contextWindowTokens: number | undefined;
  private readonly maxCompletionTokens: number | undefined;
  private readonly samplingParams: SamplingParams;
  private readonly toolsEnabled: boolean;
  private readonly allowedTools: ReadonlySet<ReasoningToolName>;

  constructor(options: OpenAiCompatibleBackendOptions) {
    this.providerPreset = options.providerPreset ?? 'generic';
    const normalizedBaseURL = normalizeBaseUrl(options.baseURL, this.providerPreset);
    if ((options.endpointPolicy ?? 'local') === 'local')
      assertLocalCompatibleEndpoint(normalizedBaseURL);
    else validateUrl(normalizedBaseURL);
    this.baseURL = normalizedBaseURL;
    this.egressEndpoint = normalizedBaseURL;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.contextWindowTokens =
      options.contextWindowTokens ??
      resolveConfiguredContextWindowTokens() ??
      resolveDefaultContextWindowForPreset(this.providerPreset);
    this.maxCompletionTokens = options.maxCompletionTokens;
    this.samplingParams = { ...(options.samplingParams || {}) };
    this.toolsEnabled = options.toolsEnabled === true;
    this.allowedTools = new Set(options.allowedTools ?? []);
  }

  /**
   * KD-08: the (system message, tool allowlist) pair as sent by
   * `fetchChatCompletion` — the stable prefix a prompt cache keys on.
   * `messages[0]` is always this backend's fixed system message; tools are a
   * pure function of constructor-level state, so this is invariant across a
   * `prompt()` call's tool-loop iterations by construction. `StablePrefixGuard`
   * asserts that invariant on every iteration so a future change that starts
   * mutating either mid-loop fails fast instead of silently invalidating the
   * cache — see `prompt-cache-discipline.ts` for the full contract.
   */
  private stablePrefixSnapshot(messages: readonly ChatMessage[]): StablePrefixSnapshot {
    return {
      system: messages[0],
      tools: this.toolsEnabled && this.allowedTools.size > 0 ? [...this.allowedTools].sort() : null,
    };
  }

  /** KC-09: budget only when a window is explicitly configured — unknown window leaves the request untouched. */
  private completionBudget(body: ChatCompletionRequest): number | undefined {
    if (this.contextWindowTokens === undefined) return undefined;
    const budget = computeCompletionTokenBudget({
      contextWindowTokens: this.contextWindowTokens,
      estimatedInputTokens: estimateRequestInputTokens(body),
      configuredMaxTokens: this.maxCompletionTokens ?? this.contextWindowTokens,
    });
    if (budget < 1) {
      throw new Error(
        '[CONTEXT_LIMIT] No completion tokens remain after input estimate; compact the context and retry.'
      );
    }
    return budget;
  }

  private async fetchChatCompletion(
    messages: ChatMessage[],
    opts: { useTools?: boolean } = {}
  ): Promise<ChatCompletionResponse> {
    assertReasoningEgressAllowedAtEndpoint(this.name, this.baseURL);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey && this.apiKey !== 'not-needed') {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const body: ChatCompletionRequest = {
      model: this.model,
      messages: redactSensitiveObject(messages),
      ...((opts.useTools ?? this.toolsEnabled) && this.allowedTools.size > 0
        ? { tools: createToolDefinitions(this.allowedTools), tool_choice: 'auto' }
        : {}),
      ...this.samplingParams,
    };
    const maxTokens = this.completionBudget(body);
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const response = await fetch(joinEndpoint(this.baseURL, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: buildAbortSignal(this.timeoutMs),
    });

    const text = await response.text();
    const parsed = safeJsonParse(text) as ChatCompletionResponse | null;
    if (!response.ok) {
      const message = parsed?.error?.message || text || `HTTP ${response.status}`;
      throw new Error(`[openai-compatible] chat completion failed: ${message}`);
    }
    if (!parsed || !parsed.choices || parsed.choices.length === 0) {
      throw new Error(
        `[openai-compatible] invalid chat completion response: ${text.slice(0, 500)}`
      );
    }
    return parsed;
  }

  private async handleToolCall(name: string, rawArguments: string): Promise<string> {
    if (!this.toolsEnabled || !this.allowedTools.has(name as ReasoningToolName)) {
      return `Error: Tool ${name} is not enabled for this reasoning route.`;
    }
    const args = (safeJsonParse(rawArguments) as Record<string, unknown>) || {};
    logger.info(`[LOCAL_LLM] Tool Call: ${name}(${JSON.stringify(redactSensitiveObject(args))})`);

    try {
      switch (name) {
        case 'read_file':
          return String(safeReadFile(String(args.path ?? '')));
        case 'write_file':
          safeWriteFile(String(args.path ?? ''), String(args.content ?? ''), {
            mkdir: true,
            encoding: 'utf8',
          });
          return 'Success: File written.';
        case 'list_directory':
          return JSON.stringify(safeReaddir(String(args.path ?? '')));
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
    // KD-08: record the stable-prefix baseline for this turn before any tool
    // round trip, then re-assert it after every round trip completes — the
    // prefix must stay closed while a tool call is in flight (delayed
    // results grow the message array; they must never touch system/tools).
    const prefixGuard = new StablePrefixGuard();
    prefixGuard.assertStable(this.stablePrefixSnapshot(messages));

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
          logger.warn(`[LOCAL_LLM] Tool loop guardrail triggered: ${guardrailDecision.reason}`);
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
      prefixGuard.assertStable(this.stablePrefixSnapshot(messages));
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

const LOCAL_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'llama3',
  unavailableReason: 'KYBERION_LOCAL_LLM_URL',
  probeLabel: 'local LLM',
  providerPreset: 'generic',
  endpointPolicy: 'local',
};

const OLLAMA_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_OLLAMA_URL', 'OLLAMA_HOST', 'KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_OLLAMA_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_OLLAMA_MODEL', 'OLLAMA_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'llama3.2',
  unavailableReason: 'KYBERION_OLLAMA_URL',
  probeLabel: 'Ollama API',
  providerPreset: 'ollama',
  endpointPolicy: 'local',
};

const VLLM_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_VLLM_URL'],
  apiKey: ['KYBERION_VLLM_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_VLLM_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'vllm-model',
  unavailableReason: 'KYBERION_VLLM_URL',
  probeLabel: 'vLLM API',
  providerPreset: 'vllm',
  endpointPolicy: 'local',
};

const LMSTUDIO_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_LMSTUDIO_URL', 'KYBERION_LM_STUDIO_URL', 'KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_LMSTUDIO_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_LMSTUDIO_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'lmstudio-model',
  unavailableReason: 'KYBERION_LMSTUDIO_URL',
  probeLabel: 'LM Studio API',
  providerPreset: 'lmstudio',
  endpointPolicy: 'local',
};

const LLAMACPP_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_LLAMACPP_URL', 'KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_LLAMACPP_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_LLAMACPP_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'llama-model',
  unavailableReason: 'KYBERION_LLAMACPP_URL',
  probeLabel: 'llama.cpp API',
  providerPreset: 'llamacpp',
  endpointPolicy: 'local',
};

const MLX_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_MLX_URL', 'KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_MLX_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_MLX_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'mlx-model',
  unavailableReason: 'KYBERION_MLX_URL',
  probeLabel: 'MLX-LM API',
  providerPreset: 'mlx',
  endpointPolicy: 'local',
};

const LOCALAI_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_LOCALAI_URL', 'KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_LOCALAI_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_LOCALAI_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'localai-model',
  unavailableReason: 'KYBERION_LOCALAI_URL',
  probeLabel: 'LocalAI API',
  providerPreset: 'localai',
  endpointPolicy: 'local',
};

const NEMOTRON_OPENAI_COMPATIBLE_ENV: OpenAiCompatibleBackendEnvNames = {
  baseURL: ['KYBERION_NEMOTRON_URL', 'KYBERION_LOCAL_LLM_URL'],
  apiKey: ['KYBERION_NEMOTRON_KEY', 'KYBERION_LOCAL_LLM_KEY'],
  model: ['KYBERION_NEMOTRON_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
  defaultModel: 'nemotron',
  unavailableReason: 'KYBERION_NEMOTRON_URL',
  probeLabel: 'Nemotron API',
  endpointPolicy: 'public',
};

export function buildOpenAiCompatibleBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, LOCAL_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildOllamaBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, OLLAMA_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildVllmBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, VLLM_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildLmStudioBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, LMSTUDIO_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildLlamaCppBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, LLAMACPP_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildMlxBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, MLX_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildLocalAiBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, LOCALAI_OPENAI_COMPATIBLE_ENV, overrides);
}

export function buildNemotronBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: OpenAiCompatibleBackendOverrides
): OpenAiCompatibleBackend | null {
  return buildBackendFromEnvNames(env, NEMOTRON_OPENAI_COMPATIBLE_ENV, overrides);
}

export async function probeOpenAiCompatibleBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, LOCAL_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeOllamaBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, OLLAMA_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeVllmBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, VLLM_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeLmStudioBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, LMSTUDIO_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeLlamaCppBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, LLAMACPP_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeMlxBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, MLX_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeLocalAiBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, LOCALAI_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: false,
  });
}

export async function probeNemotronBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  return probeBackendAvailabilityFromEnvNames(env, NEMOTRON_OPENAI_COMPATIBLE_ENV, {
    allowPublicEndpoint: true,
  });
}
