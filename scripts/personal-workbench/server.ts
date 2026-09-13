/**
 * personal-workbench — one local inbox for personal secretary workflows.
 *
 * Captures links, tasks, follow-ups, decisions, expenses, and daily-review
 * notes into personal-tier operator proposals. It never sends mail, changes a
 * calendar, or promotes knowledge automatically.
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
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
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';
import { executePersonalWorkbenchAction, type PersonalWorkbenchAction } from './actions.js';

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

function readEntries(indexPath: string): WorkbenchEntry[] {
  if (!safeExistsSync(indexPath)) return [];
  try {
    const parsed = readSafeJsonFile<unknown>(indexPath, 'personal-workbench entries');
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

function pageHtml(token: string, out: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Personal Workbench</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Yu Gothic",sans-serif;color:#17202b;background:#eef2f6}body{max-width:1100px;margin:auto;padding:18px}main{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{background:#fff;border:1px solid #d5dbe5;border-radius:12px;padding:14px;display:grid;gap:8px}textarea,input,select{font:inherit;padding:9px;border:1px solid #cbd3df;border-radius:8px}textarea{min-height:130px}.wide{grid-column:1/-1}.muted{font-size:12px;color:#5c6778}button{padding:9px 13px;border:0;border-radius:8px;background:#356d5b;color:white;cursor:pointer}#status{min-height:1.4em}.entry{border-top:1px solid #e1e5eb;padding:8px 0}.entry small{color:#687487}.entry p{white-space:pre-wrap;margin:5px 0}
  </style></head><body><h1>Personal Workbench</h1><p class="muted">Link、Task、Follow-up、Decision、Expense、Daily Review を一つの personal inbox に保存します。メール・カレンダー変更は明示承認後、OCR と知識候補登録は governed API 経由で実行します。</p>
  <main><section class="card"><label>用途<select id="kind"><option value="link">Link Inbox</option><option value="task">Task Triage</option><option value="follow-up">Follow-up Desk</option><option value="decision">Decision Log</option><option value="expense">Receipt / Expense</option><option value="daily-review">Daily Review</option></select></label><label>タイトル<input id="title" maxlength="200"/></label><label>内容<textarea id="body"></textarea></label><label>補足（JSON）<input id="meta" placeholder='{"due":"2026-09-14"}'/></label><button id="save">提案として保存</button><div id="status"></div><div class="muted">出力先: ${escapeHtml(out)}</div></section><section class="card"><h2>保存済み</h2><button id="load">認証済みデータを読む</button><div id="entries" class="muted">未読込</div></section><section class="card wide"><h2>Governed actions</h2><label>操作<select id="action"><option value="ocr">OCR</option><option value="knowledge">知識候補登録</option><option value="email">メール送信</option><option value="calendar">カレンダー変更</option></select></label><label>入力（JSON）<textarea id="actionPayload" placeholder='{"path":"active/shared/tmp/receipt.png"}'></textarea></label><label><input id="approval" type="checkbox"/> メール送信・カレンダー変更を承認する</label><button id="runAction">操作を実行</button><div class="muted">メール・カレンダーは明示承認が必要。知識は候補キューに入り、自動公開されません。</div></section></main>
  <script>(function(){var token=${JSON.stringify(token)},status=document.getElementById('status'),entries=document.getElementById('entries');function say(x){status.textContent=x}function render(rows){entries.innerHTML=rows.length?rows.map(function(e){return '<div class="entry"><b>'+esc(e.kind)+' — '+esc(e.title)+'</b><small> '+esc(e.status)+' / '+esc(e.created_at)+'</small><p>'+esc(e.body)+'</p></div>'}).join(''):'<span class="muted">まだありません</span>'}function esc(x){return String(x||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}document.getElementById('save').onclick=function(){var meta={};try{meta=JSON.parse(document.getElementById('meta').value||'{}')}catch(e){say('補足 JSON が不正です');return}say('保存中…');fetch('/capture',{method:'POST',headers:{'Content-Type':'application/json','X-PW-Token':token},body:JSON.stringify({kind:document.getElementById('kind').value,title:document.getElementById('title').value,body:document.getElementById('body').value,metadata:meta})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){if(!x.ok||!x.j.ok)throw Error(x.j.error||'保存失敗');say('保存しました（人間承認待ち）');document.getElementById('title').value='';document.getElementById('body').value='';return fetch('/load',{method:'POST',headers:{'X-PW-Token':token},body:'{}'})}).then(function(r){return r.json()}).then(function(j){if(j.ok)render(j.entries||[])}).catch(function(e){say(e.message||'保存失敗')});};document.getElementById('load').onclick=function(){say('読込中…');fetch('/load',{method:'POST',headers:{'X-PW-Token':token},body:'{}'}).then(function(r){return r.json()}).then(function(j){if(!j.ok)throw Error(j.error||'読込失敗');render(j.entries||[]);say('読込完了')}).catch(function(e){say(e.message||'読込失敗')})};document.getElementById('runAction').onclick=function(){var payload={};try{payload=JSON.parse(document.getElementById('actionPayload').value||'{}')}catch(e){say('操作 JSON が不正です');return}say('実行中…');fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-PW-Token':token},body:JSON.stringify({action:document.getElementById('action').value,payload:payload,approved:document.getElementById('approval').checked})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){if(!x.ok||!x.j.ok)throw Error(x.j.error||'操作失敗');say('完了: '+JSON.stringify(x.j.result))}).catch(function(e){say(e.message||'操作失敗')})};})();</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
  );
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
    const entries = [...readEntries(indexPath), entry].slice(-PERSONAL_WORKBENCH_MAX_ENTRIES);
    safeWriteFile(indexPath, JSON.stringify(entries, null, 2), { mkdir: true, encoding: 'utf8' });
    const sessionDir = localPadSessionDir(out, entry.id);
    safeMkdir(sessionDir, { recursive: true });
    const sessionHandoff = path.join(sessionDir, 'handoff.json');
    const automaticKnowledge =
      payload.kind === 'decision' || payload.kind === 'daily-review'
        ? await executePersonalWorkbenchAction({
            action: 'knowledge',
            payload: { summary: `${entry.title}: ${entry.body}` },
            context,
            evidenceRef: portableProtocolServicePathRef(sessionHandoff),
          })
        : undefined;
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
        ...(automaticKnowledge ? { knowledge_candidate: automaticKnowledge } : {}),
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
      requires_human_approval: true,
      ...(automaticKnowledge ? { knowledge_candidate: automaticKnowledge } : {}),
    };
  }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(pageHtml(token, out));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
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
            jsonResponse(res, 200, { ok: true, entries: readEntries(indexPath) });
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
              approved: actionPayload.approved === true,
              context,
              evidenceRef: portableProtocolServicePathRef(handoff),
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
