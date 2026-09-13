/**
 * server.ts — daily-desk localhost pad (meeting-notepad twin)
 *
 * Serves a journal / TODO / NOW desk on 127.0.0.1. Seeds from working-memory
 * faces when present; exports journal.md / todo.md / now.md + handoff.json.
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/daily-desk/server.ts \
 *     [--out <dir>] [--instruction <text>] [port]
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeWriteFile, safeMkdir, safeReadFile, safeExistsSync } from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycle,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { pathResolver, toRepoRelative } from '@agent/core/path-resolver';
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
import { dailyDeskPageHtml } from './desk-page.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export interface DailyDeskServerResult {
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

export const DAILY_DESK_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DAILY_DESK_MAX_CONCURRENT_HEAVY_REQUESTS = 2;
export const DAILY_DESK_REQUEST_TIMEOUT_MS = 60_000;
export const DAILY_DESK_HEADERS_TIMEOUT_MS = 10_000;
export const DAILY_DESK_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const DAILY_DESK_DEFAULT_PORT = 8152;

export {
  LocalPadRequestBodyTooLargeError as DailyDeskRequestBodyTooLargeError,
  readLocalPadRequestBody as readDailyDeskRequestBody,
  validateLocalPadContentLength as validateDailyDeskContentLength,
};

export function defaultDailyDeskOutputDir(): string {
  return pathResolver.sharedTmp('daily-desk');
}

export function todayPeriodKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export interface WorkingMemoryFaces {
  journalPath: string | null;
  todoPath: string | null;
  nowPath: string | null;
  journal: string;
  todo: string;
  now: string;
  note: string;
}

function tryReadText(filePath: string | null): string {
  if (!filePath || !safeExistsSync(filePath)) return '';
  try {
    return String(safeReadFile(filePath, { encoding: 'utf8' }));
  } catch {
    return '';
  }
}

/**
 * Locate today's personal working-memory faces via path-resolver volatile API.
 * Falls back to empty panels + out-dir MVP note when faces are absent.
 */
export function locateWorkingMemoryFaces(periodKey = todayPeriodKey()): WorkingMemoryFaces {
  const journalPath = toRepoRelative(
    pathResolver.volatile('personal', null, {
      cadence: 'daily',
      periodKey,
      tier: 'personal',
    })
  );
  const todoPath = toRepoRelative(
    pathResolver.volatile('personal', null, { cadence: 'daily', tier: 'personal' })
  );
  const nowPath = toRepoRelative(
    path.join(pathResolver.volatile('personal', null, { tier: 'personal' }), 'NOW.md')
  );

  const journalExists = safeExistsSync(journalPath);
  const todoExists = safeExistsSync(todoPath);
  const nowExists = safeExistsSync(nowPath);
  const found: string[] = [];
  if (journalExists) found.push(journalPath);
  if (todoExists) found.push(todoPath);
  if (nowExists) found.push(nowPath);

  const note =
    found.length > 0
      ? `Seeded from working-memory faces (${found.join(', ')}). Export writes MVP copies under --out; sync back to faces is operator-owned.`
      : `No working-memory faces found for ${periodKey}. Editable panels save to --out as journal.md / todo.md / now.md (MVP); sync to working-memory faces later.`;

  return {
    journalPath: journalExists ? journalPath : null,
    todoPath: todoExists ? todoPath : null,
    nowPath: nowExists ? nowPath : null,
    journal: tryReadText(journalExists ? journalPath : null),
    todo: tryReadText(todoExists ? todoPath : null),
    now: tryReadText(nowExists ? nowPath : null),
    note,
  };
}

function emptyWorkingMemoryFaces(periodKey = todayPeriodKey()): WorkingMemoryFaces {
  return {
    journalPath: null,
    todoPath: null,
    nowPath: null,
    journal: '',
    todo: '',
    now: '',
    note: `Working-memory faces for ${periodKey} load only after the authenticated request.`,
  };
}

type DeskPayload = {
  journal?: string;
  todo?: string;
  now?: string;
  instruction?: string;
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

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<DailyDeskServerResult | undefined> {
  const positionals = positionalArgs(args, LOCAL_PAD_COMMON_FLAGS);
  const port = Number(positionals[0] || DAILY_DESK_DEFAULT_PORT);
  const out = option(args, '--out') || defaultDailyDeskOutputDir();
  const defaultInstruction = option(args, '--instruction') || '';
  assertProtocolServiceRegistered('daily-desk');

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
      'confidential and personal desks require server-side KYBERION_TENANT scope'
    );
  }
  const requestedTenant = serverTenant || cliTenant;
  if (requestedTenant?.trim()) {
    resolveTenant(requestedTenant.trim());
  }
  const padContext = createLocalPadContext({
    serviceId: 'daily-desk',
    sessionPrefix: 'dd',
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-desk',
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
  const preview: DailyDeskServerResult = {
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
    if (activeHeavyRequests >= DAILY_DESK_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  function rejectIfUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.headers['x-dd-token'] !== TOKEN) {
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
      validateLocalPadContentLength(req.headers['content-length'], DAILY_DESK_MAX_BODY_BYTES);
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

  function persistDesk(payload: DeskPayload): Record<string, unknown> {
    const sessionId = `${padContext.session_id}-${randomUUID().slice(0, 8)}`;
    const sessionDir = localPadSessionDir(out, sessionId);
    safeMkdir(sessionDir, { recursive: true });
    const journal = typeof payload.journal === 'string' ? payload.journal : '';
    const todo = typeof payload.todo === 'string' ? payload.todo : '';
    const nowText = typeof payload.now === 'string' ? payload.now : '';
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';

    const journalPath = path.join(out, 'journal.md');
    const todoPath = path.join(out, 'todo.md');
    const nowPath = path.join(out, 'now.md');
    safeWriteFile(journalPath, journal, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(todoPath, todo, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(nowPath, nowText, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(path.join(sessionDir, 'journal.md'), journal, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(path.join(sessionDir, 'todo.md'), todo, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(path.join(sessionDir, 'now.md'), nowText, { mkdir: true, encoding: 'utf8' });

    const faces = locateWorkingMemoryFaces();
    const handoffBody = {
      kind: 'daily-desk-handoff',
      version: 1,
      session_id: padContext.session_id,
      capture_session_id: sessionId,
      artifact_ref: portableProtocolServicePathRef(padContext.artifact_ref),
      viewer_principal: padContext.viewer_principal,
      scope: padContext.scope,
      exported_at: nowIso(),
      period_key: todayPeriodKey(),
      journal_path: portableProtocolServicePathRef(journalPath),
      todo_path: portableProtocolServicePathRef(todoPath),
      now_path: portableProtocolServicePathRef(nowPath),
      working_memory_faces: {
        journal: faces.journalPath,
        todo: faces.todoPath,
        now: faces.nowPath,
      },
      instruction,
      processing: {
        auto_start_mission: false,
        note: 'MVP out-dir copies. Operator may sync journal.md / todo.md / now.md into working-memory faces later.',
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
      localPadReceiptPath('daily-desk', padContext),
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
      journal_path: portableProtocolServicePathRef(journalPath),
      todo_path: portableProtocolServicePathRef(todoPath),
      now_path: portableProtocolServicePathRef(nowPath),
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another daily-desk request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const faces = emptyWorkingMemoryFaces();
        const html = dailyDeskPageHtml({
          token: TOKEN,
          exportUrl: '/export',
          loadUrl: '/load',
          defaultInstruction,
          outLabel: out,
          journal: faces.journal,
          todo: faces.todo,
          now: faces.now,
          faceNote: faces.note,
          facePaths: {
            journal: faces.journalPath,
            todo: faces.todoPath,
            now: faces.nowPath,
          },
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
      if (req.method === 'POST' && (req.url === '/export' || req.url === '/load')) {
        if (rejectIfUnauthorized(req, res)) return;
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another daily-desk request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        const route = req.url;
        void (async () => {
          try {
            const raw = await readLocalPadRequestBody(req, DAILY_DESK_MAX_BODY_BYTES);
            let payload: DeskPayload = {};
            if (raw.trim()) {
              try {
                payload = JSON.parse(raw) as DeskPayload;
              } catch {
                jsonResponse(res, 400, { ok: false, error: 'invalid json' });
                return;
              }
            }
            if (route === '/load') {
              const faces = locateWorkingMemoryFaces();
              const outJournal = path.join(out, 'journal.md');
              const outTodo = path.join(out, 'todo.md');
              const outNow = path.join(out, 'now.md');
              jsonResponse(res, 200, {
                ok: true,
                journal: tryReadText(safeExistsSync(outJournal) ? outJournal : faces.journalPath),
                todo: tryReadText(safeExistsSync(outTodo) ? outTodo : faces.todoPath),
                now: tryReadText(safeExistsSync(outNow) ? outNow : faces.nowPath),
                face_paths: {
                  journal: faces.journalPath,
                  todo: faces.todoPath,
                  now: faces.nowPath,
                },
                out_paths: {
                  journal: portableProtocolServicePathRef(outJournal),
                  todo: portableProtocolServicePathRef(outTodo),
                  now: portableProtocolServicePathRef(outNow),
                },
                note: faces.note,
              });
              return;
            }
            jsonResponse(res, 200, persistDesk(payload));
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
            print(`[daily-desk] ${e instanceof Error ? e.message : String(e)}`);
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
  server.requestTimeout = DAILY_DESK_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DAILY_DESK_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = DAILY_DESK_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[daily-desk] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'daily-desk',
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
          new ScriptExitError(1, `[daily-desk] start lifecycle receipt unavailable: ${error}`)
        );
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Daily desk server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${padContext.artifact_ref}`);
        print(
          `  scope  : ${padContext.scope.scope_kind}/${padContext.scope.tenant_slug || 'system'}`
        );
        print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only; header X-DD-Token)`);
        print('  Ctrl-C to stop. Hand off writes journal.md / todo.md / now.md + handoff.json.');
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
        serviceId: 'daily-desk',
        action: 'stop',
        status: 'stopped',
        scope: padContext.scope,
        actorRole: 'surface_runtime',
        principal: lifecyclePrincipal(padContext.viewer_principal),
        requestedBy: padContext.viewer_principal,
        correlationId: padContext.session_id,
      });
    } catch (error) {
      print(`[daily-desk] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runDailyDeskServer = defineScript({
  name: 'daily-desk:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runDailyDeskServer();
}
