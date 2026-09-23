import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReaddir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { createReportReviewContext, reviewReceiptLogicalPath } from './context.js';
import { RV_LAYER_CLOSE, RV_LAYER_OPEN } from './review-layer.js';
import {
  createReportReviewRequestHandler,
  main,
  readReportReviewRequestBody,
  readReportReviewTextFile,
  ReportReviewRequestBodyTooLargeError,
  REPORT_REVIEW_MAX_SAVE_BODY_BYTES,
  runReportReviewServer,
  validateReportReviewContentLength,
} from './server.js';

describe('report review server harness boundary', () => {
  it('rejects a directory replacement before report parsing', () => {
    expect(() => readReportReviewTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('validates a target without binding in dry-run mode', async () => {
    const result = await runReportReviewServer([
      'presence/displays/presence-studio/static/help.html',
      '--dry-run',
      '--quiet',
    ]);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: 8137,
      listening: false,
    });
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runReportReviewServer([
        'presence/displays/presence-studio/static/help.html',
        '65536',
        '--check',
        '--quiet',
      ]);

      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(['presence/displays/presence-studio/static/help.html'], {
      dryRun: true,
      print: (value) => output.push(value),
    });

    expect(result).toMatchObject({ ok: true, mode: 'dry-run', listening: false });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readReportReviewRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readReportReviewRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      ReportReviewRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateReportReviewContentLength()).toBeUndefined();
    expect(validateReportReviewContentLength('9')).toBe(9);
    expect(() => validateReportReviewContentLength('not-a-number')).toThrow(
      ReportReviewRequestBodyTooLargeError
    );
    expect(() =>
      validateReportReviewContentLength(String(REPORT_REVIEW_MAX_SAVE_BODY_BYTES + 1))
    ).toThrow(ReportReviewRequestBodyTooLargeError);
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/report-review/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso, readTextFile');
    expect(source).toContain('server.requestTimeout = REPORT_REVIEW_REQUEST_TIMEOUT_MS');
    expect(source).toContain('REPORT_REVIEW_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
  });
});

describe('report review server (live handler)', () => {
  const token = 'test-token-review';
  const dir = `active/shared/tmp/report-review-test-${process.pid}`;
  const target = `${dir}/report.html`;
  const original =
    '<!doctype html>\n<html><head><title>R</title></head><body><div class="wrap"><p>Body text</p></div></body></html>';
  const reviewContext = createReportReviewContext({
    artifact_ref: target,
    viewer_principal: 'test-reviewer',
    tier: 'public',
  });
  let server: http.Server;
  let base = '';
  let savedPersona: string | undefined;

  beforeAll(async () => {
    savedPersona = process.env.KYBERION_PERSONA;
    process.env.KYBERION_PERSONA = 'sovereign';
    safeWriteFile(pathResolver.rootResolve(target), original, { mkdir: true, encoding: 'utf8' });
    server = http.createServer(
      createReportReviewRequestHandler({ token, target, reviewContext, print: () => undefined })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    safeRmSync(pathResolver.rootResolve(dir), { recursive: true, force: true });
    safeRmSync(pathResolver.rootResolve(reviewReceiptLogicalPath(reviewContext)), { force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
  });

  it('serves the report with the save config and a served-asset layer in the request locale', async () => {
    const html = await (await fetch(`${base}/?lang=en`)).text();

    expect(html).toContain("<!--RV-SAVE-CONFIG--><script>window.__RV_SAVE__={url:'/save'");
    expect(html).toContain(token);
    expect(html.indexOf(RV_LAYER_OPEN)).toBeLessThan(html.indexOf('</body>'));
    expect(html).toContain('"assets":"served"');
    expect(html).toContain('"locale":"en"');
    expect(html).not.toContain('"modules"');
    expect(html).not.toMatch(/\b(?:confirm|prompt)\(/);

    const ja = await (await fetch(`${base}/`, { headers: { cookie: 'kb-ui-locale=ja' } })).text();
    expect(ja).toContain('"locale":"ja"');
  });

  it('serves the shared UI modules the layer imports', async () => {
    const renderer = await fetch(`${base}/shared-ui/kyberion-ui.js`);
    expect(renderer.status).toBe(200);
    expect(renderer.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/shared-ui/dialog.js`)).status).toBe(200);
  });

  it('keeps the save contract: token, injected parts stripped, backup written', async () => {
    const served = await (await fetch(`${base}/`)).text();
    const edited = served.replace(
      '<p>Body text</p>',
      '<p><mark class="rv-cmt" data-note="fix" title="fix">Body</mark> text</p>'
    );
    expect(
      (
        await fetch(`${base}/save`, {
          method: 'POST',
          headers: { 'x-rv-token': 'no' },
          body: edited,
        })
      ).status
    ).toBe(403);

    const response = await fetch(`${base}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', 'x-rv-token': token },
      body: edited,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^saved \(backup: report\.html\.bak-/);
    const saved = readTextFile(pathResolver.rootResolve(target));
    expect(saved).toContain('<mark class="rv-cmt" data-note="fix"');
    expect(saved).not.toContain('RV-LAYER');
    expect(saved).not.toContain('RV-SAVE-CONFIG');
    expect(saved).not.toContain(token);
    expect(safeReaddir(pathResolver.rootResolve(dir)).some((f) => f.includes('.bak-'))).toBe(true);
  });
});
