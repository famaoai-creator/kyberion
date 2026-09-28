import {
  cliProviderEnv,
  cliProviderEnvText,
  registerCliProviderBundle,
} from '../../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../../agent/agent-dispatch.js';
import { ClaudeAgentIntentExtractor } from '../claude-agent-intent-extractor.js';
import { ClaudeAgentReasoningBackend } from '../claude-agent-reasoning-backend.js';
import { ClaudeAgentVoiceBridge } from '../claude-agent-voice-bridge.js';

registerCliProviderBundle('claude-agent', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  if (
    !cliProviderEnvText(env, 'CLAUDECODE') &&
    !cliProviderEnvText(env, 'ANTHROPIC_API_KEY') &&
    !options.force
  ) {
    return null;
  }
  return {
    mode,
    backend: {
      backend: maybeWrapWithDispatcher(new ClaudeAgentReasoningBackend({ model: options.model })),
      provider,
      label: mode,
    },
    intentExtractor: {
      extractor: new ClaudeAgentIntentExtractor({ model: options.model }),
      provider,
      label: mode,
    },
    voiceBridge: {
      bridge: new ClaudeAgentVoiceBridge({ model: options.model }),
      provider,
      label: mode,
    },
  };
});
