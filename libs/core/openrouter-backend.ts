import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExec, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
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

export interface OpenRouterBackendOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
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

function createToolDefinitions(): ChatCompletionRequest['tools'] {
  return [
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
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class OpenRouterBackend implements ReasoningBackend {
  readonly name = 'openrouter';
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterBackendOptions) {
    this.baseURL = normalizeBaseUrl(options.baseURL || 'https://openrouter.ai/api/v1');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  getModel(): string {
    return this.model;
  }

  private async fetchChatCompletion(
    messages: ChatMessage[],
    opts: { useTools?: boolean } = {},
  ): Promise<ChatCompletionResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/famaoai-creator/kyberion',
      'X-Title': 'Kyberion',
    };

    const body: ChatCompletionRequest = {
      model: this.model,
      messages: redactSensitiveObject(messages),
      ...(opts.useTools ?? true ? { tools: createToolDefinitions(), tool_choice: 'auto' } : {}),
    };

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
      throw new Error(`[openrouter] chat completion failed: ${message}`);
    }
    if (!parsed || !parsed.choices || parsed.choices.length === 0) {
      throw new Error(`[openrouter] invalid chat completion response: ${text.slice(0, 500)}`);
    }
    return parsed;
  }

  private async handleToolCall(name: string, rawArguments: string): Promise<string> {
    const args = (safeJsonParse(rawArguments) as Record<string, unknown>) || {};
    logger.info(`[OPENROUTER] Tool Call: ${name}(${JSON.stringify(redactSensitiveObject(args))})`);

    try {
      switch (name) {
        case 'read_file':
          return String(safeReadFile(String(args.path ?? '')));
        case 'write_file':
          safeWriteFile(String(args.path ?? ''), String(args.content ?? ''), { mkdir: true, encoding: 'utf8' });
          return 'Success: File written.';
        case 'list_directory':
          return JSON.stringify(safeReaddir(String(args.path ?? '')));
        case 'shell_exec':
          return safeExec('bash', ['-lc', String(args.command ?? '')], { cwd: pathResolver.rootDir() });
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
        const guardrailDecision = advanceToolLoopGuardrail(
          guardrailState,
          {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        );
        guardrailState = guardrailDecision.state;
        if (guardrailDecision.shouldStop) {
          logger.warn(`[OPENROUTER] Tool loop guardrail triggered: ${guardrailDecision.reason}`);
          return `${extractTextContent(message.content)}\n\n${guardrailDecision.reason}`.trim();
        }
        const result = await this.handleToolCall(toolCall.function.name, toolCall.function.arguments);
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
      { useTools: false },
    );
    return extractTextContent(response.choices[0].message.content);
  }

  private readonly runStructured = (systemPrompt: string, userPrompt: string) =>
    this.completeStructured(systemPrompt, userPrompt);

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    return runStructuredReasoningOp(structuredReasoningSpecs.divergePersonas, input, this.runStructured);
  }

  async crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    return runStructuredReasoningOp(structuredReasoningSpecs.crossCritique, input, this.runStructured);
  }

  async synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    return runStructuredReasoningOp(structuredReasoningSpecs.synthesizePersona, input, this.runStructured);
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    return runStructuredReasoningOp(structuredReasoningSpecs.forkBranches, input, this.runStructured);
  }

  async simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    return runStructuredReasoningOp(structuredReasoningSpecs.simulateBranches, input, this.runStructured);
  }

  async extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    return runStructuredReasoningOp(structuredReasoningSpecs.extractRequirements, input, this.runStructured);
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    return runStructuredReasoningOp(structuredReasoningSpecs.extractDesignSpec, input, this.runStructured);
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    return runStructuredReasoningOp(structuredReasoningSpecs.extractTestPlan, input, this.runStructured);
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    return runStructuredReasoningOp(structuredReasoningSpecs.decomposeIntoTasks, input, this.runStructured);
  }

  async delegateTask(instruction: string, context?: string): Promise<string> {
    return this.prompt(`Task: ${instruction}\nContext: ${context ?? 'none'}`);
  }
}

export function buildOpenRouterBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): OpenRouterBackend | null {
  const apiKey = env.KYBERION_OPENROUTER_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const model = modelOverride?.trim() || env.KYBERION_OPENROUTER_MODEL?.trim() || 'meta-llama/llama-3-70b-instruct';
  const baseURL = env.KYBERION_OPENROUTER_URL?.trim();
  return new OpenRouterBackend({ apiKey, model, baseURL });
}
