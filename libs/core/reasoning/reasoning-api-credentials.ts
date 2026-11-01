/** API proof and model selection consume the canonical provider descriptors.
 * Secret introduction remains owned by secret-introduction / Secret Guard.
 */
import { createHash } from 'node:crypto';
import { secureFetch, type SecureFetchOptions } from '../network.js';
import {
  credentialExecutionIdentity,
  assertCredentialOwner,
  resolveProviderApiCredential,
} from '../foundation/credential-binding.js';
import { resolveRuntimeModelId } from '../tool/runtime-model-defaults.js';
import {
  listReasoningProviderDescriptors,
  resolveReasoningProviderEnvironment,
  type ReasoningProviderDescriptor,
} from './reasoning-provider-registry.js';

export function reasoningCredentialVersion(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function listReasoningApiProviders(): ReasoningProviderDescriptor[] {
  return listReasoningProviderDescriptors().filter((entry) =>
    Boolean(entry.api_proof && entry.secret_refs?.length)
  );
}
export function requireReasoningApiProvider(mode: string): ReasoningProviderDescriptor {
  const descriptor =
    listReasoningApiProviders().find((entry) => entry.mode === mode) ??
    listReasoningApiProviders().find((entry) => entry.provider === mode);
  if (!descriptor?.api_proof || !descriptor.secret_refs?.length)
    throw new Error('Select a configured API provider; see reasoning:credentials --help.');
  return descriptor;
}
export function isReasoningApiModel(model: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/u.test(model);
}
export function resolveReasoningApiModel(
  mode: string,
  override?: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const descriptor = requireReasoningApiProvider(mode);
  return (
    override?.trim() ||
    descriptor.model_env_keys?.map((key) => env[key]?.trim()).find(Boolean) ||
    descriptor.api_proof?.default_model ||
    (descriptor.api_proof?.default_model_role
      ? resolveRuntimeModelId(descriptor.api_proof.default_model_role, env)
      : undefined)
  );
}
export function resolveReasoningApiKey(mode: string): string | undefined {
  const descriptor = requireReasoningApiProvider(mode);
  const keys = descriptor.secret_refs![0]!.env_keys;
  const env = resolveReasoningProviderEnvironment(descriptor);
  const operator = keys.map((key) => env[key]?.trim()).find(Boolean) || '';
  return resolveProviderApiCredential(
    keys,
    credentialExecutionIdentity().tenantSlug ? '' : operator
  );
}

export interface ReasoningApiProofAdapter {
  protocol: string;
  request(input: {
    baseURL: string;
    key: string;
    model: string;
    prompt: string;
    maxTokens: number;
  }): SecureFetchOptions;
  text(response: unknown): string | undefined;
}
const chat: ReasoningApiProofAdapter = {
  protocol: 'chat-completions',
  request: ({ baseURL, key, model, prompt, maxTokens }) => ({
    url: `${baseURL}/chat/completions`,
    headers: { authorization: `Bearer ${key}` },
    data: {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    },
  }),
  text: (body) =>
    (body as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content,
};
const adapters = new Map<string, ReasoningApiProofAdapter>([
  [chat.protocol, chat],
  [
    'openrouter-chat',
    {
      ...chat,
      protocol: 'openrouter-chat',
      request: (input) => {
        const config = chat.request(input);
        return {
          ...config,
          data: { ...config.data, provider: { allow_fallbacks: false, require_parameters: true } },
        };
      },
    },
  ],
  [
    'messages',
    {
      protocol: 'messages',
      request: ({ baseURL, key, model, prompt, maxTokens }) => ({
        url: `${baseURL}/messages`,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        data: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
      }),
      text: (value) => {
        const body = value as { content?: { type?: string; text?: string }[] };
        return body?.content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
      },
    },
  ],
  [
    'generate-content',
    {
      protocol: 'generate-content',
      request: ({ baseURL, key, model, prompt, maxTokens }) => ({
        url: `${baseURL}/models/${encodeURIComponent(model.replace(/^models\//u, ''))}:generateContent`,
        headers: { 'x-goog-api-key': key },
        data: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        },
      }),
      text: (value) => {
        const body = value as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return body?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
      },
    },
  ],
  [
    'responses',
    {
      protocol: 'responses',
      request: ({ baseURL, key, model, prompt, maxTokens }) => ({
        url: `${baseURL}/responses`,
        headers: { authorization: `Bearer ${key}` },
        data: { model, input: prompt, max_output_tokens: maxTokens, store: false, stream: false },
      }),
      text: (value) => {
        const body = value as {
          status?: string;
          error?: unknown;
          output?: { type?: string; role?: string; content?: { type?: string; text?: string }[] }[];
        };
        if (body?.status !== 'completed' || body.error || !Array.isArray(body.output))
          return undefined;
        return body.output
          .filter((item) => item.type === 'message' && item.role === 'assistant')
          .flatMap((item) => item.content ?? [])
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text ?? '')
          .join('');
      },
    },
  ],
]);
export function registerReasoningApiProofAdapter(adapter: ReasoningApiProofAdapter): () => void {
  if (
    !/^[a-z0-9][a-z0-9-]*$/u.test(adapter.protocol) ||
    adapters.has(adapter.protocol) ||
    typeof adapter.request !== 'function' ||
    typeof adapter.text !== 'function'
  )
    throw new Error('Invalid or duplicate API proof adapter.');
  adapters.set(adapter.protocol, adapter);
  return () => {
    adapters.delete(adapter.protocol);
  };
}
export function requireReasoningApiProofAdapter(mode: string): ReasoningApiProofAdapter {
  const adapter = adapters.get(requireReasoningApiProvider(mode).api_proof!.protocol);
  if (!adapter) throw new Error('Unsupported API proof protocol.');
  return adapter;
}
export interface ReasoningApiVerification {
  provider: string;
  model: string;
  status: 'success' | 'failed';
  checked_at: string;
  max_output_tokens: number;
  endpoint?: string;
  credential_version?: string;
  execution?: { kind: 'operator' | 'tenant'; tenant?: string; mission?: string; task?: string };
  transport?: 'secure-fetch' | 'custom-request';
  code:
    | 'verified'
    | 'consent_required'
    | 'unsupported_adapter'
    | 'credential_unavailable'
    | 'request_failed'
    | 'dns_failed'
    | 'network_timeout'
    | 'authentication_failed'
    | 'authorization_failed'
    | 'model_or_endpoint_unavailable'
    | 'rate_limited'
    | 'policy_denied'
    | 'unexpected_response';
}
export async function verifyReasoningApiCredential(
  options: { provider: string; model: string; allowPaid?: boolean },
  request: (options: SecureFetchOptions) => Promise<unknown> = secureFetch
): Promise<ReasoningApiVerification> {
  const descriptor = requireReasoningApiProvider(options.provider);
  if (!isReasoningApiModel(options.model))
    throw new Error('An explicit valid API model is required.');
  const base = {
    provider: options.provider,
    model: options.model,
    checked_at: new Date().toISOString(),
    max_output_tokens: 128,
  };
  let attribution: Partial<ReasoningApiVerification> = {};
  const fail = (code: ReasoningApiVerification['code']): ReasoningApiVerification => ({
    ...base,
    ...attribution,
    status: 'failed',
    code,
  });
  if (!options.allowPaid) return fail('consent_required');
  let adapter: ReasoningApiProofAdapter;
  try {
    adapter = requireReasoningApiProofAdapter(options.provider);
  } catch {
    return fail('unsupported_adapter');
  }
  const owner = credentialExecutionIdentity();
  let key: string | undefined;
  try {
    key = resolveReasoningApiKey(options.provider);
  } catch {
    return fail('credential_unavailable');
  }
  if (!key) return fail('credential_unavailable');
  attribution = {
    credential_version: reasoningCredentialVersion(key),
    execution: {
      kind: owner.tenantSlug ? 'tenant' : 'operator',
      ...(owner.tenantSlug ? { tenant: owner.tenantSlug } : {}),
      ...(owner.missionId ? { mission: owner.missionId } : {}),
      ...(owner.taskId ? { task: owner.taskId } : {}),
    },
    transport: request === secureFetch ? 'secure-fetch' : 'custom-request',
  };
  try {
    assertCredentialOwner(owner);
    const config = adapter.request({
      baseURL: descriptor.api_proof!.base_url.replace(/\/+$/u, ''),
      key,
      model: options.model,
      prompt: 'Reply with exactly OK.',
      maxTokens: 128,
    });
    attribution.endpoint = String(config.url);
    const body = await request({
      ...config,
      method: 'POST',
      timeout: 20_000,
      maxRedirects: 0,
      maxContentLength: 64 * 1024,
      authenticateRequest: true,
      kyberion_egress_context: { tier: 'public', purpose: 'synthetic API credential verification' },
    });
    if (adapter.text(body)?.trim() !== 'OK') return fail('unexpected_response');
    return { ...base, ...attribution, status: 'success', code: 'verified' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status =
      error && typeof error === 'object' && 'httpStatus' in error ? error.httpStatus : undefined;
    if (/ENOTFOUND|EAI_AGAIN/.test(message)) return fail('dns_failed');
    if (/ETIMEDOUT|ECONNABORTED|timed? ?out|timeout/i.test(message)) return fail('network_timeout');
    if (status === 401) return fail('authentication_failed');
    if (status === 403) return fail('authorization_failed');
    if (status === 404) return fail('model_or_endpoint_unavailable');
    if (status === 429) return fail('rate_limited');
    if (/^\[(?:POLICY_VIOLATION|SENSITIVE_PATH_DENIED|EGRESS_[A-Z_]+)\]/.test(message))
      return fail('policy_denied');
    return fail('request_failed');
  }
}
