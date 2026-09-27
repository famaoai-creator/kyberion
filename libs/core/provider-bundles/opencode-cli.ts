import { cliProviderEnv, registerCliProviderBundle } from '../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../agent-dispatch.js';
import { buildOpencodeCliBackendFromEnv } from '../opencode-cli-reasoning-backend.js';

registerCliProviderBundle('opencode-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildOpencodeCliBackendFromEnv(env, undefined, options.model);
  if (!backend && !options.force) return null;
  if (!backend) return null;
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
  };
});
