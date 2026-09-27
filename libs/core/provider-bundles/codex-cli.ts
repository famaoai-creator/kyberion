import { cliProviderEnv, registerCliProviderBundle } from '../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../agent-dispatch.js';
import { CodexCliIntentExtractor } from '../codex-cli-intent-extractor.js';
import { CodexCliReasoningBackend } from '../codex-cli-reasoning-backend.js';
import { CodexCliVoiceBridge } from '../codex-cli-voice-bridge.js';
import { buildCodexCliQueryOptionsFromEnv } from '../codex-cli-query.js';

registerCliProviderBundle('codex-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const codexOptions = {
    ...buildCodexCliQueryOptionsFromEnv(env),
    ...(options.model ? { model: options.model } : {}),
  };
  const backend = new CodexCliReasoningBackend(codexOptions);
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
    intentExtractor: {
      extractor: new CodexCliIntentExtractor(codexOptions),
      provider,
      label: mode,
    },
    voiceBridge: {
      bridge: new CodexCliVoiceBridge(codexOptions),
      provider,
      label: mode,
    },
  };
});
