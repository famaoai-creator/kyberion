import * as path from 'node:path';
import { getRegisteredEnvText } from '../../../foundation/env.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '../../../secure-io.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
  ImageReference,
} from '../../image-generation-types.js';
import { resolveGeminiApiKey } from '../../../provider/gemini-api-backend.js';
import { governImageProvider } from '../admission.js';
import {
  getFallbackTargetPath,
  imageBytesFromResponse,
  dallEImageBytesFromResponse,
} from '../provider-support.js';

export class LlmApiImageGenerationProvider implements ImageGenerationProvider {
  constructor() {
    this.generate = governImageProvider(this).generate;
  }
  readonly id = 'llm_api';
  readonly costTier = 'paid';
  readonly dataPolicy = 'zero_retention';
  readonly executionLocality = 'remote';

  async isAvailable(): Promise<boolean> {
    return Boolean(resolveGeminiApiKey() || getRegisteredEnvText('OPENAI_API_KEY'));
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const apiKeyGemini = resolveGeminiApiKey();
    const apiKeyOpenAI = getRegisteredEnvText('OPENAI_API_KEY');

    const order = request.providerPreference || ['gemini', 'openai'];

    for (const key of order) {
      if (key.includes('gemini') && apiKeyGemini) {
        return await this.callGeminiImagen(apiKeyGemini, request, startedAt);
      }
      if (key.includes('openai') && apiKeyOpenAI) {
        return await this.callOpenAIDallE(apiKeyOpenAI, request, startedAt);
      }
    }

    if (apiKeyGemini) return await this.callGeminiImagen(apiKeyGemini, request, startedAt);
    if (apiKeyOpenAI) return await this.callOpenAIDallE(apiKeyOpenAI, request, startedAt);

    throw new Error('No Cloud Image Generation API key available.');
  }

  private async callGeminiImagen(
    apiKey: string,
    request: ImageGenerationRequest,
    startedAt: number
  ): Promise<ImageGenerationResult> {
    // Default to Imagen 3 API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:generateImages?key=${apiKey}`;

    // aspect ratio can be '1:1', '3:4', '4:3', '9:16', or '16:9'
    let resolvedRatio = request.aspectRatio || '1:1';
    if (resolvedRatio === '16/9') resolvedRatio = '16:9';
    if (resolvedRatio === '9/16') resolvedRatio = '9:16';

    const payload = {
      numberOfImages: 1,
      prompt: request.prompt,
      aspectRatio: resolvedRatio,
      outputMimeType: 'image/jpeg',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Gemini Imagen API error: ${res.statusText} (${res.status})`);
    }

    const data = (await res.json()) as unknown;
    const base64Bytes = imageBytesFromResponse(data);
    if (!base64Bytes) {
      throw new Error('Gemini Imagen API returned no image bytes');
    }

    const targetPath = getFallbackTargetPath(request);
    const buffer = Buffer.from(base64Bytes, 'base64');
    safeWriteFile(targetPath, buffer);

    return {
      status: 'succeeded',
      provider: 'gemini_imagen',
      path: targetPath,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async callOpenAIDallE(
    apiKey: string,
    request: ImageGenerationRequest,
    startedAt: number
  ): Promise<ImageGenerationResult> {
    const url = 'https://api.openai.com/v1/images/generations';

    // Resolve size mapping for DALL-E 3
    let size = '1024x1024';
    if (request.aspectRatio === '16:9' || request.aspectRatio === '16/9') size = '1792x1024';
    if (request.aspectRatio === '9:16' || request.aspectRatio === '9/16') size = '1024x1792';

    const payload = {
      model: 'dall-e-3',
      prompt: request.prompt,
      n: 1,
      size,
      response_format: 'b64_json',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`OpenAI DALL-E API error: ${res.statusText} (${res.status})`);
    }

    const data = await res.json();
    const base64Bytes = dallEImageBytesFromResponse(data);
    if (!base64Bytes) {
      throw new Error('OpenAI DALL-E API returned no image bytes');
    }

    const targetPath = getFallbackTargetPath(request);
    const buffer = Buffer.from(base64Bytes, 'base64');
    safeWriteFile(targetPath, buffer);

    return {
      status: 'succeeded',
      provider: 'dalle_3',
      path: targetPath,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
