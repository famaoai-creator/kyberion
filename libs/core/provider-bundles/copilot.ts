import { cliProviderEnv, registerCliProviderBundle } from '../cli-provider-bundle.js';
import { buildCopilotAcpBackendFromEnv } from '../copilot-acp-reasoning-backend.js';

registerCliProviderBundle('copilot', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildCopilotAcpBackendFromEnv(env, options.model);
  return {
    mode,
    backend: { backend, provider, label: mode },
  };
});
