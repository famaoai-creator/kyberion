/* eslint-disable no-restricted-imports -- long-lived OAuth callback server; IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { beginInteractiveServiceOAuth } from '@agent/core/oauth-broker';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

let activeCleanup: (() => void) | undefined;
type Print = (value: unknown) => void;
const defaultPrint: Print = (value) => logger.info(String(value));

export async function main(args: string[] = [], print: Print = defaultPrint): Promise<void> {
  const usage =
    'Usage: KYBERION_OAUTH_SERVICE_ID=<service_name> node --import ./scripts/ts-loader.mjs scripts/setup_oauth.ts';
  if (args.includes('--help') || args.includes('-h')) {
    print(usage);
    throw new ScriptExitError(0, '', true);
  }
  const serviceId = String(
    getRegisteredEnvText('KYBERION_OAUTH_SERVICE_ID') || args[0] || ''
  ).trim();
  if (!serviceId) {
    print(usage);
    throw new ScriptExitError(1, '', true);
  }
  const callbackHost = getRegisteredEnvText('KYBERION_OAUTH_CALLBACK_HOST') || '127.0.0.1';
  const callbackPort = Number(getRegisteredEnvText('KYBERION_OAUTH_CALLBACK_PORT') || 8787);
  const callbackPath = getRegisteredEnvText('KYBERION_OAUTH_CALLBACK_PATH') || '/oauth/callback';
  const redirectUri = `http://${callbackHost}:${callbackPort}${callbackPath}`;
  const runtimeDir = pathResolver.sharedTmp('oauth/setup');
  if (!safeExistsSync(runtimeDir)) safeMkdir(runtimeDir, { recursive: true });
  const server = spawn(
    'node',
    ['--import', './scripts/ts-loader.mjs', 'scripts/oauth_callback_surface.ts'],
    {
      cwd: pathResolver.rootDir(),
      env: { ...process.env, KYBERION_PERSONA: 'sovereign', AUTHORIZED_SCOPE: serviceId },
      stdio: 'inherit',
    }
  );
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!server.killed) server.kill('SIGTERM');
  };
  activeCleanup = cleanup;
  process.once('SIGINT', () => {
    cleanup();
    process.exitCode = 130;
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exitCode = 143;
  });
  process.once('exit', cleanup);

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

  const result = beginInteractiveServiceOAuth(serviceId, { redirectUri });
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
        ts: nowIso(),
      },
      null,
      2
    ) + '\n'
  );

  print('');
  print(`Service: ${serviceId}`);
  print(`Redirect URI: ${redirectUri}`);
  print(`Authorization URL: ${result.authorizationUrl}`);
  print('');
  print('Open the URL above, approve the request, then return here.');
  print('Press ENTER after the browser shows Authorization Complete.');

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

  print(
    `OAuth connection setup complete. Tokens should be stored in knowledge/personal/connections/${serviceId}.json`
  );
}

export const runOAuthSetup = defineScript({
  name: 'oauth:setup',
  flags: [],
  run: ({ argv, print }) => runOAuthSetupForService(argv[0], print),
});

export async function runOAuthSetupForService(
  serviceId: string,
  print: Print = defaultPrint
): Promise<void> {
  try {
    await main([serviceId], print);
  } catch (error) {
    activeCleanup?.();
    throw error;
  } finally {
    activeCleanup = undefined;
  }
}

if (
  isDirectScript(import.meta.url, 'setup_oauth.ts') ||
  isDirectScript(import.meta.url, 'setup_oauth.js')
)
  void runOAuthSetup();
