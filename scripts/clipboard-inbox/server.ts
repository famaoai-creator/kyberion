/**
 * server.ts — clipboard-inbox localhost pad
 *
 * Park clipboard snippets on 127.0.0.1; optional OS clipboard pull (pbpaste/xclip).
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/clipboard-inbox/server.ts \
 *     [--out <dir>] [--instruction <text>] [port]
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeExecResultAsync, safeWriteFile, safeMkdir } from '@agent/core/secure-io';
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
  createClipboardInboxContext,
  clipboardInboxHandoffLogicalPath,
  clipboardInboxReceiptLogicalPath,
  clipboardInboxSessionDir,
} from './context.js';
import { clipboardInboxPageHtml } from './page.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export interface ClipboardInboxServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  out: string;
  handoff: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: ReturnType<typeof createClipboardInboxContext>['scope'];
  listening: boolean;
}

export const CLIPBOARD_INBOX_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const CLIPBOARD_INBOX_MAX_CONCURRENT_HEAVY_REQUESTS = 2;
export const CLIPBOARD_INBOX_REQUEST_TIMEOUT_MS = 60_000;
export const CLIPBOARD_INBOX_HEADERS_TIMEOUT_MS = 10_000;
export const CLIPBOARD_INBOX_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const CLIPBOARD_INBOX_DEFAULT_PORT = 8151;

export { LocalPadRequestBodyTooLargeError as ClipboardInboxRequestBodyTooLargeError };

export async function readClipboardInboxRequestBody(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes = CLIPBOARD_INBOX_MAX_BODY_BYTES
): Promise<string> {
  return readLocalPadRequestBody(source, maxBytes);
}

export function validateClipboardInboxContentLength(
  value?: string,
  maxBytes = CLIPBOARD_INBOX_MAX_BODY_BYTES
): number | undefined {
  return validateLocalPadContentLength(value, maxBytes);
}

export function defaultClipboardInboxOutputDir(): string {
  return pathResolver.sharedTmp('clipboard-inbox');
}

type InboxItem = {
  id?: string;
  text?: string;
  label?: string;
};

function lifecyclePrincipal(viewerPrincipal: string): {
  kind: 'nhi' | 'human' | 'service';
  id: string;
} {
  const id = viewerPrincipal.trim();
  if (/^(?:nhi|agent):/u.test(id)) return { kind: 'nhi', id };
  if (/^(?:service|runtime):/u.test(id)) return { kind: 'service', id };
  return { kind: 'human', id };
}

export async function readOsClipboardText(): Promise<
  { ok: true; text: string } | { ok: false; error: string }
> {
  try {
    if (process.platform === 'darwin') {
      const result = await safeExecResultAsync('pbpaste', [], {
        timeout: 5_000,
        maxOutputMB: 2,
      });
      if (result.status !== 0) throw result.error ?? new Error(result.stderr || 'pbpaste failed');
      return { ok: true, text: result.stdout };
    }
    if (process.platform === 'linux') {
      try {
        const result = await safeExecResultAsync('xclip', ['-o', '-selection', 'clipboard'], {
          timeout: 5_000,
          maxOutputMB: 2,
        });
        if (result.status !== 0) throw result.error ?? new Error(result.stderr || 'xclip failed');
        return { ok: true, text: result.stdout };
      } catch {
        const result = await safeExecResultAsync('xsel', ['--clipboard', '--output'], {
          timeout: 5_000,
          maxOutputMB: 2,
        });
        if (result.status !== 0) throw result.error ?? new Error(result.stderr || 'xsel failed');
        return { ok: true, text: result.stdout };
      }
    }
    return {
      ok: false,
      error: 'OS clipboard read unsupported on this platform; paste manually',
    };
  } catch (error) {
    return {
      ok: false,
      error:
        (error instanceof Error ? error.message : String(error)) ||
        'clipboard tool unavailable; paste manually',
    };
  }
}

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<ClipboardInboxServerResult | undefined> {
  const positionals = positionalArgs(args, LOCAL_PAD_COMMON_FLAGS);
  const port = Number(positionals[0] || CLIPBOARD_INBOX_DEFAULT_PORT);
  const out = option(args, '--out') || defaultClipboardInboxOutputDir();
  const defaultInstruction = option(args, '--instruction') || '';
  assertProtocolServiceRegistered('clipboard-inbox');

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
  const padContext = createClipboardInboxContext({
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-clipper',
    tier,
    tenant_slug: requestedTenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScriptExitError(1, `invalid port: ${port}`);
  }

  const handoff = clipboardInboxHandoffLogicalPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: ClipboardInboxServerResult = {
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
    if (activeHeavyRequests >= CLIPBOARD_INBOX_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  function rejectIfUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.headers['x-ci-token'] !== TOKEN) {
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
      validateClipboardInboxContentLength(req.headers['content-length']);
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

  function normalizeItems(raw: unknown): Array<{ id: string; text: string; label: string }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item, index) => {
        const row = item as InboxItem;
        const text = typeof row.text === 'string' ? row.text : '';
        if (!text.trim()) return null;
        return {
          id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `item-${index + 1}`,
          text,
          label: typeof row.label === 'string' ? row.label.trim() : '',
        };
      })
      .filter((item): item is { id: string; text: string; label: string } => item !== null);
  }

  function persistExport(payload: {
    items?: unknown;
    instruction?: string;
  }): Record<string, unknown> {
    const items = normalizeItems(payload.items);
    if (items.length < 1) {
      throw new Error('items required');
    }
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
    const captureId = `${padContext.session_id}-${randomUUID().slice(0, 8)}`;
    const sessionDir = clipboardInboxSessionDir(out, captureId);
    safeMkdir(sessionDir, { recursive: true });
    const itemsPath = path.join(sessionDir, 'items.json');
    safeWriteFile(itemsPath, JSON.stringify({ items, exported_at: nowIso() }, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    const handoffBody = {
      kind: 'clipboard-inbox-handoff',
      version: 1,
      pad_session_id: padContext.session_id,
      capture_session_id: captureId,
      artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
      viewer_principal: padContext.viewer_principal,
      scope: padContext.scope,
      exported_at: nowIso(),
      items_path: portableProtocolServicePathRef(itemsPath),
      item_count: items.length,
      instruction,
      processing: {
        auto_start_mission: false,
        suggested_ops: ['clipboard:ingest', 'working-memory:note'],
        redact_hint:
          'Items may contain secrets (tokens, passwords, PII). Redact before promoting to shared tiers or missions.',
        note: 'Pick up items_path + instruction; do not auto-start a mission in MVP.',
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
      clipboardInboxReceiptLogicalPath(padContext),
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
          item_count: items.length,
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
      items_path: portableProtocolServicePathRef(itemsPath),
      item_count: items.length,
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another clipboard-inbox request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const html = clipboardInboxPageHtml({
          token: TOKEN,
          exportUrl: '/export',
          clipboardReadUrl: '/clipboard-read',
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
      if (req.method === 'POST' && (req.url === '/export' || req.url === '/clipboard-read')) {
        if (rejectIfUnauthorized(req, res)) return;
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another clipboard-inbox request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        const route = req.url;
        void (async () => {
          try {
            const raw = await readClipboardInboxRequestBody(req, CLIPBOARD_INBOX_MAX_BODY_BYTES);
            if (route === '/clipboard-read') {
              const clipped = await readOsClipboardText();
              if ('error' in clipped) {
                jsonResponse(res, 501, { ok: false, error: clipped.error });
                return;
              }
              jsonResponse(res, 200, {
                ok: true,
                text: clipped.text,
                label: 'clipboard',
              });
              return;
            }
            let payload: { items?: unknown; instruction?: string };
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
                `[export] wrote ${String(result.session_dir)} handoff=${String(result.handoff_path)}`
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              jsonResponse(res, message === 'items required' ? 400 : 500, {
                ok: false,
                error: message,
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
            print(`[clipboard-inbox] ${e instanceof Error ? e.message : String(e)}`);
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
  server.requestTimeout = CLIPBOARD_INBOX_REQUEST_TIMEOUT_MS;
  server.headersTimeout = CLIPBOARD_INBOX_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = CLIPBOARD_INBOX_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[clipboard-inbox] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'clipboard-inbox',
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
          new ScriptExitError(1, `[clipboard-inbox] start lifecycle receipt unavailable: ${error}`)
        );
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Clipboard inbox server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${padContext.artifact_ref}`);
        print(
          `  scope  : ${padContext.scope.scope_kind}/${padContext.scope.tenant_slug || 'system'}`
        );
        print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only)`);
        print('  Pull clipboard is best-effort; paste manually on 501.');
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
        serviceId: 'clipboard-inbox',
        action: 'stop',
        status: 'stopped',
        scope: padContext.scope,
        actorRole: 'surface_runtime',
        principal: lifecyclePrincipal(padContext.viewer_principal),
        requestedBy: padContext.viewer_principal,
        correlationId: padContext.session_id,
      });
    } catch (error) {
      print(`[clipboard-inbox] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runClipboardInboxServer = defineScript({
  name: 'clipboard-inbox:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runClipboardInboxServer();
}
