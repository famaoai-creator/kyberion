/**
 * personal-workbench — one local inbox for personal secretary workflows.
 *
 * Captures links, tasks, follow-ups, decisions, expenses, and daily-review
 * notes into personal-tier operator proposals. Mail send and knowledge enqueue
 * stay proposal/draft-only; calendar writes require propose → confirm → apply.
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeExistsSync, safeMkdir, safeWriteFile, safeReaddir } from '@agent/core/secure-io';
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
  isLocalPadOriginAllowed,
  localPadHandoffPath,
  localPadReceiptPath,
  localPadSessionDir,
  option,
  positionalArgs,
  readLocalPadRequestBody,
  validateLocalPadContentLength,
  type LocalPadContext,
} from '../lib/local-artifact-pad.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { readSafeJsonFile, readSafeJsonValueFile } from '../lib/json-input.js';
import { composeLegacyCapture } from '../personal-pads/legacy.js';
import { executePersonalWorkbenchAction, type PersonalWorkbenchAction } from './actions.js';
import type { CalendarProposalRecord } from './actions.js';
import { personalWorkbenchPageHtml } from './page.js';
import { handlePadUiAsset, resolvePadLocale } from '../lib/pad-ui.js';

export const PERSONAL_WORKBENCH_DEFAULT_PORT = 8154;
export const PERSONAL_WORKBENCH_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const PERSONAL_WORKBENCH_MAX_ENTRIES = 500;

export type PersonalWorkbenchKind =
  'link' | 'task' | 'follow-up' | 'decision' | 'expense' | 'daily-review';

type WorkbenchEntry = {
  id: string;
  kind: PersonalWorkbenchKind;
  title: string;
  body: string;
  metadata: Record<string, string>;
  status: 'proposed';
  created_at: string;
};

type WorkbenchPayload = {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  metadata?: unknown;
};

export interface PersonalWorkbenchServerResult {
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

export function defaultPersonalWorkbenchOutputDir(): string {
  return pathResolver.sharedTmp('personal-workbench');
}

export function validatePersonalWorkbenchContentLength(
  value?: string,
  maxBytes = PERSONAL_WORKBENCH_MAX_BODY_BYTES
): number | undefined {
  return validateLocalPadContentLength(value, maxBytes);
}

function isKind(value: unknown): value is PersonalWorkbenchKind {
  return (
    value === 'link' ||
    value === 'task' ||
    value === 'follow-up' ||
    value === 'decision' ||
    value === 'expense' ||
    value === 'daily-review'
  );
}

function readCalendarProposals(outDir: string): CalendarProposalRecord[] {
  const dir = path.join(outDir.replace(/\/$/, ''), 'calendar-proposals');
  if (!safeExistsSync(dir)) return [];
  try {
    const names = safeReaddir(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse();
    return names
      .map((name) => {
        try {
          return readSafeJsonFile<CalendarProposalRecord>(
            path.join(dir, name),
            `personal-workbench calendar proposal ${name}`
          );
        } catch {
          return null;
        }
      })
      .filter((row): row is CalendarProposalRecord => Boolean(row && row.approval_request_id));
  } catch {
    return [];
  }
}

/** The saved proposal index (`<out>/entries.json`, an array); [] when absent or unreadable. */
export function readPersonalWorkbenchEntries(indexPath: string): WorkbenchEntry[] {
  if (!safeExistsSync(indexPath)) return [];
  try {
    // entries.json is an array: readSafeJsonFile only accepts objects and read every index as [].
    const parsed = readSafeJsonValueFile<unknown>(indexPath, 'personal-workbench entries');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is WorkbenchEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Partial<WorkbenchEntry>;
      return isKind(row.kind) && typeof row.title === 'string' && typeof row.body === 'string';
    });
  } catch {
    return [];
  }
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === 'string' || typeof item === 'number')
      .map(([key, item]) => [key.slice(0, 80), String(item).slice(0, 500)])
  );
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<PersonalWorkbenchServerResult | undefined> {
  const positionals = positionalArgs(args, LOCAL_PAD_COMMON_FLAGS);
  const port = Number(positionals[0] || PERSONAL_WORKBENCH_DEFAULT_PORT);
  const out = option(args, '--out') || defaultPersonalWorkbenchOutputDir();
  assertProtocolServiceRegistered('personal-workbench');
  const tier = (option(args, '--tier') || 'personal') as 'public' | 'confidential' | 'personal';
  if (tier !== 'public' && tier !== 'confidential' && tier !== 'personal')
    throw new ScriptExitError(1, `invalid tier: ${tier}`);
  const serverTenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
  const cliTenant = option(args, '--tenant')?.trim();
  if (serverTenant && cliTenant && serverTenant !== cliTenant)
    throw new ScriptExitError(1, 'CLI tenant does not match server-side KYBERION_TENANT scope');
  if (tier !== 'public' && !serverTenant)
    throw new ScriptExitError(1, 'personal-workbench requires server-side KYBERION_TENANT scope');
  const requestedTenant = serverTenant || cliTenant;
  if (requestedTenant) resolveTenant(requestedTenant);
  const context = createLocalPadContext({
    serviceId: 'personal-workbench',
    sessionPrefix: 'pwb',
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-personal-workbench',
    tier,
    tenant_slug: requestedTenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ScriptExitError(1, `invalid port: ${port}`);
  const handoff = localPadHandoffPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const preview: PersonalWorkbenchServerResult = {
    ok: true,
    mode,
    out,
    handoff,
    port,
    url: `http://127.0.0.1:${port}/`,
    artifact_ref: context.artifact_ref,
    scope: context.scope,
    listening: false,
  };
  const print = options.print ?? (() => undefined);
  if (options.dryRun || options.check) {
    print(preview);
    return preview;
  }
  const token = randomBytes(16).toString('hex');
  const indexPath = path.join(out, 'entries.json');
  function authorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.headers['x-pw-token'] !== token) {
      res.writeHead(403);
      res.end('bad token');
      req.resume();
      return false;
    }
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!isLocalPadOriginAllowed(origin)) {
      res.writeHead(403);
      res.end('bad origin');
      req.resume();
      return false;
    }
    try {
      validatePersonalWorkbenchContentLength(req.headers['content-length']);
    } catch {
      res.writeHead(413);
      res.end('request body too large');
      req.resume();
      return false;
    }
    return true;
  }
  async function persist(payload: WorkbenchPayload): Promise<Record<string, unknown>> {
    composeLegacyCapture('personal-workbench', payload as Record<string, unknown>);
    if (!isKind(payload.kind))
      throw new Error('kind must be link, task, follow-up, decision, expense, or daily-review');
    const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 200) : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (!title || !body) throw new Error('title and body are required');
    const entry: WorkbenchEntry = {
      id: `pwb-${randomUUID()}`,
      kind: payload.kind,
      title,
      body,
      metadata: normalizeMetadata(payload.metadata),
      status: 'proposed',
      created_at: nowIso(),
    };
    const entries = [...readPersonalWorkbenchEntries(indexPath), entry].slice(
      -PERSONAL_WORKBENCH_MAX_ENTRIES
    );
    safeWriteFile(indexPath, JSON.stringify(entries, null, 2), { mkdir: true, encoding: 'utf8' });
    const sessionDir = localPadSessionDir(out, entry.id);
    safeMkdir(sessionDir, { recursive: true });
    const sessionHandoff = path.join(sessionDir, 'handoff.json');
    const handoffBody = {
      kind: 'personal-workbench-handoff',
      version: 1,
      entry,
      artifact_ref: portableProtocolServicePathRef(context.artifact_ref),
      viewer_principal: context.viewer_principal,
      scope: context.scope,
      processing: {
        status: 'proposed',
        requires_human_approval: true,
        external_effects: false,
        note: 'Capture stores proposals only. Use /action knowledge explicitly after capture if a promotion candidate is desired.',
      },
    };
    safeWriteFile(sessionHandoff, JSON.stringify(handoffBody, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(
      handoff,
      JSON.stringify(
        { ...handoffBody, session_handoff: portableProtocolServicePathRef(sessionHandoff) },
        null,
        2
      ),
      { mkdir: true, encoding: 'utf8' }
    );
    safeWriteFile(
      localPadReceiptPath('personal-workbench', context),
      JSON.stringify(
        {
          session_id: context.session_id,
          capture_session_id: entry.id,
          artifact_ref: portableProtocolServicePathRef(context.artifact_ref),
          viewer_principal: context.viewer_principal,
          scope: context.scope,
          exported_at: nowIso(),
          handoff_path: portableProtocolServicePathRef(handoff),
          status: 'proposed',
        },
        null,
        2
      ),
      { mkdir: true, encoding: 'utf8' }
    );
    return {
      ok: true,
      entry,
      handoff_path: portableProtocolServicePathRef(handoff),
      session_handoff: portableProtocolServicePathRef(sessionHandoff),
      requires_human_approval: true,
    };
  }
  const server = http.createServer((req, res) => {
    if (handlePadUiAsset(req, res)) return;
    const pathname = (req.url || '').split(/[?#]/)[0];
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(personalWorkbenchPageHtml({ token, outLabel: out, locale: resolvePadLocale(req) }));
      return;
    }
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (
      req.method === 'POST' &&
      (req.url === '/capture' || req.url === '/load' || req.url === '/action')
    ) {
      if (!authorized(req, res)) return;
      void (async () => {
        try {
          const raw = await readLocalPadRequestBody(req, PERSONAL_WORKBENCH_MAX_BODY_BYTES);
          if (req.url === '/load') {
            jsonResponse(res, 200, {
              ok: true,
              entries: readPersonalWorkbenchEntries(indexPath),
              calendar_proposals: readCalendarProposals(out),
            });
            return;
          }
          let payload: WorkbenchPayload;
          try {
            payload = JSON.parse(raw || '{}') as WorkbenchPayload;
          } catch {
            jsonResponse(res, 400, { ok: false, error: 'invalid json' });
            return;
          }
          if (req.url === '/action') {
            if (
              payload === null ||
              typeof payload !== 'object' ||
              !['email', 'calendar', 'ocr', 'knowledge'].includes(
                String((payload as Record<string, unknown>).action)
              )
            ) {
              jsonResponse(res, 400, {
                ok: false,
                error: 'action must be email, calendar, ocr, or knowledge',
              });
              return;
            }
            const actionPayload = payload as Record<string, unknown>;
            const result = await executePersonalWorkbenchAction({
              action: String(actionPayload.action) as PersonalWorkbenchAction,
              payload:
                actionPayload.payload && typeof actionPayload.payload === 'object'
                  ? (actionPayload.payload as Record<string, unknown>)
                  : {},
              confirmed: actionPayload.confirmed === true,
              context,
              evidenceRef: portableProtocolServicePathRef(handoff),
              outDir: out,
            });
            jsonResponse(res, 200, { ok: true, action: actionPayload.action, result });
            return;
          }
          jsonResponse(res, 200, await persist(payload));
        } catch (error) {
          const tooLarge = error instanceof LocalPadRequestBodyTooLargeError;
          jsonResponse(res, tooLarge ? 413 : 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[personal-workbench] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      recordProtocolServiceLifecycle({
        serviceId: 'personal-workbench',
        action: 'start',
        status: 'started',
        scope: context.scope,
        actorRole: 'surface_runtime',
        principal: { kind: 'human', id: context.viewer_principal },
        requestedBy: context.viewer_principal,
        correlationId: context.session_id,
        metadata: {
          port,
          artifact_ref: portableProtocolServicePathRef(context.artifact_ref),
          out: portableProtocolServicePathRef(out),
        },
      });
      print(
        options.json
          ? { ...preview, listening: true }
          : `Personal Workbench server → ${preview.url} (X-PW-Token)`
      );
      resolve();
    });
  });
  const shutdown = () => {
    server.close(() => undefined);
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'personal-workbench',
        action: 'stop',
        status: 'stopped',
        scope: context.scope,
        actorRole: 'surface_runtime',
        principal: { kind: 'human', id: context.viewer_principal },
        requestedBy: context.viewer_principal,
        correlationId: context.session_id,
      });
    } catch {
      /* shutdown best effort */
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runPersonalWorkbenchServer = defineScript({
  name: 'personal-workbench:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runPersonalWorkbenchServer();
}
