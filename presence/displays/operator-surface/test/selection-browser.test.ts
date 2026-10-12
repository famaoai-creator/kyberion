import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withExecutionContextAsync } from '@agent/core/authority';
import { safeSpawn, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { runSelectionBrowserSmoke, selectionBrowserLaunchOptions } from './selection-browser-smoke';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it('uses only supported stable Chrome with its sandbox and bounded startup', () => {
  expect(selectionBrowserLaunchOptions).toEqual({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    timeout: 20_000,
  });
  expect(Object.isFrozen(selectionBrowserLaunchOptions)).toBe(true);
});

// GitHub Actions' existing Ubuntu image provides stable Chrome. Missing/failed
// hosted launches FAIL. Local skips, including CI=true runs, are not browser validation.
it.skipIf(process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true')(
  'GitHub-hosted stable Chrome selection flows (local skip is NOT browser validation)',
  { timeout: 120_000 },
  async () =>
    withExecutionContextAsync('ecosystem_architect', async () => {
      const port = 33_000 + (process.pid % 2_000);
      const baseUrl = 'http://127.0.0.1:' + port;
      const fixture = path.join(here, 'browser');
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(Object.keys(process.env).map((key) => [key, ''])),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: 'true',
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
      };
      const server = safeSpawn(
        process.execPath,
        [
          require.resolve('next/dist/bin/next'),
          'dev',
          fixture,
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
          '--webpack',
        ],
        { cwd: path.resolve(here, '..'), env }
      );
      let log = '';
      let spawnError: Error | undefined;
      let closed = false;
      const exited = new Promise<void>((resolve) =>
        server.once('close', () => {
          closed = true;
          resolve();
        })
      );
      server.once('error', (error) => {
        spawnError = error;
      });
      const capture = (data: Buffer | string) => {
        log = (log + String(data)).slice(-16_000);
      };
      server.stdout?.on('data', capture);
      server.stderr?.on('data', capture);
      const controller = new AbortController();
      let scenarioTimer: ReturnType<typeof setTimeout> | undefined;
      const logPath = pathResolver.rootResolve(
        'active/shared/tmp/operator-selection-browser-server-' + process.pid + '.log'
      );
      try {
        const startupDeadline = Date.now() + 45_000;
        let ready = false;
        while (Date.now() < startupDeadline) {
          if (spawnError) throw spawnError;
          if (closed) throw new Error('Synthetic fixture exited during startup: ' + log);
          try {
            const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
            if (
              response.ok &&
              (await response.text()).includes('Synthetic selection settings fixture')
            ) {
              ready = true;
              break;
            }
          } catch {
            /* Bounded startup wait only; browser errors never become skips. */
          }
          await pause(200);
        }
        expect(ready, 'Synthetic fixture startup failed: ' + log).toBe(true);
        // Startup45s + assertions65s + cleanup5s fits the explicit120s test budget.
        scenarioTimer = setTimeout(() => controller.abort(), 65_000);
        const report = await runSelectionBrowserSmoke({ baseUrl, signal: controller.signal });
        expect(report).toMatchObject({
          ok: true,
          browserChannel: 'chrome',
          browserVersion: expect.any(String),
          previewWrites: 0,
          repeatedSaveWrites: 1,
          pendingCancel: true,
          staleRejected: true,
          backForward: true,
          readonly: true,
        });
        expect(controller.signal.aborted).toBe(false);
        process.stdout.write('[selection-browser] ' + JSON.stringify(report) + '\n');
      } finally {
        if (scenarioTimer) clearTimeout(scenarioTimer);
        controller.abort();
        if (!closed) server.kill('SIGTERM');
        await Promise.race([exited, pause(3_000)]);
        if (!closed) {
          server.kill('SIGKILL');
          await Promise.race([exited, pause(2_000)]);
        }
        safeWriteFile(logPath, log);
        expect(closed, 'Synthetic fixture process must terminate').toBe(true);
      }
    })
);
