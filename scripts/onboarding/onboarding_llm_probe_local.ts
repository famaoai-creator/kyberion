import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { OpenAiCompatibleBackend } from '@agent/core/provider/openai-compatible-backend';
import {
  assertReasoningEgressAllowedAtEndpoint,
  withReasoningPayloadScope,
  withReasoningTrainingUseCap,
} from '@agent/core/reasoning/reasoning-egress-scope';

const TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/v1';

type ProbeStatus =
  'passed' | 'invalid_configuration' | 'unavailable' | 'incorrect_result' | 'timed_out';

interface LocalDelegationResult {
  status: ProbeStatus;
  provider: 'ollama';
  training_use: 'local_only';
  endpoint?: string;
  model?: string;
  timeout_ms?: number;
  server_cloud_policy_verified?: false;
  next_step: string;
}

function getProbeEndpoint(input: string): URL {
  const url = new URL(input);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !/^127\.\d+\.\d+\.\d+$/u.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/', '/v1', '/v1/'].includes(url.pathname)
  ) {
    throw new Error('Expected an Ollama loopback endpoint.');
  }
  url.pathname = '/v1/';
  return url;
}

export async function probeLocalDelegation(input: {
  url?: string;
  model?: string;
  timeoutMs?: string;
}): Promise<LocalDelegationResult> {
  const base = { provider: 'ollama', training_use: 'local_only' } as const;
  const timeoutMs = input.timeoutMs === undefined ? TIMEOUT_MS : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    return {
      ...base,
      status: 'invalid_configuration',
      next_step: 'Set --timeout-ms to a whole number from 1000 to 180000.',
    };
  }
  const model = input.model ?? getRegisteredEnvText('KYBERION_OLLAMA_MODEL');
  let endpoint: URL;
  try {
    endpoint = getProbeEndpoint(
      input.url ?? (getRegisteredEnvText('KYBERION_OLLAMA_URL') || DEFAULT_ENDPOINT)
    );
  } catch {
    return {
      ...base,
      status: 'invalid_configuration',
      next_step: 'Set --url to an Ollama HTTP(S) loopback URL, such as http://127.0.0.1:11434/v1.',
    };
  }
  if (!model || !/^[\w./:-]{1,160}$/u.test(model) || /(?:^|[:-])cloud$/iu.test(model)) {
    return {
      ...base,
      status: 'invalid_configuration',
      next_step: 'Set --model or KYBERION_OLLAMA_MODEL to an installed local Ollama model.',
    };
  }
  const target = {
    ...base,
    endpoint: endpoint.toString(),
    model,
    timeout_ms: timeoutMs,
    server_cloud_policy_verified: false as const,
  };
  try {
    const answer = await withReasoningTrainingUseCap('local_only', () =>
      withReasoningPayloadScope(
        {
          tier: 'public',
          training_use: 'local_only',
          purpose: 'onboarding local delegation probe',
        },
        () => {
          assertReasoningEgressAllowedAtEndpoint('ollama', target.endpoint);
          // Construct the Ollama adapter directly so routing and credential
          // discovery cannot introduce inherited fallbacks or API keys.
          const backend = new OpenAiCompatibleBackend({
            baseURL: target.endpoint,
            apiKey: 'not-needed',
            providerPreset: 'ollama',
            model,
            timeoutMs,
            contextWindowTokens: 4096,
            maxCompletionTokens: 512,
          });
          return backend.delegateTask(
            'Synthetic offline onboarding check. Compute 17 plus 25. Reply with only the number, without explanation.'
          );
        }
      )
    );
    if (answer.trim() !== '42') {
      return {
        ...target,
        status: 'incorrect_result',
        next_step: 'The model answered but failed the check. Try another installed local model.',
      };
    }
    return {
      ...target,
      status: 'passed',
      next_step:
        'The loopback endpoint returned 42. Confirm cloud settings on the Ollama server separately.',
    };
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
      return {
        ...target,
        status: 'timed_out',
        next_step:
          'The model did not finish before the deadline. Allow time for a cold start with --timeout-ms or try a smaller local model.',
      };
    }
    return {
      ...target,
      status: 'unavailable',
      next_step:
        'Check the Ollama server, the installed model, and permissions to reach this endpoint.',
    };
  }
}
