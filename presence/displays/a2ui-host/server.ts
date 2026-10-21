/**
 * A2UI host — a standalone viewer for any A2UI producer.
 *
 * Start: `node dist/presence/displays/a2ui-host/server.js` after
 * `pnpm run build:repo`. Binds loopback only. Configuration:
 *   KYBERION_A2UI_HOST_PORT       (default 3036)
 *   KYBERION_A2UI_HOST_PROVIDERS  `id=http://127.0.0.1:3031,...` (default: local surfaces)
 */
import express from 'express';
import { createServer } from 'node:http';
import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { installProcessGuards } from '@agent/core/process-guards';
import { parseProviders } from './src/server/providers.js';
import { registerA2UIHostRoutes } from './src/server/routes.js';

installProcessGuards('a2ui-host');

const PORT = Number(getRegisteredEnvText('KYBERION_A2UI_HOST_PORT') || 3036);
const HOST = '127.0.0.1';
const providers = parseProviders(
  getRegisteredEnvText('KYBERION_A2UI_HOST_PROVIDERS'),
  (pair, reason) => {
    logger.warn(`[a2ui-host] provider skipped (${reason}): ${pair}`);
  }
);

export const app: express.Express = express();
export const server = createServer(app);

registerA2UIHostRoutes(app, {
  providers,
  staticDir: pathResolver.rootResolve('presence/displays/a2ui-host/static'),
  jsDir: pathResolver.rootResolve('dist/presence/displays/a2ui-host/src'),
  log: (message) => logger.info(message),
});

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  server.listen(PORT, HOST, () => {
    logger.info(
      `[a2ui-host] listening on http://${HOST}:${PORT} (providers: ${providers.map((provider) => provider.id).join(', ') || 'none'})`
    );
  });
}
