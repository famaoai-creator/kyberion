/**
 * server.ts — memory-capture localhost pad
 *
 * Personal brain-dump pad on 127.0.0.1: notes, tags, target, voice, handoff.
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/memory-capture/server.ts \
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
  option,
  positionalArgs,
  readLocalPadRequestBody,
  validateLocalPadContentLength,
} from '../lib/local-artifact-pad.js';
import {
  createMemoryCaptureContext,
  memoryCaptureHandoffLogicalPath,
  memoryCaptureReceiptLogicalPath,
  memoryCaptureSessionDir,
} from './context.js';
import { memoryCapturePageHtml } from './page.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export interface MemoryCaptureServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  out: string;
  handoff: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: ReturnType<typeof createMemoryCaptureContext>['scope'];
  listening: boolean;
}

export const MEMORY_CAPTURE_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const MEMORY_CAPTURE_MAX_CONCURRENT_HEAVY_REQUESTS = 2;
export const MEMORY_CAPTURE_REQUEST_TIMEOUT_MS = 60_000;
export const MEMORY_CAPTURE_HEADERS_TIMEOUT_MS = 10_000;
export const MEMORY_CAPTURE_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const MEMORY_CAPTURE_DEFAULT_PORT = 8149;

export { LocalPadRequestBodyTooLargeError as MemoryCaptureRequestBodyTooLargeError };

export async function readMemoryCaptureRequestBody(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes = MEMORY_CAPTURE_MAX_BODY_BYTES
): Promise<string> {
  return readLocalPadRequestBody(source, maxBytes);
}

export function validateMemoryCaptureContentLength(
  value?: string,
  maxBytes = MEMORY_CAPTURE_MAX_BODY_BYTES
): number | undefined {
  return validateLocalPadContentLength(value, maxBytes);
}

export function defaultMemoryCaptureOutputDir(): string {
  return pathResolver.sharedTmp('memory-capture');
}

type ExportPayload = {
  notes?: string;
  tags?: string[] | string;
  target?: string;
  instruction?: string;
};

function normalizeTags(tags: ExportPayload['tags']): string[] {
  if (Array.isArray(tags)) {
    return tags.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof tags === 'string') {
    return tags
      .split(/[,\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeTarget(value: unknown): 'memory' | 'now' | 'todo' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'now' || raw === 'todo') return raw;
  return 'memory';
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
): Promise<MemoryCaptureServerResult | undefined> {
  const positionals = positionalArgs(args, LOCAL_PAD_COMMON_FLAGS);
  const port = Number(positionals[0] || MEMORY_CAPTURE_DEFAULT_PORT);
  const out = option(args, '--out') || defaultMemoryCaptureOutputDir();
  const defaultInstruction = option(args, '--instruction') || '';
  assertProtocolServiceRegistered('memory-capture');

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
  const padContext = createMemoryCaptureContext({
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-memory-capturer',
    tier,
    tenant_slug: requestedTenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScriptExitError(1, `invalid port: ${port}`);
  }

  const handoff = memoryCaptureHandoffLogicalPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: MemoryCaptureServerResult = {
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
    if (activeHeavyRequests >= MEMORY_CAPTURE_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  function rejectIfUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.headers['x-mc-token'] !== TOKEN) {
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
      validateMemoryCaptureContentLength(req.headers['content-length']);
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

  function persistExport(payload: ExportPayload): Record<string, unknown> {
    const captureId = `${padContext.session_id}-${randomUUID().slice(0, 8)}`;
    const sessionDir = memoryCaptureSessionDir(out, captureId);
    safeMkdir(sessionDir, { recursive: true });
    const notes = typeof payload.notes === 'string' ? payload.notes : '';
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
    const tags = normalizeTags(payload.tags);
    const target = normalizeTarget(payload.target);
    const notesPath = path.join(sessionDir, 'notes.md');
    const metaPath = path.join(sessionDir, 'meta.json');
    safeWriteFile(notesPath, `# Memory capture\n\n${notes.trim() || '_No notes._'}\n`, {
      mkdir: true,
      encoding: 'utf8',
    });
    const meta = {
      capture_session_id: captureId,
      pad_session_id: padContext.session_id,
      tags,
      target,
      instruction,
      exported_at: nowIso(),
    };
    safeWriteFile(metaPath, JSON.stringify(meta, null, 2), { mkdir: true, encoding: 'utf8' });
    const handoffBody = {
      kind: 'memory-capture-handoff',
      version: 1,
      pad_session_id: padContext.session_id,
      capture_session_id: captureId,
      artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
      viewer_principal: padContext.viewer_principal,
      scope: padContext.scope,
      exported_at: nowIso(),
      notes_path: portableProtocolServicePathRef(notesPath),
      meta_path: portableProtocolServicePathRef(metaPath),
      tags,
      target,
      instruction,
      processing: {
        auto_start_mission: false,
        suggested_ops: [
          'working-memory:note',
          'working-memory:tag',
          target === 'todo' ? 'working-memory:todo' : 'working-memory:ingest',
        ],
        note: 'Pick up notes_path + tags/target/instruction; do not auto-start a mission in MVP.',
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
      memoryCaptureReceiptLogicalPath(padContext),
      JSON.stringify(
        {
          pad_session_id: padContext.session_id,
          capture_session_id: captureId,
          artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
          viewer_principal: padContext.viewer_principal,
          scope: padContext.scope,
          exported_at: nowIso(),
          session_dir: portableProtocolServicePathRef(sessionDir),
          handoff_path: portableProtocolServicePathRef(handoff),
          notes_chars: notes.length,
          tag_count: tags.length,
          target,
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
      notes_path: portableProtocolServicePathRef(notesPath),
      meta_path: portableProtocolServicePathRef(metaPath),
      tags,
      target,
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another memory-capture request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const html = memoryCapturePageHtml({
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
        if (rejectIfUnauthorized(req, res)) return;
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another memory-capture request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        void (async () => {
          try {
            const raw = await readMemoryCaptureRequestBody(req, MEMORY_CAPTURE_MAX_BODY_BYTES);
            let payload: ExportPayload;
            try {
              payload = JSON.parse(raw) as ExportPayload;
            } catch {
              jsonResponse(res, 400, { ok: false, error: 'invalid json' });
              return;
            }
            const result = persistExport(payload);
            jsonResponse(res, 200, result);
            print(
              `[export] wrote ${String(result.session_dir)} handoff=${String(result.handoff_path)}`
            );
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
            print(`[memory-capture] ${e instanceof Error ? e.message : String(e)}`);
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
  server.requestTimeout = MEMORY_CAPTURE_REQUEST_TIMEOUT_MS;
  server.headersTimeout = MEMORY_CAPTURE_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = MEMORY_CAPTURE_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[memory-capture] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'memory-capture',
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
          new ScriptExitError(1, `[memory-capture] start lifecycle receipt unavailable: ${error}`)
        );
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Memory capture server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${padContext.artifact_ref}`);
        print(
          `  scope  : ${padContext.scope.scope_kind}/${padContext.scope.tenant_slug || 'system'}`
        );
        print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only)`);
        print('  Open the URL, write notes, then Hand off. Vocab keys can be added later.');
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
        serviceId: 'memory-capture',
        action: 'stop',
        status: 'stopped',
        scope: padContext.scope,
        actorRole: 'surface_runtime',
        principal: lifecyclePrincipal(padContext.viewer_principal),
        requestedBy: padContext.viewer_principal,
        correlationId: padContext.session_id,
      });
    } catch (error) {
      print(`[memory-capture] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runMemoryCaptureServer = defineScript({
  name: 'memory-capture:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runMemoryCaptureServer();
}
