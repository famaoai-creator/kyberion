import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOST = '127.0.0.1';
const PORT = 18787;
const BASE_URL = `http://${HOST}:${PORT}`;
let surface: ChildProcess;

async function waitForSurface() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('OAuth callback surface did not become healthy');
}

describe('oauth callback surface', () => {
  beforeAll(async () => {
    surface = spawn(
      process.execPath,
      ['--import', './scripts/ts-loader.mjs', 'scripts/oauth_callback_surface.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KYBERION_OAUTH_CALLBACK_HOST: HOST,
          KYBERION_OAUTH_CALLBACK_PORT: String(PORT),
        },
        stdio: 'ignore',
      }
    );
    await waitForSurface();
  });

  afterAll(() => {
    surface?.kill('SIGTERM');
  });

  it('escapes provider-controlled values and sends restrictive browser headers', async () => {
    const response = await fetch(
      `${BASE_URL}/oauth/callback?error=${encodeURIComponent('<script>alert(1)</script>')}` +
        `&error_description=${encodeURIComponent('<img src=x onerror=alert(2)>')}`
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain('<img src=x onerror=alert(2)>');
  });

  it('does not expose internal exception details', async () => {
    const response = await fetch(`${BASE_URL}/oauth/callback`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain('Kyberion could not complete the OAuth callback.');
    expect(body).not.toContain('OAuth callback requires a code');
  });
});
