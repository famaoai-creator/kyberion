/* eslint-disable no-restricted-imports -- long-lived OAuth callback server; IP-08 で managed-process 経由へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import {
  beginServiceOAuth,
  logger,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core';

const serviceId = String(process.env.KYBERION_OAUTH_SERVICE_ID || process.argv[2] || '').trim();
const callbackHost = process.env.KYBERION_OAUTH_CALLBACK_HOST || '127.0.0.1';
const callbackPort = Number(process.env.KYBERION_OAUTH_CALLBACK_PORT || 8787);
const callbackPath = process.env.KYBERION_OAUTH_CALLBACK_PATH || '/oauth/callback';
const redirectUri = `http://${callbackHost}:${callbackPort}${callbackPath}`;

if (!serviceId) {
  console.error(
    'Usage: KYBERION_OAUTH_SERVICE_ID=<service_name> node --import ./scripts/ts-loader.mjs scripts/setup_oauth.ts'
  );
  process.exit(1);
}

const runtimeDir = pathResolver.sharedTmp('oauth/setup');
if (!safeExistsSync(runtimeDir)) {
  safeMkdir(runtimeDir, { recursive: true });
}

const server = spawn(
  'node',
  ['--import', './scripts/ts-loader.mjs', 'scripts/oauth_callback_surface.ts'],
  {
    cwd: pathResolver.rootDir(),
    env: {
      ...process.env,
      KYBERION_PERSONA: 'sovereign',
      AUTHORIZED_SCOPE: serviceId,
    },
    stdio: 'inherit',
  }
);

let shuttingDown = false;
const cleanup = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!server.killed) {
    server.kill('SIGTERM');
  }
};

process.on('SIGINT', () => {
  cleanup();
  process.exitCode = 130;
});
process.on('SIGTERM', () => {
  cleanup();
  process.exitCode = 143;
});
process.on('exit', cleanup);

async function main(): Promise<void> {
  logger.info(`Starting OAuth callback surface on ${redirectUri}...`);
  await new Promise<void>((resolve, reject) => {
    const timeout = Date.now() + 10_000;
    const poll = async () => {
      try {
        const health = await fetch(`http://${callbackHost}:${callbackPort}/health`);
        if (health.ok) {
          resolve();
          return;
        }
      } catch {
        // Keep polling until the server responds or the timeout elapses.
      }
      if (Date.now() >= timeout) {
        reject(new Error('OAuth callback surface did not become healthy in time'));
        return;
      }
      setTimeout(poll, 250).unref?.();
    };

    server.once('exit', (code, signal) => {
      if (!shuttingDown && code !== 0 && signal !== 'SIGTERM') {
        reject(new Error(`OAuth callback surface exited early (${code ?? signal})`));
      }
    });
    server.once('error', (error) => reject(error));
    void poll();
  });

  const result = beginServiceOAuth(serviceId, { redirectUri });
  const summaryPath = `${runtimeDir}/${serviceId}-setup.json`;
  safeWriteFile(
    summaryPath,
    JSON.stringify(
      {
        serviceId,
        redirectUri,
        authorizationUrl: result.authorizationUrl,
        state: result.state,
        scopes: result.scopes,
        ts: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );

  console.log('');
  console.log(`Service: ${serviceId}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log(`Authorization URL: ${result.authorizationUrl}`);
  console.log('');
  console.log('Open the URL above, approve the request, then return here.');
  console.log('Press ENTER after the browser shows Authorization Complete.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });

  cleanup();
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) {
      resolve();
      return;
    }
    server.once('exit', () => resolve());
  });

  console.log(
    `OAuth connection setup complete. Tokens should be stored in knowledge/personal/connections/${serviceId}.json`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`OAuth setup failed: ${message}`);
  cleanup();
  process.exitCode = 1;
});
