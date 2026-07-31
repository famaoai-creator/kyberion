import { secureFetch, type SecureFetchOptions } from './network.js';
import { validateUrl } from './secure-io.js';
import { runStructuredReasoningOp, structuredReasoningSpecs } from './structured-reasoning.js';
import { assertReasoningEgressAllowedAtEndpoint } from './reasoning-egress-scope.js';
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
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
  CritiqueResult,
} from './reasoning-backend.js';

export const GEMINI_API_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_API_DEFAULT_MODEL = 'gemini-flash-latest';

export interface GeminiApiBackendOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  /** Injectable for hermetic tests; production uses Kyberion's secure egress path. */
  request?: (options: SecureFetchOptions) => Promise<unknown>;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

interface GeminiGenerateContentRequest {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
  generationConfig?: { responseMimeType?: 'application/json' };
}

function normalizeBaseUrl(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/u, '');
  if (!normalized) throw new Error('Missing baseURL for Gemini API backend');
  validateUrl(normalized);
  return normalized;
}

function responseText(response: GeminiGenerateContentResponse): string {
  return (response.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
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
  private readonly request: (options: SecureFetchOptions) => Promise<unknown>;

  constructor(options: GeminiApiBackendOptions) {
    if (!options.apiKey.trim()) throw new Error('Missing API key for Gemini API backend');
    if (!options.model.trim()) throw new Error('Missing model for Gemini API backend');
    this.apiKey = options.apiKey.trim();
    this.model = normalizeModel(options.model);
    this.baseURL = normalizeBaseUrl(options.baseURL || GEMINI_API_DEFAULT_BASE_URL);
    this.egressEndpoint = this.baseURL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
    const body: GeminiGenerateContentRequest = {
      ...(options.systemPrompt
        ? { systemInstruction: { parts: [{ text: options.systemPrompt }] } }
        : {}),
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      ...(options.json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
    };
    const response = (await this.request({
      method: 'POST',
      url: endpointFor(this.baseURL, this.model),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      data: body,
      authenticateRequest: true,
      timeout: this.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
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
  modelOverride?: string
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
