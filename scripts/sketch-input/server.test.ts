import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { createSketchInputContext, sketchReceiptLogicalPath } from './context.js';
import {
  createSketchInputRequestHandler,
  main,
  readSketchInputRequestBody,
  runSketchInputServer,
  SketchInputRequestBodyTooLargeError,
  SKETCH_INPUT_DEFAULT_PORT,
  SKETCH_INPUT_MAX_BODY_BYTES,
  validateSketchInputContentLength,
} from './server.js';

describe('sketch input server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runSketchInputServer(['--dry-run', '--quiet']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: SKETCH_INPUT_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/sketch-input\/latest\.png$/);
    expect(result?.handoff).toMatch(/\.handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runSketchInputServer(['65536', '--check', '--quiet']);
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(['--out', 'active/shared/tmp/sketch-input/demo.png'], {
      dryRun: true,
      print: (value) => output.push(value),
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/sketch-input/demo.png',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readSketchInputRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readSketchInputRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      SketchInputRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateSketchInputContentLength()).toBeUndefined();
    expect(validateSketchInputContentLength('9')).toBe(9);
    expect(() => validateSketchInputContentLength('not-a-number')).toThrow(
      SketchInputRequestBodyTooLargeError
    );
    expect(() => validateSketchInputContentLength(String(SKETCH_INPUT_MAX_BODY_BYTES + 1))).toThrow(
      SketchInputRequestBodyTooLargeError
    );
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/sketch-input/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = SKETCH_INPUT_REQUEST_TIMEOUT_MS');
    expect(source).toContain('SKETCH_INPUT_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
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

describe('sketch input pad page and export (live handler)', () => {
  const token = 'test-token-sketch';
  const out = `active/shared/tmp/sketch-input-test-${process.pid}/latest.png`;
  const handoff = out.replace(/\.png$/, '.handoff.json');
  const sketchContext = createSketchInputContext({
    artifact_ref: out,
    viewer_principal: 'test-sketcher',
    tier: 'public',
  });
  let server: http.Server;
  let base = '';
  let savedPersona: string | undefined;

  beforeAll(async () => {
    // The export writes a receipt under active/shared/observability (like the CLI run).
    savedPersona = process.env.KYBERION_PERSONA;
    process.env.KYBERION_PERSONA = 'sovereign';
    server = http.createServer(
      createSketchInputRequestHandler({
        token,
        out,
        handoff,
        defaultInstruction: 'draft <b>',
        sketchContext,
        print: () => undefined,
      })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    safeRmSync(pathResolver.rootResolve(`active/shared/tmp/sketch-input-test-${process.pid}`), {
      recursive: true,
      force: true,
    });
    safeRmSync(pathResolver.rootResolve(sketchReceiptLogicalPath(sketchContext)), { force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
  });

  it('renders the shared-kit page in the requested locale', async () => {
    const response = await fetch(`${base}/?lang=en`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('href="/kyberion-ui.css"');
    expect(html).toContain("from '/pad-ui/pad-client.js'");
    for (const id of ['sk-toolbar', 'sk-board', 'sk-instruction', 'sk-voice']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('ui:sketch-board');
    expect(html).toContain('ui:voice-input');
    expect(html).not.toMatch(/\b(?:prompt|confirm)\(/);
    const bootstrap = bootstrapOf(html);
    expect(bootstrap).toMatchObject({
      locale: 'en',
      token,
      exportUrl: '/export',
      defaultInstruction: 'draft <b>',
      canvas: { width: 1280, height: 720 },
    });
    expect((bootstrap.texts as Record<string, string>)['sketch_input:handoff']).toBe(
      'Hand off to Kyberion'
    );
  });

  it('follows the kb-ui-locale cookie per request', async () => {
    const ja = await (await fetch(`${base}/`, { headers: { cookie: 'kb-ui-locale=ja' } })).text();
    const en = await (await fetch(`${base}/`, { headers: { cookie: 'kb-ui-locale=en' } })).text();

    expect(ja).toContain('<html lang="ja">');
    expect(bootstrapOf(ja).texts).toMatchObject({ 'sketch_input:handoff': 'Kyberionへ渡す' });
    expect(en).toContain('<html lang="en">');
  });

  it('serves the shared UI assets', async () => {
    const renderer = await fetch(`${base}/shared-ui/kyberion-ui.js`);
    const client = await fetch(`${base}/pad-ui/pad-client.js`);
    const css = await fetch(`${base}/kyberion-ui.css`);

    expect(renderer.status).toBe(200);
    expect(renderer.headers.get('content-type')).toContain('javascript');
    expect(client.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('keeps the export contract: token header, PNG + instruction, handoff file', async () => {
    const body = JSON.stringify({
      png_base64: PNG_1X1,
      instruction: ' do it ',
      width: 1280,
      height: 720,
    });
    const denied = await fetch(`${base}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SK-Token': 'wrong' },
      body,
    });
    expect(denied.status).toBe(403);

    const response = await fetch(`${base}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SK-Token': token },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^exported latest\.png \+ latest\.handoff\.json/);
    expect(safeExistsSync(pathResolver.rootResolve(out))).toBe(true);
    const written = JSON.parse(
      String(safeReadFile(pathResolver.rootResolve(handoff), { encoding: 'utf8' }))
    ) as Record<string, unknown>;
    expect(written).toMatchObject({
      kind: 'sketch-input-handoff',
      instruction: 'do it',
      image_width: 1280,
      image_height: 720,
    });
  });
});
