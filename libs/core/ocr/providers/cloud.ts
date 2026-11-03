import { secureFetch } from '../../network.js';
import { safeReadFile } from '../../secure-io.js';
import { resolveRuntimeModelId } from '../../tool/runtime-model-defaults.js';
import { getRegisteredEnvText } from '../../foundation/env.js';
import { resolveGeminiApiKey } from '../../provider/gemini-api-backend.js';
import { OcrRequest, OcrResult, OcrProvider } from '../../ocr-types.js';
import {
  getMimeType,
  resolveOcrImagePath,
  parseGeminiOcrResponse,
  parseClaudeOcrResponse,
  parseOpenAiOcrResponse,
} from '../provider-support.js';

export class LlmApiOcrProvider implements OcrProvider {
  readonly id = 'llm_api';
  readonly dataEgress = 'external' as const; // uploads the image to a vendor API
  readonly dataPolicy = 'training_eligible' as const;

  async isAvailable(): Promise<boolean> {
    return Boolean(
      resolveGeminiApiKey() ||
      getRegisteredEnvText('ANTHROPIC_API_KEY') ||
      getRegisteredEnvText('OPENAI_API_KEY')
    );
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const resolvedPath = resolveOcrImagePath(request.path);
    const buffer = safeReadFile(resolvedPath, { encoding: null }) as Buffer;
    const base64Data = buffer.toString('base64');
    const mimeType = getMimeType(request.path);

    const apiKeyGemini = resolveGeminiApiKey();
    const apiKeyClaude = getRegisteredEnvText('ANTHROPIC_API_KEY');
    const apiKeyOpenAI = getRegisteredEnvText('OPENAI_API_KEY');

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
