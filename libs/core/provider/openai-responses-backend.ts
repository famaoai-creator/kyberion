/** OpenAI's direct API uses Responses, including API-accessible Codex models.
 * Reuse the shared structured-reasoning operations with a toolless transport.
 * CLI login/session state is never read by this adapter.
 */
import {
  OpenAiCompatibleBackend,
  type ChatMessage,
  type ChatCompletionResponse,
} from './openai-compatible-backend.js';
import { secureFetch, redactSensitiveObject, type SecureFetchOptions } from '../network.js';
import { assertReasoningEgressAllowedAtEndpoint } from '../reasoning/reasoning-egress-scope.js';
import type { ReasoningCallOptions, ToolDefinition } from '../reasoning/reasoning-backend.js';
import {
  credentialExecutionIdentity,
  assertCredentialOwner,
  resolveProviderApiCredential,
} from '../foundation/credential-binding.js';
import { isRecord } from '../foundation/text.js';

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

export function extractOpenAiResponseText(body: unknown): string | null {
  if (!isRecord(body) || body.status !== 'completed' || body.error || !Array.isArray(body.output))
    return null;
  const text = body.output
    .filter(isRecord)
    .filter((item) => item.type === 'message' && item.role === 'assistant')
    .flatMap((item) => (Array.isArray(item.content) ? item.content.filter(isRecord) : []))
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('');
  return text || null;
}

export class OpenAiResponsesBackend extends OpenAiCompatibleBackend {
  readonly name = 'openai-api';
  private readonly owner = credentialExecutionIdentity();
  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      maxOutputTokens?: number;
      timeoutMs?: number;
      endpoint?: string;
      credentialKeys?: readonly string[];
      request?: (options: SecureFetchOptions) => Promise<unknown>;
    }
  ) {
    super({
      baseURL: config.endpoint ? new URL('.', config.endpoint).href : 'https://api.openai.com/v1',
      apiKey: config.apiKey,
      model: config.model,
      endpointPolicy: 'public',
      toolsEnabled: false,
      credentialKeys: config.credentialKeys ?? ['OPENAI_API_KEY'],
    });
  }

  protected override async fetchChatCompletion(
    messages: ChatMessage[],
    opts: {
      useTools?: boolean;
      signal?: AbortSignal;
      toolDefinitions?: readonly ToolDefinition[];
    } = {}
  ): Promise<ChatCompletionResponse> {
    if (opts.signal?.aborted) throw new Error('[DELEGATION_CANCELLED] OpenAI API request aborted');
    const endpoint = this.config.endpoint ?? OPENAI_RESPONSES_ENDPOINT;
    assertCredentialOwner(this.owner);
    if (this.owner.tenantSlug && (endpoint !== OPENAI_RESPONSES_ENDPOINT || this.config.request))
      throw new Error(
        '[CREDENTIAL_OWNER_DENIED] Tenant Responses transport must use the official endpoint'
      );
    const key = resolveProviderApiCredential(
      this.config.credentialKeys ?? ['OPENAI_API_KEY'],
      this.owner.tenantSlug ? '' : this.config.apiKey
    );
    assertReasoningEgressAllowedAtEndpoint(this.name, endpoint);
    if (
      opts.useTools ||
      opts.toolDefinitions?.length ||
      messages.some(
        (message) => message.role === 'tool' || message.tool_calls || Array.isArray(message.content)
      )
    ) {
      throw new Error(
        'OpenAI Responses adapter currently supports text and structured reasoning only.'
      );
    }
    let body: unknown;
    try {
      body = await (this.config.request ?? secureFetch)({
        url: endpoint,
        method: 'POST',
        timeout: this.config.timeoutMs ?? 60_000,
        maxRedirects: 0,
        authenticateRequest: true,
        signal: opts.signal,
        headers: { authorization: `Bearer ${key}` },
        data: {
          model: this.config.model,
          input: redactSensitiveObject(messages),
          max_output_tokens: this.config.maxOutputTokens ?? 4096,
          store: false,
          stream: false,
        },
      });
    } catch {
      throw new Error('[openai] API request failed');
    }
    const text = extractOpenAiResponseText(body);
    if (text === null) throw new Error('[openai] API returned no completed text response');
    return { choices: [{ message: { role: 'assistant', content: text } }] };
  }

  // This adapter does not advertise streaming. Preserve the shared fallback
  // interface without accidentally calling Chat Completions for a Codex model.
  override async *streamPrompt(
    prompt: string,
    options?: ReasoningCallOptions
  ): AsyncGenerator<string> {
    yield await this.prompt(prompt, options);
  }
}

export function buildOpenAiResponsesBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { model?: string; maxOutputTokens?: number } = {}
): OpenAiResponsesBackend | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = options.model?.trim() || env.KYBERION_OPENAI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return new OpenAiResponsesBackend({ apiKey, model, maxOutputTokens: options.maxOutputTokens });
}
