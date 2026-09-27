import { cliProviderEnv, registerCliProviderBundle } from '../../cli-provider-bundle.js';
import { maybeWrapWithDispatcher } from '../../agent/agent-dispatch.js';
import { buildCursorCliBackendFromEnv } from '../cursor-cli-reasoning-backend.js';

registerCliProviderBundle('cursor-cli', (options) => {
  const env = cliProviderEnv(options);
  const { mode, provider } = options;
  const backend = buildCursorCliBackendFromEnv(env, undefined, options.model);
  if (!backend && !options.force) return null;
  if (!backend) return null;
  return {
    mode,
    backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
  };
});
