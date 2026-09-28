import {
  cliProviderEnv,
  cliProviderEnvText,
  registerCliProviderBundle,
} from '../../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../../agent/agent-dispatch.js';
import { buildAgyCliBackendFromEnv } from '../agy-cli-backend.js';
import { AgyCliIntentExtractor } from '../agy-cli-intent-extractor.js';
import { AgyCliVoiceBridge } from '../agy-cli-voice-bridge.js';

registerCliProviderBundle('agy-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildAgyCliBackendFromEnv(env);
  if (!backend && !options.force) return null;
  if (!backend) return null;
  const agyOptions = {
    bin:
      cliProviderEnvText(env, 'KYBERION_ANTIGRAVITY_CLI_BIN')?.trim() ||
      cliProviderEnvText(env, 'KYBERION_AGY_CLI_BIN')?.trim() ||
      undefined,
  };
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
    intentExtractor: {
      extractor: new AgyCliIntentExtractor(agyOptions),
      provider,
      label: mode,
    },
    voiceBridge: {
      bridge: new AgyCliVoiceBridge(agyOptions),
      provider,
      label: mode,
    },
  };
});
