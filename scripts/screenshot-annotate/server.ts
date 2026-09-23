/**
 * server.ts — screenshot-annotate localhost pad
 *
 * Image-backed annotate board on 127.0.0.1. Drop/paste preferred; optional
 * darwin `screencapture -x` via POST /screenshot.
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/screenshot-annotate/server.ts \
 *     [--out <dir>] [--instruction <text>] [port]
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExecResultAsync,
  safeWriteFile,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
} from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycle,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveTenant } from '@agent/core/tenant-registry';
import { t as catalogT } from '@agent/core/t';
import {
  LOCAL_PAD_COMMON_FLAGS,
  LocalPadRequestBodyTooLargeError,
  option,
  positionalArgs,
  readLocalPadRequestBody,
  validateLocalPadContentLength,
} from '../lib/local-artifact-pad.js';
import {
  createScreenshotAnnotateContext,
  screenshotAnnotateHandoffLogicalPath,
  screenshotAnnotateReceiptLogicalPath,
  screenshotAnnotateSessionDir,
} from './context.js';
import { screenshotAnnotatePageHtml } from './page.js';
import { handlePadUiAsset, resolvePadLocale } from '../lib/pad-ui.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { composeLegacyCapture } from '../personal-pads/legacy.js';

export interface ScreenshotAnnotateServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  out: string;
  handoff: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: ReturnType<typeof createScreenshotAnnotateContext>['scope'];
  listening: boolean;
}

export const SCREENSHOT_ANNOTATE_MAX_BODY_BYTES = 24 * 1024 * 1024;
export const SCREENSHOT_ANNOTATE_MAX_CONCURRENT_HEAVY_REQUESTS = 1;
export const SCREENSHOT_ANNOTATE_REQUEST_TIMEOUT_MS = 60_000;
export const SCREENSHOT_ANNOTATE_HEADERS_TIMEOUT_MS = 10_000;
export const SCREENSHOT_ANNOTATE_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const SCREENSHOT_ANNOTATE_DEFAULT_PORT = 8150;

export { LocalPadRequestBodyTooLargeError as ScreenshotAnnotateRequestBodyTooLargeError };

export async function readScreenshotAnnotateRequestBody(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes = SCREENSHOT_ANNOTATE_MAX_BODY_BYTES
): Promise<string> {
  return readLocalPadRequestBody(source, maxBytes);
}

export function validateScreenshotAnnotateContentLength(
  value?: string,
  maxBytes = SCREENSHOT_ANNOTATE_MAX_BODY_BYTES
): number | undefined {
  return validateLocalPadContentLength(value, maxBytes);
}

export function defaultScreenshotAnnotateOutputDir(): string {
  return pathResolver.sharedTmp('screenshot-annotate');
}

function lifecyclePrincipal(viewerPrincipal: string): {
  kind: 'nhi' | 'human' | 'service';
  id: string;
} {
  const id = viewerPrincipal.trim();
  if (/^(?:nhi|agent):/u.test(id)) return { kind: 'nhi', id };
  if (/^(?:service|runtime):/u.test(id)) return { kind: 'service', id };
  return { kind: 'human', id };
}

function isPng(buf: Buffer): boolean {
  return buf.byteLength >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
}

export interface ScreenshotAnnotateRequestHandlerOptions {
  token: string;
  out: string;
  handoff: string;
  defaultInstruction: string;
  padContext: ReturnType<typeof createScreenshotAnnotateContext>;
  print: (value: unknown) => void;
}

/** The pad's request handler (page, shared UI assets, health, screenshot, export). */
export function createScreenshotAnnotateRequestHandler(
  options: ScreenshotAnnotateRequestHandlerOptions
): http.RequestListener {
  const { token: TOKEN, out, handoff, defaultInstruction, padContext, print } = options;
  let activeHeavyRequests = 0;
  function acquireHeavyRequest(): (() => void) | undefined {
    if (activeHeavyRequests >= SCREENSHOT_ANNOTATE_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  function rejectIfUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.headers['x-sa-token'] !== TOKEN) {
      res.writeHead(403);
      res.end('bad token');
      req.resume();
      return true;
    }
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) {
      res.writeHead(403);
      res.end('bad origin');
      req.resume();
      return true;
    }
    try {
      validateScreenshotAnnotateContentLength(req.headers['content-length']);
    } catch {
      res.writeHead(413);
      res.end('request body too large');
      req.resume();
      return true;
    }
    return false;
  }

  function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async function tryOsScreenshot(): Promise<
    { ok: true; png_base64: string } | { ok: false; error: string }
  > {
    const envPath = getRegisteredEnvText('KYBERION_SCREENSHOT_PATH')?.trim();
    if (envPath) {
      try {
        const buf = safeReadFile(envPath, { encoding: null }) as Buffer;
        if (!isPng(buf)) return { ok: false, error: 'KYBERION_SCREENSHOT_PATH is not a PNG' };
        return { ok: true, png_base64: buf.toString('base64') };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'OS screenshot only on darwin (or set KYBERION_SCREENSHOT_PATH); paste/drop instead',
      };
    }
    const captureName = `capture-${nowIso().replace(/[:.]/g, '-')}.png`;
    const capturePath = path.join(out, 'captures', captureName);
    try {
      safeMkdir(path.join(out, 'captures'), { recursive: true });
      assertSafeRepositoryPath(capturePath, { allowMissingLeaf: true });
      const result = await safeExecResultAsync('screencapture', ['-x', capturePath], {
        timeout: 20_000,
        maxOutputMB: 1,
      });
      if (result.status !== 0) {
        throw result.error ?? new Error(result.stderr || 'screencapture failed');
      }
      const buf = safeReadFile(capturePath, { encoding: null }) as Buffer;
      if (!isPng(buf)) {
        try {
          safeUnlinkSync(capturePath);
        } catch {
          /* ignore */
        }
        return { ok: false, error: 'screencapture did not produce a PNG' };
      }
      return { ok: true, png_base64: buf.toString('base64') };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function persistExport(payload: {
    png_base64?: string;
    instruction?: string;
    width?: number;
    height?: number;
  }): Record<string, unknown> {
    const b64 = typeof payload.png_base64 === 'string' ? payload.png_base64.trim() : '';
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      throw new Error('png_base64 required');
    }
    const png = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (!isPng(png)) {
      throw new Error('not a png');
    }
    composeLegacyCapture('screenshot-annotate', {
      png_base64: b64,
      instruction: payload.instruction,
    });
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
    const captureId = `${padContext.session_id}-${randomUUID().slice(0, 8)}`;
    const sessionDir = screenshotAnnotateSessionDir(out, captureId);
    safeMkdir(sessionDir, { recursive: true });
    const imagePath = path.join(sessionDir, 'latest.png');
    const latestPath = path.join(out, 'latest.png');
    safeWriteFile(imagePath, png, { mkdir: true });
    safeWriteFile(latestPath, png, { mkdir: true });
    const handoffBody = {
      kind: 'screenshot-annotate-handoff',
      version: 1,
      pad_session_id: padContext.session_id,
      capture_session_id: captureId,
      artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
      viewer_principal: padContext.viewer_principal,
      scope: padContext.scope,
      exported_at: nowIso(),
      image_path: portableProtocolServicePathRef(latestPath),
      session_image_path: portableProtocolServicePathRef(imagePath),
      image_bytes: png.byteLength,
      image_width: payload.width,
      image_height: payload.height,
      instruction,
      processing: {
        auto_start_mission: false,
        suggested_ops: ['vision:annotate-review', 'artifact:ingest-image'],
        note: 'Pick up image_path + instruction; do not auto-start a mission in MVP.',
      },
    };
    const sessionHandoff = path.join(sessionDir, 'handoff.json');
    safeWriteFile(sessionHandoff, JSON.stringify(handoffBody, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(handoff, JSON.stringify(handoffBody, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(
      screenshotAnnotateReceiptLogicalPath(padContext),
      JSON.stringify(
        {
          pad_session_id: padContext.session_id,
          capture_session_id: captureId,
          artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
          viewer_principal: padContext.viewer_principal,
          scope: padContext.scope,
          exported_at: nowIso(),
          image_path: portableProtocolServicePathRef(latestPath),
          handoff_path: portableProtocolServicePathRef(handoff),
          image_bytes: png.byteLength,
          instruction_chars: instruction.length,
        },
        null,
        2
      ),
      { mkdir: true, encoding: 'utf8' }
    );
    return {
      ok: true,
      capture_session_id: captureId,
      session_dir: portableProtocolServicePathRef(sessionDir),
      handoff_path: portableProtocolServicePathRef(handoff),
      image_path: portableProtocolServicePathRef(latestPath),
      image_bytes: png.byteLength,
    };
  }

  return (req, res) => {
    try {
      if (handlePadUiAsset(req, res)) return;
      const pathname = (req.url || '').split(/[?#]/, 1)[0];
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another screenshot-annotate request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const html = screenshotAnnotatePageHtml({
          locale: resolvePadLocale(req),
          token: TOKEN,
          exportUrl: '/export',
          screenshotUrl: '/screenshot',
          defaultInstruction,
          outLabel: out,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.method === 'POST' && (req.url === '/export' || req.url === '/screenshot')) {
        if (rejectIfUnauthorized(req, res)) return;
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another screenshot-annotate request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        const route = req.url;
        void (async () => {
          try {
            const raw = await readScreenshotAnnotateRequestBody(
              req,
              SCREENSHOT_ANNOTATE_MAX_BODY_BYTES
            );
            if (route === '/screenshot') {
              const captured = await tryOsScreenshot();
              if ('error' in captured) {
                jsonResponse(res, 501, { ok: false, error: captured.error });
                return;
              }
              jsonResponse(res, 200, { ok: true, png_base64: captured.png_base64 });
              return;
            }
            let payload: {
              png_base64?: string;
              instruction?: string;
              width?: number;
              height?: number;
            };
            try {
              payload = JSON.parse(raw || '{}') as typeof payload;
            } catch {
              jsonResponse(res, 400, { ok: false, error: 'invalid json' });
              return;
            }
            try {
              const result = persistExport(payload);
              jsonResponse(res, 200, result);
              print(
                `[export] wrote ${String(result.image_path)} handoff=${String(result.handoff_path)}`
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const status =
                message === 'png_base64 required' || message === 'not a png' ? 400 : 500;
              jsonResponse(res, status, { ok: false, error: message });
            }
          } catch (e: unknown) {
            if (e instanceof LocalPadRequestBodyTooLargeError) {
              if (!res.headersSent) {
                res.writeHead(413);
                res.end('request body too large');
              }
              req.resume();
            } else if (!res.headersSent) {
              jsonResponse(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
            print(`[screenshot-annotate] ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            release();
          }
        })();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e: unknown) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(e instanceof Error ? e.message : String(e));
      }
    }
  };
}

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<ScreenshotAnnotateServerResult | undefined> {
  const positionals = positionalArgs(args, LOCAL_PAD_COMMON_FLAGS);
  const port = Number(positionals[0] || SCREENSHOT_ANNOTATE_DEFAULT_PORT);
  const out = option(args, '--out') || defaultScreenshotAnnotateOutputDir();
  const defaultInstruction = option(args, '--instruction') || '';
  assertProtocolServiceRegistered('screenshot-annotate');

  const tier = (option(args, '--tier') || 'personal') as 'public' | 'confidential' | 'personal';
  if (!['public', 'confidential', 'personal'].includes(tier)) {
    throw new ScriptExitError(1, `invalid tier: ${tier}`);
  }
  const serverTenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
  const cliTenant = option(args, '--tenant')?.trim();
  if (serverTenant && cliTenant && serverTenant !== cliTenant) {
    throw new ScriptExitError(1, 'CLI tenant does not match server-side KYBERION_TENANT scope');
  }
  if (tier !== 'public' && !serverTenant) {
    throw new ScriptExitError(
      1,
      'confidential and personal pads require server-side KYBERION_TENANT scope'
    );
  }
  const requestedTenant = serverTenant || cliTenant;
  if (requestedTenant?.trim()) {
    resolveTenant(requestedTenant.trim());
  }
  const padContext = createScreenshotAnnotateContext({
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-annotator',
    tier,
    tenant_slug: requestedTenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScriptExitError(1, `invalid port: ${port}`);
  }

  const handoff = screenshotAnnotateHandoffLogicalPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: ScreenshotAnnotateServerResult = {
    ok: true,
    mode,
    out,
    handoff,
    port,
    url,
    artifact_ref: padContext.artifact_ref,
    scope: padContext.scope,
    listening: false,
  };
  const print = options.print ?? (() => undefined);
  if (options.dryRun || options.check) {
    print(preview);
    return preview;
  }

  const TOKEN = randomBytes(16).toString('hex');
  const server = http.createServer(
    createScreenshotAnnotateRequestHandler({
      token: TOKEN,
      out,
      handoff,
      defaultInstruction,
      padContext,
      print,
    })
  );
  server.requestTimeout = SCREENSHOT_ANNOTATE_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SCREENSHOT_ANNOTATE_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SCREENSHOT_ANNOTATE_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[screenshot-annotate] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'screenshot-annotate',
          action: 'start',
          status: 'started',
          scope: padContext.scope,
          actorRole: 'surface_runtime',
          principal: lifecyclePrincipal(padContext.viewer_principal),
          requestedBy: padContext.viewer_principal,
          correlationId: padContext.session_id,
          metadata: {
            port,
            artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
            out: portableProtocolServicePathRef(out),
          },
        });
      } catch (error) {
        server.close(() => undefined);
        reject(
          new ScriptExitError(
            1,
            `[screenshot-annotate] start lifecycle receipt unavailable: ${error}`
          )
        );
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Screenshot annotate server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${padContext.artifact_ref}`);
        print(
          `  scope  : ${padContext.scope.scope_kind}/${padContext.scope.tenant_slug || 'system'}`
        );
        print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only)`);
        print(`  ${catalogT('screenshot_annotate:server_usage_hint')}`);
      }
      resolve();
    });
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'screenshot-annotate',
        action: 'stop',
        status: 'stopped',
        scope: padContext.scope,
        actorRole: 'surface_runtime',
        principal: lifecyclePrincipal(padContext.viewer_principal),
        requestedBy: padContext.viewer_principal,
        correlationId: padContext.session_id,
      });
    } catch (error) {
      print(`[screenshot-annotate] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runScreenshotAnnotateServer = defineScript({
  name: 'screenshot-annotate:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runScreenshotAnnotateServer();
}
