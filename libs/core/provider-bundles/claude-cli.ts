import { cliProviderEnv, registerCliProviderBundle } from '../cli-provider-bundle.js';
import {
  buildClaudeCliOptionsFromEnv,
  buildShellClaudeCliBackendFromEnv,
} from '../claude-cli-backend.js';
import { ClaudeCliIntentExtractor } from '../claude-cli-intent-extractor.js';
import { ClaudeCliVoiceBridge } from '../claude-cli-voice-bridge.js';

registerCliProviderBundle('claude-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildShellClaudeCliBackendFromEnv(env, undefined, options.model);
  if (!backend) return null;
  const cliOptions = {
    ...buildClaudeCliOptionsFromEnv(env),
    ...(options.model ? { model: options.model } : {}),
    bin: backend.getBinaryPath(),
  };
  return {
    mode,
    backend: { backend, provider, label: mode },
    intentExtractor: {
      extractor: new ClaudeCliIntentExtractor(cliOptions),
      provider,
      label: mode,
    },
    voiceBridge: {
      bridge: new ClaudeCliVoiceBridge(cliOptions),
      provider,
      label: mode,
    },
  };
});
