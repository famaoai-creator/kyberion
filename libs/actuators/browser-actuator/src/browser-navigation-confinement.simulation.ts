/** Explicit, owned-loopback integration probe; not part of the default test suite.
 * node --import ./scripts/ts-loader.mjs libs/actuators/browser-actuator/src/browser-navigation-confinement.simulation.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { safeExecResult, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveStorageFloor } from '@agent/core/storage-layout';
import { createScratchWorkspace, releaseWorkspace } from '@agent/core/workforce/workspace-ledger';
import {
  installIsolatedNavigationConfinement,
  permitIsolatedNavigation,
} from './browser-navigation-confinement.js';

const scratchRoot = resolveStorageFloor(
  'scratch',
  { kind: 'tier', tier: 'public' },
  'browser-navigation-simulation'
);
const options = {
  root: scratchRoot,
  allowedRoots: [scratchRoot],
  ledgerPath: path.join(scratchRoot, `ledger-${randomUUID()}.json`),
};
const workspace = createScratchWorkspace(
  { session_id: `browser-network-${randomUUID()}` },
  options
);
const key = path.join(workspace.path, 'fixture-key.pem');
const cert = path.join(workspace.path, 'fixture-cert.pem');
const counts: Record<string, number> = {};
const count = (label: string) => {
  counts[label] = (counts[label] ?? 0) + 1;
};
const servers: Server[] = [];
const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `https://127.0.0.1:${address.port}`;
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const generated = safeExecResult('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  const tls = { key: safeReadFile(key), cert: safeReadFile(cert) };
  const otherOrigin = await listen(
    createServer(tls, (request, response) => {
      count(`other:${request.method}:${request.url}`);
      response.end('must never reach this server');
    })
  );
  const origin = await listen(
    createServer(tls, (request, response) => {
      count(`approved:${request.method}:${request.url}`);
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `${otherOrigin}/escaped` });
        response.end();
      } else if (request.url === '/same.png') {
        response.setHeader('content-type', 'image/png');
        response.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
            'base64'
          )
        );
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<title>Owned confinement fixture</title><img src="/same.png"><img src="${otherOrigin}/evil.png"><img src="/query.png?secret=synthetic"><script src="/script.js"></script><script>window.fixtureScriptExecuted=true;fetch('/script-executed');navigator.serviceWorker.register('/service-worker.js')</script>`
        );
      }
    })
  );
  browser = await chromium.launch({ headless: true });
  // Only test exception: self-signed owned HTTPS. Production factory has no TLS override.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    javaScriptEnabled: false,
    acceptDownloads: false,
  });
  await installIsolatedNavigationConfinement(context);
  const deniedPage = await context.newPage();
  await assert.rejects(deniedPage.goto(`${origin}/before-admission`));
  await deniedPage.close();
  assert.deepEqual(counts, {});
  // Synthetic fixture admission only: no external approval or Charter is fabricated.
  permitIsolatedNavigation(context, `${origin}/public`);
  const page = await context.newPage();
  await page.goto(`${origin}/public`, { waitUntil: 'networkidle' });
  assert.equal(await page.title(), 'Owned confinement fixture');
  assert.equal(await page.evaluate(() => 'fixtureScriptExecuted' in window), false);
  assert.equal(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    0
  );
  assert.equal(counts['approved:GET:/public'], 1);
  assert.equal(counts['approved:GET:/same.png'], 1);
  const afterAllowed = { ...counts };
  for (const target of [
    `${origin}/redirect`,
    `${otherOrigin}/direct`,
    `${origin}/query?secret=synthetic`,
  ]) {
    const denied = await context.newPage();
    await assert.rejects(denied.goto(target));
    await denied.close();
  }
  assert.equal(counts['approved:GET:/redirect'], 1);
  assert.deepEqual(
    Object.keys(counts).sort(),
    ['approved:GET:/public', 'approved:GET:/redirect', 'approved:GET:/same.png'].sort()
  );
  await context.close();
  const report = path.join(workspace.path, 'report.json');
  safeWriteFile(
    report,
    JSON.stringify(
      {
        status: 'passed',
        engine: 'real Chromium',
        admission: 'synthetic owned-loopback only; shared approval lifecycle not simulated',
        tls: 'self-signed fixture exception in test context only',
        context: {
          fresh: true,
          serviceWorkers: 'block',
          javaScriptEnabled: false,
          acceptDownloads: false,
        },
        assertions: [
          'pre-admission zero transport',
          'approved GET and same-origin image received',
          'cross-origin redirect never followed',
          'cross-origin navigation/subresource zero transport',
          'query navigation/subresource zero transport',
          'inline/external scripts and service worker zero execution/transport',
        ],
        afterAllowed,
        finalWireCounts: counts,
      },
      null,
      2
    )
  );
  process.stdout.write(`SIMULATION_REPORT ${report}\n`);
} finally {
  await browser?.close();
  await Promise.all(
    servers.map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    })
  );
  safeRmSync(key, { force: true });
  safeRmSync(cert, { force: true });
  releaseWorkspace(workspace.id, options);
  safeRmSync(options.ledgerPath, { force: true });
}
