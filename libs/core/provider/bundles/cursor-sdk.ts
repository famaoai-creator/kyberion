import { cliProviderEnv, registerCliProviderBundle } from '../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../../agent/agent-dispatch.js';
import { buildCursorSdkBackendFromEnv } from '../cursor-sdk-reasoning-backend.js';

registerCliProviderBundle('cursor-sdk', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildCursorSdkBackendFromEnv(env, options.model);
  if (!backend) return null;
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
  };
});
