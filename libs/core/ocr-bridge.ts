import * as path from 'node:path';
import { logger } from './core.js';
import { secureFetch } from './network.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeReadFile } from './secure-io.js';
import { spawnManagedProcess } from './managed-process.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';
import { parseSafeJsonObjectInput } from './foundation/safe-json.js';
import { OcrRequest, OcrResult, OcrProvider, OcrDataEgress, OcrRoutingMode } from './ocr-types.js';
import {
  probeWindowsNativeImageRecognition,
  recognizeTextWithWindowsNativeApi,
} from './windows-native-image-recognition-bridge.js';

export class WindowsNativeOcrProvider implements OcrProvider {
  readonly id = 'windows_native';
  readonly dataEgress = 'none' as const; // Windows OCR API, in-process

  async isAvailable(): Promise<boolean> {
    return probeWindowsNativeImageRecognition().ocr;
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const result = recognizeTextWithWindowsNativeApi(resolveOcrImagePath(request.path));
    if (!result || result.status !== 'succeeded') {
      return {
        status: 'failed',
        provider: this.id,
        text: '',
        confidence: 0,
        error: 'windows_native_ocr_failed',
        elapsedMs: Date.now() - startedAt,
      };
    }
    return {
      status: 'succeeded',
      provider: this.id,
      text: result.text || '',
      confidence: Number(result.confidence || 0),
      lines: result.lines,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function resolveOcrImagePath(requestPath: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(requestPath), {
    allowMissingLeaf: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function parseAppleVisionLines(value: unknown): OcrResult['lines'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.text !== 'string') return [];
    const confidence = typeof entry.confidence === 'number' ? entry.confidence : 0;
    const bbox = isRecord(entry.bbox) ? entry.bbox : undefined;
    const hasBoundingBox =
      bbox &&
      typeof bbox.x0 === 'number' &&
      typeof bbox.y0 === 'number' &&
      typeof bbox.x1 === 'number' &&
      typeof bbox.y1 === 'number';
    return [
      {
        text: entry.text,
        confidence,
        ...(hasBoundingBox
          ? {
              boundingBox: {
                x: bbox.x0 as number,
                y: bbox.y0 as number,
                width: (bbox.x1 as number) - (bbox.x0 as number),
                height: (bbox.y1 as number) - (bbox.y0 as number),
              },
            }
          : {}),
      },
    ];
  });
}

export function parseGeminiOcrResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = firstRecord(value.candidates);
  const content = candidate && isRecord(candidate.content) ? candidate.content : undefined;
  const part = content && firstRecord(content.parts);
  return part ? nonEmptyString(part.text) : undefined;
}

export function parseClaudeOcrResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const content = firstRecord(value.content);
  return content ? nonEmptyString(content.text) : undefined;
}

export function parseOpenAiOcrResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const choice = firstRecord(value.choices);
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  return message ? nonEmptyString(message.content) : undefined;
}

export function parseLocalVlmOcrResponse(value: unknown): string | undefined {
  return isRecord(value) ? nonEmptyString(value.response) : undefined;
}

export class TesseractOcrProvider implements OcrProvider {
  readonly id = 'tesseract';
  readonly dataEgress = 'none' as const; // tesseract.js, in-process

  async isAvailable(): Promise<boolean> {
    try {
      await import('tesseract.js');
      return true;
    } catch (_) {
      return false;
    }
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const resolvedPath = resolveOcrImagePath(request.path);
    const lang = request.language || 'eng';
    let worker: any = null;

    try {
      const { createWorker } = await import('tesseract.js');
      worker = await createWorker(lang);
      const result = await worker.recognize(resolvedPath);

      return {
        status: 'succeeded',
        provider: this.id,
        text: result.data.text,
        confidence: result.data.confidence,
        lines: result.data.lines?.map((line) => ({
          text: line.text,
          confidence: line.confidence,
          boundingBox: line.bbox
            ? {
                x: line.bbox.x0,
                y: line.bbox.y0,
                width: line.bbox.x1 - line.bbox.x0,
                height: line.bbox.y1 - line.bbox.y0,
              }
            : undefined,
        })),
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      logger.error(`[ocr_bridge] Tesseract execution failed: ${error.message}`);
      return {
        status: 'failed',
        provider: this.id,
        text: '',
        confidence: 0,
        error: error.message || 'tesseract_recognition_failed',
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch (terminateError: any) {
          logger.warn(
            `[ocr_bridge] Tesseract worker terminate failed: ${terminateError?.message || terminateError}`
          );
        }
      }
    }
  }
}

export class AppleVisionOcrProvider implements OcrProvider {
  readonly id = 'apple_vision';
  readonly dataEgress = 'none' as const; // macOS Vision framework, on-device

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin';
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const scriptPath = assertSafeRepositoryPath(pathResolver.resolve('libs/core/native-ocr.swift'));
    const resolvedImagePath = resolveOcrImagePath(request.path);

    return new Promise((resolve, reject) => {
      const args = [scriptPath, resolvedImagePath];
      if (request.language) {
        args.push(request.language);
      }

      const child = spawnManagedProcess({
        resourceId: `ocr-apple-vision:${Date.now()}`,
        kind: 'service',
        ownerId: 'ocr-bridge',
        ownerType: 'core-bridge',
        command: 'swift',
        args,
        spawnOptions: {
          cwd: pathResolver.rootDir(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        shutdownPolicy: 'manual',
      });

      let stdout = '';
      let stderr = '';
      let completed = false;

      const timeoutMs = 15000;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        try {
          child.child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error(`apple_vision_ocr_timeout: Native OCR execution exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        completed = true;
        clearTimeout(timer);
      };

      child.child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.child.on('error', (err) => {
        if (completed) return;
        cleanup();
        try {
          child.child.kill();
        } catch {
          // ignore
        }
        reject(err);
      });

      child.child.on('close', (code) => {
        if (completed) return;
        cleanup();

        const raw = stdout.trim();
        if (!raw) {
          return reject(new Error(stderr.trim() || `apple_vision_failed_${code}`));
        }

        try {
          const parsed = parseSafeJsonObjectInput(raw, 'apple vision OCR response');
          if (!parsed) throw new Error('apple vision OCR response must not be empty');
          if (parsed.error) {
            return reject(new Error(String(parsed.error)));
          }
          resolve({
            status: parsed.status === 'succeeded' ? 'succeeded' : 'failed',
            provider: this.id,
            text: typeof parsed.text === 'string' ? parsed.text : '',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
            lines: parseAppleVisionLines(parsed.lines),
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error: any) {
          reject(new Error(`apple_vision_invalid_json: ${error?.message || error}: ${raw}`));
        }
      });
    });
  }
}

export class LlmApiOcrProvider implements OcrProvider {
  readonly id = 'llm_api';
  readonly dataEgress = 'external' as const; // uploads the image to a vendor API

  async isAvailable(): Promise<boolean> {
    return Boolean(
      process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
    );
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const resolvedPath = resolveOcrImagePath(request.path);
    const buffer = safeReadFile(resolvedPath, { encoding: null }) as Buffer;
    const base64Data = buffer.toString('base64');
    const mimeType = getMimeType(request.path);

    const apiKeyGemini = process.env.GEMINI_API_KEY;
    const apiKeyClaude = process.env.ANTHROPIC_API_KEY;
    const apiKeyOpenAI = process.env.OPENAI_API_KEY;

    const order = request.providerPreference || ['gemini', 'claude', 'openai'];

    for (const key of order) {
      if (key.includes('gemini') && apiKeyGemini) {
        return await this.callGemini(apiKeyGemini, base64Data, mimeType, startedAt);
      }
      if (key.includes('claude') && apiKeyClaude) {
        return await this.callClaude(apiKeyClaude, base64Data, mimeType, startedAt);
      }
      if ((key.includes('openai') || key.includes('codex')) && apiKeyOpenAI) {
        return await this.callOpenAI(apiKeyOpenAI, base64Data, mimeType, startedAt);
      }
    }

    if (apiKeyGemini) return await this.callGemini(apiKeyGemini, base64Data, mimeType, startedAt);
    if (apiKeyClaude) return await this.callClaude(apiKeyClaude, base64Data, mimeType, startedAt);
    if (apiKeyOpenAI) return await this.callOpenAI(apiKeyOpenAI, base64Data, mimeType, startedAt);

    throw new Error('No Cloud LLM API key available for OCR.');
  }

  private async callGemini(
    apiKey: string,
    base64Data: string,
    mimeType: string,
    startedAt: number
  ): Promise<OcrResult> {
    const model = resolveRuntimeModelId('gemini-default');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const payload = {
      contents: [
        {
          parts: [
            {
              text: 'Perform OCR on this image. Return ONLY the recognized text. Do not add markdown code blocks, explanation, or notes. Preserve layout and linebreaks if possible.',
            },
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
          ],
        },
      ],
    };

    const data = await secureFetch<unknown>({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      data: payload,
      params: { key: apiKey },
      authenticateRequest: true,
    });
    const text = parseGeminiOcrResponse(data);
    if (text === undefined) throw new Error('gemini_ocr_invalid_response');
    return {
      status: 'succeeded',
      provider: 'gemini_api',
      text: text.trim(),
      confidence: 95,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async callClaude(
    apiKey: string,
    base64Data: string,
    mimeType: string,
    startedAt: number
  ): Promise<OcrResult> {
    const url = 'https://api.anthropic.com/v1/messages';
    const payload = {
      model: resolveRuntimeModelId('anthropic-fast'),
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Data,
              },
            },
            {
              type: 'text',
              text: 'Perform OCR on this image. Return ONLY the recognized text. Do not add markdown code blocks, explanation, or notes. Preserve layout and linebreaks if possible.',
            },
          ],
        },
      ],
    };

    const data = await secureFetch<unknown>({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      data: payload,
      authenticateRequest: true,
    });
    const text = parseClaudeOcrResponse(data);
    if (text === undefined) throw new Error('claude_ocr_invalid_response');
    return {
      status: 'succeeded',
      provider: 'claude_api',
      text: text.trim(),
      confidence: 96,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async callOpenAI(
    apiKey: string,
    base64Data: string,
    mimeType: string,
    startedAt: number
  ): Promise<OcrResult> {
    const url = 'https://api.openai.com/v1/chat/completions';
    const payload = {
      model: resolveRuntimeModelId('openai-vision'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Perform OCR on this image. Return ONLY the recognized text. Do not add markdown code blocks, explanation, or notes. Preserve layout and linebreaks if possible.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`,
              },
            },
          ],
        },
      ],
    };

    const data = await secureFetch<unknown>({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      data: payload,
      authenticateRequest: true,
    });
    const text = parseOpenAiOcrResponse(data);
    if (text === undefined) throw new Error('openai_ocr_invalid_response');
    return {
      status: 'succeeded',
      provider: 'openai_api',
      text: text.trim(),
      confidence: 94,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** Loopback hosts, i.e. a service running on this same machine. */
function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export class LocalVlmOcrProvider implements OcrProvider {
  readonly id = 'local_vlm';
  private readonly endpoint: string;
  private readonly model: string;
  /**
   * "local" only as long as OLLAMA_HOST actually points at this machine — the
   * name is not evidence, the resolved endpoint is.
   */
  readonly dataEgress: OcrDataEgress;

  constructor(endpoint = 'http://localhost:11434/api/generate', model = 'llama3-vision') {
    this.endpoint = process.env.OLLAMA_HOST
      ? `${process.env.OLLAMA_HOST.replace(/\/$/, '')}/api/generate`
      : endpoint;
    this.model = process.env.OLLAMA_VLM_MODEL || model;
    this.dataEgress = isLoopbackEndpoint(this.endpoint) ? 'loopback' : 'external';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const pingUrl = this.endpoint.replace('/api/generate', '/api/tags');
      await secureFetch({
        method: 'GET',
        url: pingUrl,
        timeout: 1000,
        kyberion_allow_local_network: true,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const resolvedPath = resolveOcrImagePath(request.path);
    const buffer = safeReadFile(resolvedPath, { encoding: null }) as Buffer;
    const base64Data = buffer.toString('base64');

    const payload = {
      model: this.model,
      prompt:
        'Perform OCR on this image. Return ONLY the recognized text. Do not add markdown code blocks or explanations.',
      images: [base64Data],
      stream: false,
    };

    const data = await secureFetch<unknown>({
      method: 'POST',
      url: this.endpoint,
      headers: { 'Content-Type': 'application/json' },
      data: payload,
      kyberion_allow_local_network: true,
    });
    const text = parseLocalVlmOcrResponse(data);
    if (text === undefined) throw new Error('local_vlm_ocr_invalid_response');
    return {
      status: 'succeeded',
      provider: this.id,
      text: text.trim(),
      confidence: 88,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export class AdaptivePolicyRouter {
  private providers: Map<string, OcrProvider> = new Map();

  constructor(providers: OcrProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
  }

  /**
   * Egress a mode is allowed to use. This is the enforcement point: it also
   * constrains providerPreference, so a preference can reorder the chain but
   * can never widen it past what the mode permits.
   */
  private allowedEgress(mode: OcrRoutingMode): ReadonlySet<OcrDataEgress> {
    if (mode === 'local_only') return new Set<OcrDataEgress>(['none']);
    if (mode === 'privacy_first') return new Set<OcrDataEgress>(['none', 'loopback']);
    return new Set<OcrDataEgress>(['none', 'loopback', 'external']);
  }

  private getProviderIds(request: OcrRequest): string[] {
    const preferred =
      request.providerPreference && request.providerPreference.length > 0
        ? request.providerPreference
        : [];
    const mode = request.mode || 'balanced';

    // Ordering preference only. Membership is decided by the egress filter in
    // resolveCandidates(), derived from what each provider declares about itself.
    const defaultChain =
      mode === 'accurate'
        ? ['windows_native', 'llm_api', 'local_vlm', 'apple_vision', 'tesseract']
        : mode === 'privacy_first'
          ? ['windows_native', 'local_vlm', 'apple_vision', 'tesseract']
          : mode === 'local_only'
            ? ['windows_native', 'apple_vision', 'tesseract']
            : ['windows_native', 'apple_vision', 'llm_api', 'tesseract'];

    const merged = [...preferred, ...defaultChain, ...this.providers.keys()];
    const seen = new Set<string>();
    return merged.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  async resolveCandidates(request: OcrRequest): Promise<OcrProvider[]> {
    const allowed = this.allowedEgress(request.mode || 'balanced');
    const candidates: OcrProvider[] = [];
    for (const id of this.getProviderIds(request)) {
      const provider = this.providers.get(id);
      if (!provider) continue;
      if (!allowed.has(provider.dataEgress)) {
        logger.info(
          `[ocr_bridge] provider ${provider.id} excluded: dataEgress='${provider.dataEgress}' not permitted by mode='${request.mode || 'balanced'}'`
        );
        continue;
      }
      if (await provider.isAvailable()) candidates.push(provider);
    }
    return candidates;
  }

  async selectProvider(request: OcrRequest): Promise<OcrProvider> {
    const candidates = await this.resolveCandidates(request);
    if (candidates.length > 0) {
      return candidates[0];
    }

    throw new Error('No available OCR provider could be resolved.');
  }
}

let globalRouter: AdaptivePolicyRouter | null = null;

function getRouter(): AdaptivePolicyRouter {
  if (!globalRouter) {
    globalRouter = new AdaptivePolicyRouter([
      new WindowsNativeOcrProvider(),
      new AppleVisionOcrProvider(),
      new LlmApiOcrProvider(),
      new LocalVlmOcrProvider(),
      new TesseractOcrProvider(),
    ]);
  }
  return globalRouter;
}

export async function ocrImage(request: OcrRequest): Promise<OcrResult> {
  return await ocrImageWithRouter(request, getRouter());
}

export async function ocrImageWithRouter(
  request: OcrRequest,
  router: AdaptivePolicyRouter
): Promise<OcrResult> {
  const candidates = await router.resolveCandidates(request);
  if (candidates.length === 0) {
    throw new Error('No available OCR provider could be resolved.');
  }

  let lastError: Error | null = null;
  for (const provider of candidates) {
    logger.info(`[ocr_bridge] Routing OCR request for ${request.path} to provider: ${provider.id}`);
    try {
      const result = await provider.recognize(request);
      if (result.status === 'succeeded') {
        // Stamp the served egress so callers can assert what actually happened
        // instead of trusting the mode they asked for.
        return { ...result, providerDataEgress: provider.dataEgress };
      }
      lastError = new Error(result.error || `${provider.id}_ocr_failed`);
      logger.warn(
        `[ocr_bridge] OCR provider ${provider.id} returned status=${result.status}; trying next provider if available.`
      );
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`[ocr_bridge] OCR provider ${provider.id} failed: ${lastError.message}`);
    }
  }

  throw lastError || new Error('No available OCR provider could be resolved.');
}
