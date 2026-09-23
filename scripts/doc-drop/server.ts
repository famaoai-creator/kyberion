/**
 * server.ts — doc-drop localhost pad (meeting-notepad twin)
 *
 * Serves a file-drop ingest pad on 127.0.0.1. Saves attachments + handoff.json
 * for Kyberion pickup (no auto knowledge commit).
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/doc-drop/server.ts \
 *     [--out <dir>] [--instruction <text>] [port]
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycle,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveTenant } from '@agent/core/tenant-registry';
import {
  LOCAL_PAD_COMMON_FLAGS,
  LocalPadRequestBodyTooLargeError,
  createLocalPadContext,
  localPadHandoffPath,
  localPadReceiptPath,
  localPadSessionDir,
  option,
  positionalArgs,
  readLocalPadRequestBody,
  validateLocalPadContentLength,
  type LocalPadContext,
} from '../lib/local-artifact-pad.js';
import { docDropPageHtml } from './drop-page.js';
import { handlePadUiAsset, resolvePadLocale } from '../lib/pad-ui.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { composeLegacyCapture } from '../personal-pads/legacy.js';

export interface DocDropServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  out: string;
  handoff: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: LocalPadContext['scope'];
  listening: boolean;
}

export const DOC_DROP_MAX_BODY_BYTES = 24 * 1024 * 1024;
export const DOC_DROP_MAX_FILE_BYTES = 12 * 1024 * 1024;
export const DOC_DROP_MAX_CONCURRENT_HEAVY_REQUESTS = 2;
export const DOC_DROP_REQUEST_TIMEOUT_MS = 120_000;
export const DOC_DROP_HEADERS_TIMEOUT_MS = 10_000;
export const DOC_DROP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const DOC_DROP_DEFAULT_PORT = 8153;

export {
  LocalPadRequestBodyTooLargeError as DocDropRequestBodyTooLargeError,
  readLocalPadRequestBody as readDocDropRequestBody,
  validateLocalPadContentLength as validateDocDropContentLength,
};

export function defaultDocDropOutputDir(): string {
  return pathResolver.sharedTmp('doc-drop');
}

type AttachmentPayload = {
  name?: string;
  mime?: string;
  data_base64?: string;
};

type DropPayload = {
  instruction?: string;
  attachments?: AttachmentPayload[];
};

function sanitizeFileName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || fallback;
}

function extensionForMime(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('markdown') || mime.endsWith('/md')) return '.md';
  if (mime.includes('text')) return '.txt';
  if (mime.includes('wordprocessingml') || mime.includes('msword')) return '.docx';
  return '';
}

function writeAttachments(
  sessionDir: string,
  attachments: AttachmentPayload[] | undefined
): Array<{ name: string; mime: string; path: string; bytes: number }> {
  const written: Array<{ name: string; mime: string; path: string; bytes: number }> = [];
  const list = Array.isArray(attachments) ? attachments : [];
  const attachDir = path.join(sessionDir, 'attachments');
  safeMkdir(attachDir, { recursive: true });
  list.forEach((att, index) => {
    const b64 = typeof att.data_base64 === 'string' ? att.data_base64.trim() : '';
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return;
    const mime =
      typeof att.mime === 'string' && att.mime.trim()
        ? att.mime.trim()
        : 'application/octet-stream';
    const rawName =
      typeof att.name === 'string' && att.name.trim() ? att.name.trim() : `attach-${index + 1}`;
    const hasExt = /\.[a-z0-9]+$/i.test(rawName);
    const fileName = sanitizeFileName(
      hasExt ? rawName : `${rawName}${extensionForMime(mime)}`,
      `attach-${index + 1}${extensionForMime(mime)}`
    );
    const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (buf.byteLength < 1 || buf.byteLength > DOC_DROP_MAX_FILE_BYTES) return;
    const filePath = path.join(attachDir, `${String(index + 1).padStart(2, '0')}-${fileName}`);
    safeWriteFile(filePath, buf, { mkdir: true });
    written.push({
      name: fileName,
      mime,
      path: portableProtocolServicePathRef(filePath),
      bytes: buf.byteLength,
    });
  });
  return written;
}

function authTokenFrom(req: http.IncomingMessage): string | undefined {
  const drop = req.headers['x-ddrop-token'];
  const doc = req.headers['x-doc-token'];
  const value = typeof drop === 'string' ? drop : typeof doc === 'string' ? doc : undefined;
  return value;
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

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<DocDropServerResult | undefined> {
  const positionals = positionalArgs(args, LOCAL_PAD_COMMON_FLAGS);
  const port = Number(positionals[0] || DOC_DROP_DEFAULT_PORT);
  const out = option(args, '--out') || defaultDocDropOutputDir();
  const defaultInstruction = option(args, '--instruction') || '';
  assertProtocolServiceRegistered('doc-drop');

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
      'confidential and personal doc-drop pads require server-side KYBERION_TENANT scope'
    );
  }
  const requestedTenant = serverTenant || cliTenant;
  if (requestedTenant?.trim()) {
    resolveTenant(requestedTenant.trim());
  }
  const padContext = createLocalPadContext({
    serviceId: 'doc-drop',
    sessionPrefix: 'ddrop',
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-doc-drop',
    tier,
    tenant_slug: requestedTenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScriptExitError(1, `invalid port: ${port}`);
  }

  const handoff = localPadHandoffPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: DocDropServerResult = {
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
  let activeHeavyRequests = 0;
  function acquireHeavyRequest(): (() => void) | undefined {
    if (activeHeavyRequests >= DOC_DROP_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  function rejectIfUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (authTokenFrom(req) !== TOKEN) {
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
      validateLocalPadContentLength(req.headers['content-length'], DOC_DROP_MAX_BODY_BYTES);
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

  function persistDrop(payload: DropPayload): Record<string, unknown> {
    composeLegacyCapture('doc-drop', payload as Record<string, unknown>);
    const sessionId = `${padContext.session_id}-${randomUUID().slice(0, 8)}`;
    const sessionDir = localPadSessionDir(out, sessionId);
    safeMkdir(sessionDir, { recursive: true });
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
    const writtenAttachments = writeAttachments(sessionDir, payload.attachments);
    if (writtenAttachments.length < 1) {
      throw new Error('at least one valid attachment is required');
    }

    const handoffBody = {
      kind: 'doc-drop-handoff',
      version: 1,
      session_id: padContext.session_id,
      capture_session_id: sessionId,
      artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
      viewer_principal: padContext.viewer_principal,
      scope: padContext.scope,
      exported_at: nowIso(),
      session_dir: portableProtocolServicePathRef(sessionDir),
      attachments: writtenAttachments,
      instruction,
      suggested_ops: ['ingest:parse_document', 'vision:ocr_image'],
      processing: {
        auto_start_mission: false,
        auto_knowledge_commit: false,
        note: 'Pick up attachments + instruction; run ingest:parse_document / vision:ocr_image as appropriate. No automatic knowledge commit.',
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
      localPadReceiptPath('doc-drop', padContext),
      JSON.stringify(
        {
          session_id: padContext.session_id,
          capture_session_id: sessionId,
          artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
          viewer_principal: padContext.viewer_principal,
          scope: padContext.scope,
          exported_at: nowIso(),
          session_dir: portableProtocolServicePathRef(sessionDir),
          handoff_path: portableProtocolServicePathRef(handoff),
          attachment_count: writtenAttachments.length,
          instruction_chars: instruction.length,
        },
        null,
        2
      ),
      { mkdir: true, encoding: 'utf8' }
    );

    return {
      ok: true,
      capture_session_id: sessionId,
      session_dir: portableProtocolServicePathRef(sessionDir),
      handoff_path: portableProtocolServicePathRef(handoff),
      attachments: writtenAttachments,
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (handlePadUiAsset(req, res)) return;
      const pathname = (req.url || '').split(/[?#]/)[0];
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another doc-drop request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const html = docDropPageHtml({
          token: TOKEN,
          exportUrl: '/export',
          defaultInstruction,
          outLabel: out,
          locale: resolvePadLocale(req),
          maxFileBytes: DOC_DROP_MAX_FILE_BYTES,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && pathname === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.method === 'POST' && req.url === '/export') {
        if (rejectIfUnauthorized(req, res)) return;
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another doc-drop request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        void (async () => {
          try {
            const raw = await readLocalPadRequestBody(req, DOC_DROP_MAX_BODY_BYTES);
            let payload: DropPayload;
            try {
              payload = JSON.parse(raw) as DropPayload;
            } catch {
              jsonResponse(res, 400, { ok: false, error: 'invalid json' });
              return;
            }
            try {
              jsonResponse(res, 200, persistDrop(payload));
            } catch (error) {
              jsonResponse(res, 400, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
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
            print(`[doc-drop] ${e instanceof Error ? e.message : String(e)}`);
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
  server.requestTimeout = DOC_DROP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DOC_DROP_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = DOC_DROP_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[doc-drop] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'doc-drop',
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
        reject(new ScriptExitError(1, `[doc-drop] start lifecycle receipt unavailable: ${error}`));
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Doc drop server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${padContext.artifact_ref}`);
        print(
          `  scope  : ${padContext.scope.scope_kind}/${padContext.scope.tenant_slug || 'system'}`
        );
        print(
          `  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only; header X-DDROP-Token or X-DOC-Token)`
        );
        print('  Ctrl-C to stop. Hand off writes session/attachments/ + handoff.json.');
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
        serviceId: 'doc-drop',
        action: 'stop',
        status: 'stopped',
        scope: padContext.scope,
        actorRole: 'surface_runtime',
        principal: lifecyclePrincipal(padContext.viewer_principal),
        requestedBy: padContext.viewer_principal,
        correlationId: padContext.session_id,
      });
    } catch (error) {
      print(`[doc-drop] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runDocDropServer = defineScript({
  name: 'doc-drop:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runDocDropServer();
}
