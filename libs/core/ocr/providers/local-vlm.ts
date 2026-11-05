import { secureFetch } from '../../network.js';
import { safeReadFile } from '../../secure-io.js';
import { resolveRuntimeModelId } from '../../tool/runtime-model-defaults.js';
import { resolveRuntimeEndpoint } from '../../provider/provider-config.js';
import { getRegisteredEnvText } from '../../foundation/env.js';
import { OcrRequest, OcrResult, OcrProvider, OcrDataEgress } from '../../contracts/ocr-types.js';
import { resolveOcrImagePath, parseLocalVlmOcrResponse } from '../provider-support.js';

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
  readonly dataPolicy: 'local_only' | 'training_eligible';

  // RS-02: defaults come from provider-config.json (runtime_endpoints.ollama,
  // runtime_defaults['ollama-vision']); OLLAMA_HOST / OLLAMA_VLM_MODEL still win.
  constructor(
    endpoint = `${resolveRuntimeEndpoint('ollama')}/api/generate`,
    model = resolveRuntimeModelId('ollama-vision')
  ) {
    const ollamaHost = getRegisteredEnvText('OLLAMA_HOST');
    this.endpoint = ollamaHost ? `${ollamaHost.replace(/\/$/, '')}/api/generate` : endpoint;
    this.model = getRegisteredEnvText('OLLAMA_VLM_MODEL') || model;
    this.dataEgress = isLoopbackEndpoint(this.endpoint) ? 'loopback' : 'external';
    this.dataPolicy = this.dataEgress === 'external' ? 'training_eligible' : 'local_only';
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
      // Qwen's reasoning mode is unnecessary for literal OCR. Bound the
      // working context and make token output deterministic for local media.
      think: false,
      stream: false,
      options: { temperature: 0, num_ctx: 8_192, num_predict: 1_024 },
    };

    const data = await secureFetch<unknown>({
      method: 'POST',
      url: this.endpoint,
      headers: { 'Content-Type': 'application/json' },
      timeout: request.timeout_ms ?? 120_000,
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
