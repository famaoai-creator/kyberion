/**
 * Customer room — the customer-facing screen of customer decision hearing
 * (CD-07). One process serves one tenant; it is operator-launched because it
 * is exposed publicly through the public ingress in front of it.
 *
 * Start: `KYBERION_CUSTOMER_ROOM_TENANT=<slug> node dist/presence/displays/customer-room/server.js`
 * after `pnpm run build:repo`. Binds loopback only. Configuration:
 *   KYBERION_CUSTOMER_ROOM_TENANT  (required) the tenant whose agendas this room opens
 *   KYBERION_CUSTOMER_ROOM_PORT    (default 3046)
 */
import express from 'express';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { loadVocabularyCatalog } from '@agent/core/knowledge/vocabulary-catalog';
import { pathResolver } from '@agent/core/path-resolver';
import { installProcessGuards } from '@agent/core/process-guards';
import { safeReadFile } from '@agent/core/secure-io';
import { createFacadeSpawner } from './src/server/facade.js';
import { buildBundles, renderCustomerRoomPage } from './src/server/page.js';
import { registerCustomerRoomRoutes } from './src/server/routes.js';

export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** The configured tenant, or null when missing or not a valid slug. */
export function resolveRoomTenant(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return TENANT_SLUG_PATTERN.test(value) ? value : null;
}

export function createCustomerRoomApp(tenant: string): express.Express {
  const app = express();
  const staticDir = pathResolver.rootResolve('presence/displays/customer-room/static');
  const template = String(
    safeReadFile(path.join(staticDir, 'index.html'), { encoding: 'utf8' }) ?? ''
  );
  const bundles = buildBundles(loadVocabularyCatalog());
  registerCustomerRoomRoutes(app, {
    spawner: createFacadeSpawner({ tenant }),
    staticDir,
    jsDir: pathResolver.rootResolve('dist/presence/displays/customer-room/src/app'),
    renderPage: (acceptLanguage) => renderCustomerRoomPage(template, bundles, acceptLanguage),
    // A facade failure carries a diagnostic code: a warning, so it survives the default level.
    log: (message) =>
      message.includes('(diagnostic:') ? logger.warn(message) : logger.info(message),
  });
  return app;
}

function main(): void {
  installProcessGuards('customer-room');
  const tenant = resolveRoomTenant(getRegisteredEnvText('KYBERION_CUSTOMER_ROOM_TENANT'));
  if (!tenant) {
    logger.error(
      '[customer-room] not started — KYBERION_CUSTOMER_ROOM_TENANT is missing or not a valid tenant slug | set it to the tenant slug this room serves | presence/displays/customer-room/README.md'
    );
    process.exitCode = 1;
    return;
  }
  const port = Number(getRegisteredEnvText('KYBERION_CUSTOMER_ROOM_PORT') || 3046);
  const server = createServer(createCustomerRoomApp(tenant));
  server.listen(port, '127.0.0.1', () => {
    logger.info(`[customer-room] listening on http://127.0.0.1:${port} (tenant: ${tenant})`);
  });
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  main();
}
