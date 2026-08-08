import { secureFetch, type SecureFetchOptions } from './network.js';
import { safeReadFile, safeStat, validateUrl } from './secure-io.js';
import { runStructuredReasoningOp, structuredReasoningSpecs } from './structured-reasoning.js';
import { assertReasoningEgressAllowedAtEndpoint } from './reasoning-egress-scope.js';
import { validateReasoningImageAttachmentPaths } from './reasoning-backend.js';
import type { SamplingParams } from './reasoning-route-resolver.js';
import type {
  BranchForkInput,
  CritiqueInput,
  DecomposedTaskPlan,
  DecomposeIntoTasksInput,
  DivergeHypothesisInput,
  ExtractedDesignSpec,
  ExtractedRequirements,
  ExtractedTestPlan,
  ExtractDesignSpecInput,
  ExtractRequirementsInput,
  ExtractTestPlanInput,
  ForkedBranch,
  HypothesisSketch,
  PersonaSynthesisInput,
  ReasoningBackend,
  ReasoningCallOptions,
  ReasoningImageAttachment,
  ToolDefinition,
  GenerateWithToolsResult,
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
  CritiqueResult,
} from './reasoning-backend.js';

export const GEMINI_API_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_API_DEFAULT_MODEL = 'gemini-3.6-flash';

export interface GeminiApiBackendOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  /** Route parameters translated to Gemini's native generationConfig shape. */
  samplingParams?: Pick<SamplingParams, 'stop'>;
  /** Injectable for hermetic tests; production uses Kyberion's secure egress path. */
  request?: (options: SecureFetchOptions) => Promise<unknown>;
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string } };

interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
      }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

interface GeminiGenerateContentRequest {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  generationConfig?: { responseMimeType?: 'application/json'; stopSequences?: string[] };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE' } };
}

function normalizeBaseUrl(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/u, '');
  if (!normalized) throw new Error('Missing baseURL for Gemini API backend');
  validateUrl(normalized);
  return normalized;
}

function responseText(response: GeminiGenerateContentResponse, trim = true): string {
  const text = (response.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  return trim ? text.trim() : text;
}

function responseParts(response: GeminiGenerateContentResponse) {
  return (response.candidates || []).flatMap((candidate) => candidate.content?.parts || []);
}

function buildAbortSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    },
  };
}

function imageParts(
  images: readonly ReasoningImageAttachment[]
): Array<Extract<GeminiPart, { inlineData: unknown }>> {
  if (images.length > 20) {
    throw new Error(
      `[VISION_TOO_MANY_IMAGES] ${images.length} images exceeds the 20 per-call limit`
    );
  }
  validateReasoningImageAttachmentPaths(images);
  let totalBytes = 0;
  return images.map((image) => {
    const size = safeStat(image.path).size;
    if (size > 5 * 1024 * 1024) {
      throw new Error(`[VISION_IMAGE_TOO_LARGE] ${image.path} exceeds the 5MB per-image limit`);
    }
    totalBytes += size;
    if (totalBytes > 20 * 1024 * 1024) {
      throw new Error('[VISION_PAYLOAD_TOO_LARGE] image payload exceeds the 20MB aggregate limit');
    }
    const raw = safeReadFile(image.path, { encoding: null }) as Buffer;
    const signature = raw.subarray(0, 12);
    const validSignature =
      (image.media_type === 'image/png' &&
        signature.length >= 8 &&
        signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (image.media_type === 'image/jpeg' && signature[0] === 0xff && signature[1] === 0xd8) ||
      (image.media_type === 'image/gif' &&
        /^GIF8[79]a$/u.test(signature.subarray(0, 6).toString('ascii'))) ||
      (image.media_type === 'image/webp' &&
        signature.subarray(0, 4).toString('ascii') === 'RIFF' &&
        signature.subarray(8, 12).toString('ascii') === 'WEBP');
    if (!validSignature) {
      throw new Error(`[VISION_MEDIA_TYPE_MISMATCH] image bytes do not match ${image.media_type}`);
    }
    return { inlineData: { mimeType: image.media_type, data: raw.toString('base64') } };
  });
}

function endpointFor(baseURL: string, model: string): string {
  return `${baseURL}/models/${encodeURIComponent(model)}:generateContent`;
}

function normalizeModel(model: string): string {
  return model.trim().replace(/^gemini:/u, '');
}

export class GeminiApiBackend implements ReasoningBackend {
  readonly name = 'gemini-api';
  readonly egressEndpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly samplingParams: Pick<SamplingParams, 'stop'>;
  private readonly request: (options: SecureFetchOptions) => Promise<unknown>;

  constructor(options: GeminiApiBackendOptions) {
    if (!options.apiKey.trim()) throw new Error('Missing API key for Gemini API backend');
    if (!options.model.trim()) throw new Error('Missing model for Gemini API backend');
    this.apiKey = options.apiKey.trim();
    this.model = normalizeModel(options.model);
    this.baseURL = normalizeBaseUrl(options.baseURL || GEMINI_API_DEFAULT_BASE_URL);
    this.egressEndpoint = this.baseURL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.samplingParams = { ...(options.samplingParams || {}) };
    this.request = options.request || secureFetch;
  }

  getModel(): string {
    return this.model;
  }

  private async generateContent(
    userPrompt: string,
    options: { systemPrompt?: string; json?: boolean; signal?: AbortSignal } = {}
  ): Promise<string> {
    assertReasoningEgressAllowedAtEndpoint(this.name, this.baseURL);
    const generationConfig = this.generationConfig(
      options.json ? { responseMimeType: 'application/json' } : undefined
    );
    const body: GeminiGenerateContentRequest = {
      ...(options.systemPrompt
        ? { systemInstruction: { parts: [{ text: options.systemPrompt }] } }
        : {}),
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      ...(generationConfig ? { generationConfig } : {}),
    };
    return this.generateFromBody(body, options.signal);
  }

  private generationConfig(
    overrides?: GeminiGenerateContentRequest['generationConfig']
  ): GeminiGenerateContentRequest['generationConfig'] {
    const stop = this.samplingParams.stop;
    if (stop === undefined && !overrides) return undefined;
    return {
      ...(stop !== undefined ? { stopSequences: Array.isArray(stop) ? [...stop] : [stop] } : {}),
      ...(overrides || {}),
    };
  }

  private async generateFromBody(
    body: GeminiGenerateContentRequest,
    signal?: AbortSignal
  ): Promise<string> {
    assertReasoningEgressAllowedAtEndpoint(this.name, this.baseURL);
    const requestBody: GeminiGenerateContentRequest = {
      ...body,
      ...(this.generationConfig() || body.generationConfig
        ? {
            generationConfig: {
              ...(this.generationConfig() || {}),
              ...(body.generationConfig || {}),
            },
          }
        : {}),
    };
    const response = (await this.request({
      method: 'POST',
      url: endpointFor(this.baseURL, this.model),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      data: requestBody,
      authenticateRequest: true,
      timeout: this.timeoutMs,
      ...(signal ? { signal } : {}),
    })) as GeminiGenerateContentResponse;

    if (response?.error?.message) {
      throw new Error(`[gemini-api] generateContent failed: ${response.error.message}`);
    }
    const text = responseText(response || {});
    if (!text) {
      const finishReason = response?.candidates?.[0]?.finishReason;
      throw new Error(
        `[gemini-api] response did not contain text${finishReason ? ` (finishReason=${finishReason})` : ''}`
      );
    }
    return text;
  }

  async prompt(prompt: string, options?: ReasoningCallOptions): Promise<string> {
    return this.generateContent(prompt, {
      systemPrompt:
        "You are Kyberion's reasoning backend. Return a direct, useful answer and follow the requested output format.",
      signal: options?.signal,
    });
  }

  async promptWithImages(
    prompt: string,
    images: ReasoningImageAttachment[],
    options?: ReasoningCallOptions
  ): Promise<string> {
    if (images.length === 0) return this.prompt(prompt, options);
    return this.generateFromBody(
      {
        systemInstruction: {
          parts: [
            {
              text: "You are Kyberion's multimodal reasoning backend. Analyze the supplied images and answer the user's request directly.",
            },
          ],
        },
        contents: [{ role: 'user', parts: [...imageParts(images), { text: prompt }] }],
      },
      options?.signal
    );
  }

  async generateWithTools(
    prompt: string,
    tools: ToolDefinition[],
    options?: ReasoningCallOptions
  ): Promise<GenerateWithToolsResult> {
    if (tools.length === 0) return { text: await this.prompt(prompt, options) };
    const response = await this.generateResponse(
      {
        systemInstruction: {
          parts: [
            {
              text: "You are Kyberion's tool-capable reasoning backend. Use a declared function when an action is required.",
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
      options?.signal
    );
    const toolCalls = responseParts(response)
      .filter((part) => part.functionCall?.name)
      .map((part) => ({
        name: part.functionCall!.name!,
        input: part.functionCall!.args || {},
      }));
    const text = responseText(response);
    return {
      ...(text ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *streamPrompt(
    optionsPrompt: string,
    options?: ReasoningCallOptions
  ): AsyncGenerator<string> {
    assertReasoningEgressAllowedAtEndpoint(this.name, this.baseURL);
    const url = `${endpointFor(this.baseURL, this.model).replace(':generateContent', ':streamGenerateContent')}?alt=sse`;
    const body: GeminiGenerateContentRequest = {
      systemInstruction: {
        parts: [
          {
            text: "You are Kyberion's reasoning backend. Return a direct, useful answer and follow the requested output format.",
          },
        ],
      },
      contents: [{ role: 'user', parts: [{ text: optionsPrompt }] }],
    };
    const { signal, dispose } = buildAbortSignal(this.timeoutMs, options?.signal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `[gemini-api] streaming generateContent failed: ${text || response.status}`
        );
      }
      if (!response.body) throw new Error('[gemini-api] streaming response has no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const emitLine = (line: string): string => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return '';
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return '';
        try {
          return responseText(JSON.parse(data) as GeminiGenerateContentResponse, false);
        } catch {
          return '';
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const delta = emitLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (delta) yield delta;
          newline = buffer.indexOf('\n');
        }
        if (done) break;
      }
      const finalDelta = emitLine(buffer);
      if (finalDelta) yield finalDelta;
    } finally {
      dispose();
    }
  }

  private async generateResponse(
    body: GeminiGenerateContentRequest,
    signal?: AbortSignal
  ): Promise<GeminiGenerateContentResponse> {
    assertReasoningEgressAllowedAtEndpoint(this.name, this.baseURL);
    const response = (await this.request({
      method: 'POST',
      url: endpointFor(this.baseURL, this.model),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      data: body,
      authenticateRequest: true,
      timeout: this.timeoutMs,
      ...(signal ? { signal } : {}),
    })) as GeminiGenerateContentResponse;
    if (response?.error?.message) {
      throw new Error(`[gemini-api] generateContent failed: ${response.error.message}`);
    }
    return response;
  }

  private readonly runStructured = (systemPrompt: string, userPrompt: string) =>
    this.generateContent(userPrompt, { systemPrompt, json: true });

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

export function buildGeminiApiBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
  samplingParams?: Pick<SamplingParams, 'stop'>
): GeminiApiBackend | null {
  const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (!apiKey) return null;
  return new GeminiApiBackend({
    apiKey,
    model: normalizeModel(
      modelOverride?.trim() ||
        env.KYBERION_GEMINI_MODEL?.trim() ||
        env.KYBERION_REASONING_MODEL?.trim() ||
        GEMINI_API_DEFAULT_MODEL
    ),
    baseURL: env.KYBERION_GEMINI_URL?.trim(),
    samplingParams,
  });
}

/** Probe the authenticated Google API without consuming model tokens. */
export async function probeGeminiApiBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ available: boolean; reason?: string }> {
  const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    return { available: false, reason: 'GEMINI_API_KEY or GOOGLE_API_KEY is not set' };
  }
  const baseURL = normalizeBaseUrl(env.KYBERION_GEMINI_URL?.trim() || GEMINI_API_DEFAULT_BASE_URL);
  try {
    assertReasoningEgressAllowedAtEndpoint('gemini-api', baseURL);
    await secureFetch({
      method: 'GET',
      url: `${baseURL}/models`,
      headers: { 'x-goog-api-key': apiKey },
      authenticateRequest: true,
      timeout: 4_000,
    });
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
