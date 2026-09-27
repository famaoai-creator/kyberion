import { cliProviderEnv, registerCliProviderBundle } from '../../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../../agent/agent-dispatch.js';
import {
  buildGrokCliOptionsFromEnv,
  buildShellGrokCliBackendFromEnv,
  GrokCliBackend,
} from '../grok-cli-backend.js';
import { GrokCliIntentExtractor } from '../grok-cli-intent-extractor.js';
import { GrokCliVoiceBridge } from '../grok-cli-voice-bridge.js';

registerCliProviderBundle('grok-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  if (!buildShellGrokCliBackendFromEnv(env) && !options.force) return null;
  const grokOptions = {
    ...buildGrokCliOptionsFromEnv(env),
    ...(options.model ? { model: options.model } : {}),
  };
  const backend = new GrokCliBackend(grokOptions);
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
    intentExtractor: {
      extractor: new GrokCliIntentExtractor(grokOptions),
      provider,
      label: mode,
    },
    voiceBridge: {
      bridge: new GrokCliVoiceBridge(grokOptions),
      provider,
      label: mode,
    },
  };
});
