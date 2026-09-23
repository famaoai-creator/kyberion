import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  createScreenshotAnnotateContext,
  screenshotAnnotateHandoffLogicalPath,
  screenshotAnnotateReceiptLogicalPath,
} from './context.js';
import {
  createScreenshotAnnotateRequestHandler,
  main,
  readScreenshotAnnotateRequestBody,
  runScreenshotAnnotateServer,
  ScreenshotAnnotateRequestBodyTooLargeError,
  SCREENSHOT_ANNOTATE_DEFAULT_PORT,
  SCREENSHOT_ANNOTATE_MAX_BODY_BYTES,
  validateScreenshotAnnotateContentLength,
} from './server.js';

describe('screenshot annotate server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runScreenshotAnnotateServer(['--dry-run', '--quiet', '--tier', 'public']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: SCREENSHOT_ANNOTATE_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/screenshot-annotate$/);
    expect(result?.handoff).toMatch(/handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runScreenshotAnnotateServer([
        '65536',
        '--check',
        '--quiet',
        '--tier',
        'public',
      ]);
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects tenant-bound startup for an unregistered tenant', async () => {
    await expect(
      main(['--tenant', 'unregistered-screenshot-tenant', '--tier', 'public'], { dryRun: true })
    ).rejects.toThrow("tenant 'unregistered-screenshot-tenant' has no profile");
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(
      ['--out', 'active/shared/tmp/screenshot-annotate/demo', '--tier', 'public'],
      {
        dryRun: true,
        print: (value) => output.push(value),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/screenshot-annotate/demo',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readScreenshotAnnotateRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readScreenshotAnnotateRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      ScreenshotAnnotateRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateScreenshotAnnotateContentLength()).toBeUndefined();
    expect(validateScreenshotAnnotateContentLength('9')).toBe(9);
    expect(() => validateScreenshotAnnotateContentLength('not-a-number')).toThrow(
      ScreenshotAnnotateRequestBodyTooLargeError
    );
    expect(() =>
      validateScreenshotAnnotateContentLength(String(SCREENSHOT_ANNOTATE_MAX_BODY_BYTES + 1))
    ).toThrow(ScreenshotAnnotateRequestBodyTooLargeError);
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/screenshot-annotate/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = SCREENSHOT_ANNOTATE_REQUEST_TIMEOUT_MS');
    expect(source).toContain('SCREENSHOT_ANNOTATE_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
    expect(source).toContain('x-sa-token');
    expect(source).toContain('resolveTenant(requestedTenant.trim())');
  });
});

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function bootstrapOf(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="pad-bootstrap">([\s\S]*?)<\/script>/.exec(
    html
  );
  return JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>;
}

describe('screenshot annotate pad page, capture and export (live handler)', () => {
  const token = 'test-token-annotate';
  const root = `active/shared/tmp/screenshot-annotate-test-${process.pid}`;
  const out = `${root}/out`;
  const capture = `${root}/capture.png`;
  const padContext = createScreenshotAnnotateContext({
    artifact_ref: out,
    viewer_principal: 'test-annotator',
    tier: 'public',
  });
  let server: http.Server;
  let base = '';
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    saved.persona = process.env.KYBERION_PERSONA;
    saved.screenshot = process.env.KYBERION_SCREENSHOT_PATH;
    process.env.KYBERION_PERSONA = 'sovereign';
    safeWriteFile(pathResolver.rootResolve(capture), Buffer.from(PNG_1X1, 'base64'), {
      mkdir: true,
    });
    process.env.KYBERION_SCREENSHOT_PATH = pathResolver.rootResolve(capture);
    server = http.createServer(
      createScreenshotAnnotateRequestHandler({
        token,
        out,
        handoff: screenshotAnnotateHandoffLogicalPath(out),
        defaultInstruction: '',
        padContext,
        print: () => undefined,
      })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    safeRmSync(pathResolver.rootResolve(root), { recursive: true, force: true });
    safeRmSync(pathResolver.rootResolve(screenshotAnnotateReceiptLogicalPath(padContext)), {
      force: true,
    });
    for (const [key, env] of [
      ['persona', 'KYBERION_PERSONA'],
      ['screenshot', 'KYBERION_SCREENSHOT_PATH'],
    ] as const) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  });

  it('renders the shared-kit page with vocabulary copy in the requested locale', async () => {
    const en = await (await fetch(`${base}/?lang=en`)).text();
    const ja = await (await fetch(`${base}/`, { headers: { cookie: 'kb-ui-locale=ja' } })).text();

    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Screenshot Annotate');
    expect(en).toContain("from '/pad-ui/pad-client.js'");
    for (const id of ['sa-toolbar', 'sa-board', 'sa-instruction', 'sa-voice']) {
      expect(en).toContain(`id="${id}"`);
    }
    expect(en).toContain('accept_image_drop');
    expect(en).not.toMatch(/\b(?:prompt|confirm)\(/);
    expect(bootstrapOf(en)).toMatchObject({
      locale: 'en',
      token,
      exportUrl: '/export',
      screenshotUrl: '/screenshot',
    });
    expect(ja).toContain('<html lang="ja">');
    expect(bootstrapOf(ja).texts).toMatchObject({
      'screenshot_annotate:load_image': '画像を読み込む',
    });
  });

  it('serves the shared UI assets', async () => {
    const renderer = await fetch(`${base}/shared-ui/kyberion-ui.js`);
    expect(renderer.status).toBe(200);
    expect(renderer.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/design-tokens.css`)).status).toBe(200);
  });

  it('keeps the screenshot and export contracts', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-SA-Token': token };
    expect(
      (await fetch(`${base}/screenshot`, { method: 'POST', headers: { 'X-SA-Token': 'no' } }))
        .status
    ).toBe(403);
    const shot = (await (
      await fetch(`${base}/screenshot`, { method: 'POST', headers, body: '{}' })
    ).json()) as { ok: boolean; png_base64: string };
    expect(shot).toEqual({ ok: true, png_base64: PNG_1X1 });

    const response = await fetch(`${base}/export`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        png_base64: PNG_1X1,
        instruction: 'circle it',
        width: 1280,
        height: 720,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, image_bytes: Buffer.from(PNG_1X1, 'base64').length });
    expect(String(body.image_path)).toMatch(/latest\.png$/);
    expect(safeExistsSync(pathResolver.rootResolve(`${out}/latest.png`))).toBe(true);
    const handoff = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve(screenshotAnnotateHandoffLogicalPath(out)), {
          encoding: 'utf8',
        })
      )
    ) as Record<string, unknown>;
    expect(handoff).toMatchObject({
      kind: 'screenshot-annotate-handoff',
      instruction: 'circle it',
    });
  });
});
