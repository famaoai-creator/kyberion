import {
  cliProviderEnv,
  cliProviderEnvText,
  registerCliProviderBundle,
} from '../../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../../agent/agent-dispatch.js';
import { buildGeminiCliBackendFromEnv } from '../gemini-cli-backend.js';
import { GeminiCliIntentExtractor } from '../gemini-cli-intent-extractor.js';
import { GeminiCliVoiceBridge } from '../gemini-cli-voice-bridge.js';

registerCliProviderBundle('gemini-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildGeminiCliBackendFromEnv(env, options.model);
  if (!backend && !options.force) return null;
  if (!backend) return null;
  const geminiOptions = {
    bin: cliProviderEnvText(env, 'KYBERION_GEMINI_CLI_BIN')?.trim() || undefined,
    model:
      options.model ?? cliProviderEnvText(env, 'KYBERION_GEMINI_CLI_MODEL')?.trim() ?? undefined,
  };
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
    intentExtractor: {
      extractor: new GeminiCliIntentExtractor(geminiOptions),
      provider,
      label: mode,
    },
    voiceBridge: {
      bridge: new GeminiCliVoiceBridge(geminiOptions),
      provider,
      label: mode,
    },
  };
});
