/**
 * server.ts — sketch-input localhost board (report-review twin)
 *
 * Serves a paint-like board on 127.0.0.1. Browser draws diagrams/text (voice for
 * instruction text), then posts PNG + instruction; server writes PNG + handoff.json
 * for Kyberion to pick up (no auto mission start in MVP).
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/sketch-input/server.ts \
 *     [--out <path.png>] [--instruction <text>] [port]
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { safeWriteFile } from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycle,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  createSketchInputContext,
  sketchHandoffLogicalPath,
  sketchReceiptLogicalPath,
} from './context.js';
import { sketchPageHtml } from './sketch-page.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export interface SketchInputServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  out: string;
  handoff: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: ReturnType<typeof createSketchInputContext>['scope'];
  listening: boolean;
}

export const SKETCH_INPUT_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const SKETCH_INPUT_MAX_CONCURRENT_HEAVY_REQUESTS = 1;
export const SKETCH_INPUT_REQUEST_TIMEOUT_MS = 30_000;
export const SKETCH_INPUT_HEADERS_TIMEOUT_MS = 10_000;
export const SKETCH_INPUT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const SKETCH_INPUT_DEFAULT_PORT = 8147;

export class SketchInputRequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = 'SketchInputRequestBodyTooLargeError';
  }
}

export async function readSketchInputRequestBody(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes = SKETCH_INPUT_MAX_BODY_BYTES
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new SketchInputRequestBodyTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function validateSketchInputContentLength(
  value?: string,
  maxBytes = SKETCH_INPUT_MAX_BODY_BYTES
): number | undefined {
  if (value === undefined) return undefined;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw new SketchInputRequestBodyTooLargeError(maxBytes);
  }
  return bytes;
}

export function defaultSketchOutputPath(): string {
  return pathResolver.sharedTmp('sketch-input/latest.png');
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (
        arg === '--out' ||
        arg === '--instruction' ||
        arg === '--artifact-ref' ||
        arg === '--tier' ||
        arg === '--tenant' ||
        arg === '--organization-id' ||
        arg === '--project-id' ||
        arg === '--mission-id'
      ) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<SketchInputServerResult | undefined> {
  const positionals = positionalArgs(args);
  const port = Number(positionals[0] || SKETCH_INPUT_DEFAULT_PORT);
  const out = option(args, '--out') || defaultSketchOutputPath();
  const defaultInstruction = option(args, '--instruction') || '';
  if (!out.toLowerCase().endsWith('.png')) {
    throw new ScriptExitError(1, 'output path must end with .png');
  }
  assertProtocolServiceRegistered('sketch-input');

  const tier = (option(args, '--tier') || 'public') as 'public' | 'confidential' | 'personal';
  if (!['public', 'confidential', 'personal'].includes(tier)) {
    throw new ScriptExitError(1, `invalid tier: ${tier}`);
  }
  const sketchContext = createSketchInputContext({
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-sketcher',
    tier,
    tenant_slug: option(args, '--tenant') || getRegisteredEnvText('KYBERION_TENANT'),
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScriptExitError(1, `invalid port: ${port}`);
  }

  const handoff = sketchHandoffLogicalPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: SketchInputServerResult = {
    ok: true,
    mode,
    out,
    handoff,
    port,
    url,
    artifact_ref: sketchContext.artifact_ref,
    scope: sketchContext.scope,
    listening: false,
  };
  const print = options.print ?? (() => undefined);
  if (options.dryRun || options.check) {
    print(preview);
    return preview;
  }

  const TOKEN = randomBytes(16).toString('hex');
  let activeHeavyRequests = 0;
  function acquireHeavyRequest(): (() => void) | undefined {
    if (activeHeavyRequests >= SKETCH_INPUT_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another sketch request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const html = sketchPageHtml({
          token: TOKEN,
          exportUrl: '/export',
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
      if (req.method === 'POST' && req.url === '/export') {
        if (req.headers['x-sk-token'] !== TOKEN) {
          res.writeHead(403);
          res.end('bad token');
          req.resume();
          return;
        }
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) {
          res.writeHead(403);
          res.end('bad origin');
          req.resume();
          return;
        }
        try {
          validateSketchInputContentLength(req.headers['content-length']);
        } catch {
          res.writeHead(413);
          res.end('request body too large');
          req.resume();
          return;
        }
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another sketch request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        void (async () => {
          try {
            const raw = await readSketchInputRequestBody(req, SKETCH_INPUT_MAX_BODY_BYTES);
            let payload: {
              png_base64?: string;
              instruction?: string;
              width?: number;
              height?: number;
            };
            try {
              payload = JSON.parse(raw) as typeof payload;
            } catch {
              res.writeHead(400);
              res.end('invalid json');
              return;
            }
            const b64 = typeof payload.png_base64 === 'string' ? payload.png_base64.trim() : '';
            if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
              res.writeHead(400);
              res.end('png_base64 required');
              return;
            }
            const png = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
            if (png.byteLength < 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
              res.writeHead(400);
              res.end('not a png');
              return;
            }
            const instruction =
              typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
            safeWriteFile(out, png, { mkdir: true });
            const handoffBody = {
              kind: 'sketch-input-handoff',
              version: 1,
              sketch_session_id: sketchContext.sketch_session_id,
              artifact_ref: portableProtocolServicePathRef(sketchContext.artifact_ref),
              viewer_principal: sketchContext.viewer_principal,
              scope: sketchContext.scope,
              exported_at: nowIso(),
              image_path: portableProtocolServicePathRef(out),
              image_bytes: png.byteLength,
              image_width: payload.width,
              image_height: payload.height,
              instruction,
              processing: {
                auto_start_mission: false,
                note: 'Pick up image_path + instruction and run the desired Kyberion pipeline or mission.',
              },
            };
            safeWriteFile(handoff, JSON.stringify(handoffBody, null, 2), {
              mkdir: true,
              encoding: 'utf8',
            });
            safeWriteFile(
              sketchReceiptLogicalPath(sketchContext),
              JSON.stringify(
                {
                  sketch_session_id: sketchContext.sketch_session_id,
                  artifact_ref: portableProtocolServicePathRef(sketchContext.artifact_ref),
                  viewer_principal: sketchContext.viewer_principal,
                  scope: sketchContext.scope,
                  exported_at: nowIso(),
                  image_path: portableProtocolServicePathRef(out),
                  handoff_path: portableProtocolServicePathRef(handoff),
                  image_bytes: png.byteLength,
                  instruction_chars: instruction.length,
                },
                null,
                2
              ),
              { mkdir: true, encoding: 'utf8' }
            );
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(
              `exported ${path.basename(out)} + ${path.basename(handoff)} (session ${sketchContext.sketch_session_id})`
            );
            print(`[export] wrote ${out} (${png.byteLength} bytes) and ${handoff}`);
          } catch (e: unknown) {
            if (e instanceof SketchInputRequestBodyTooLargeError) {
              if (!res.headersSent) {
                res.writeHead(413);
                res.end('request body too large');
              }
              req.resume();
            } else if (!res.headersSent) {
              res.writeHead(500);
              res.end(e instanceof Error ? e.message : String(e));
            }
            print(`[export] ${e instanceof Error ? e.message : String(e)}`);
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
  });
  server.requestTimeout = SKETCH_INPUT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SKETCH_INPUT_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SKETCH_INPUT_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[sketch-input] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'sketch-input',
          action: 'start',
          status: 'started',
          scope: sketchContext.scope,
          actorRole: 'surface_runtime',
          principal: { kind: 'human', id: sketchContext.viewer_principal },
          requestedBy: sketchContext.viewer_principal,
          correlationId: sketchContext.sketch_session_id,
          metadata: {
            port,
            artifact_ref: portableProtocolServicePathRef(sketchContext.artifact_ref),
            out: portableProtocolServicePathRef(out),
          },
        });
      } catch (error) {
        server.close(() => undefined);
        reject(
          new ScriptExitError(1, `[sketch-input] start lifecycle receipt unavailable: ${error}`)
        );
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Sketch input server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${sketchContext.artifact_ref}`);
        print(
          `  scope  : ${sketchContext.scope.scope_kind}/${sketchContext.scope.tenant_slug || 'system'}`
        );
        print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only)`);
        print('  Draw, then 「Kyberionへ渡す」 to write PNG + handoff.json. Ctrl-C to stop.');
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
        serviceId: 'sketch-input',
        action: 'stop',
        status: 'stopped',
        scope: sketchContext.scope,
        actorRole: 'surface_runtime',
        principal: { kind: 'human', id: sketchContext.viewer_principal },
        requestedBy: sketchContext.viewer_principal,
        correlationId: sketchContext.sketch_session_id,
      });
    } catch (error) {
      print(`[sketch-input] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runSketchInputServer = defineScript({
  name: 'sketch-input:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runSketchInputServer();
}
