/** One localhost listener for all capture pads. */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import { getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';
import {
  narrowSurfaceViewerTier,
  resolveSurfaceViewerScope,
} from '@agent/core/surface-mutation-guard';
import { resolveTenant } from '@agent/core/tenant-registry';
import {
  createLocalPadContext,
  isLocalPadOriginAllowed,
  option,
  positionalArgs,
  readLocalPadRequestBody,
  validateLocalPadContentLength,
  LOCAL_PAD_COMMON_FLAGS,
  type LocalPadContext,
} from '../lib/local-artifact-pad.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { assertPadAdaptersComplete } from './adapters.js';
import { executePadAction, getPadActionAvailability } from './actions.js';
import { personalPadsPage } from './page.js';
import { PERSONAL_PADS_SURFACE, type PersonalPadsSurface } from './surface.js';
import {
  allowedPadTiers,
  defaultPadStorageRoot,
  PadRecordStore,
  type PadRecord,
} from './storage.js';

export { augmentPersonalPadsPage, personalPadsPage } from './page.js';

export const PERSONAL_PADS_DEFAULT_PORT = 8160;
/** Transport ceiling; each registry entry applies its own stricter limit. */
export const PERSONAL_PADS_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const PERSONAL_PADS_REQUEST_TIMEOUT_MS = 60_000;

export interface PersonalPadsServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  port: number;
  url: string;
  storage_root: string;
  scope: LocalPadContext['scope'];
  viewer_principal: string;
  listening: boolean;
}

export interface PersonalPadsServerOptions {
  dryRun?: boolean;
  check?: boolean;
  print?: (value: unknown) => void;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function html(res: http.ServerResponse, value: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(value);
}

/** History is a browser-facing projection; handoff paths stay server-side. */
export function toPublicPadRecord(record: PadRecord): Omit<PadRecord, 'handoff_ref'> {
  const { handoff_ref: _handoffRef, ...publicRecord } = record;
  return publicRecord;
}

function resolveStartupScope(args: string[]): {
  context: LocalPadContext;
  storageRoot: string;
  port: number;
} {
  const positionals = positionalArgs(args, [...LOCAL_PAD_COMMON_FLAGS, '--storage-root']);
  const port = Number(positionals[0] || PERSONAL_PADS_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ScriptExitError(1, `invalid port: ${port}`);
  const tier = (option(args, '--tier') || 'personal') as 'public' | 'confidential' | 'personal';
  if (!['public', 'confidential', 'personal'].includes(tier))
    throw new ScriptExitError(1, `invalid tier: ${tier}`);
  const serverTenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
  const cliTenant = option(args, '--tenant')?.trim();
  if (serverTenant && cliTenant && serverTenant !== cliTenant)
    throw new ScriptExitError(1, 'CLI tenant does not match server-side KYBERION_TENANT scope');
  const tenant = serverTenant || cliTenant;
  if (tier !== 'public' && !tenant)
    throw new ScriptExitError(
      1,
      'confidential and personal pads require server-side KYBERION_TENANT scope'
    );
  if (tenant) resolveTenant(tenant);
  const principal = (
    getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
    getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
    'local-pad-operator'
  ).trim();
  const context = createLocalPadContext({
    serviceId: 'personal-pads',
    sessionPrefix: 'pads',
    artifact_ref: option(args, '--artifact-ref') || 'local-pads',
    viewer_principal: principal,
    tier,
    tenant_slug: tenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  return { context, storageRoot: option(args, '--storage-root') || defaultPadStorageRoot(), port };
}

function scopeForRequest(base: LocalPadContext, requestedTier: unknown): LocalPadContext {
  const tier = requestedTier === undefined ? base.scope.tier : String(requestedTier);
  if (!['public', 'confidential', 'personal'].includes(tier)) throw new Error('invalid tier');
  const viewerScope = resolveSurfaceViewerScope({
    local: true,
    allowLoopback: true,
    loopbackRole: 'localadmin',
    loopbackUsesServerTenant: true,
    serverTenant: base.scope.tenant_slug,
    principalIds: { localadmin: base.viewer_principal },
  });
  narrowSurfaceViewerTier(viewerScope, tier as 'public' | 'confidential' | 'personal');
  if (!allowedPadTiers(base.scope.tier).includes(tier as 'public' | 'confidential' | 'personal')) {
    throw new Error(`viewer tier scope denied: ${tier}`);
  }
  if (tier !== 'public' && !base.scope.tenant_slug)
    throw new Error('tenant scope is required for this tier');
  return createLocalPadContext({
    serviceId: 'personal-pads',
    sessionPrefix: 'pads',
    artifact_ref: base.artifact_ref,
    viewer_principal: base.viewer_principal,
    tier: tier as 'public' | 'confidential' | 'personal',
    tenant_slug: base.scope.tenant_slug,
    organization_id: base.scope.organization_id,
    project_id: base.scope.project_id,
    mission_id: base.scope.mission_id,
  });
}

function requestErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/artifact exceeds/u.test(message)) return 413;
  if (/artifact data must be valid base64/u.test(message)) return 400;
  if (/invalid JSON|JSON parse|unexpected token/u.test(message)) return 400;
  if (
    /unknown pad|unknown pad action|invalid tier|input is required|body is required|exceeds|metadata|managed artifact data|record not found|calendar event requires|approval_request_id is invalid|proposal binding is invalid|reconciliation token binding is invalid/u.test(
      message
    )
  )
    return 400;
  if (/tenant scope|server-derived scope|does not match|viewer tier scope denied/u.test(message))
    return 403;
  return 500;
}

/** Keep transport errors useful without reflecting repository/provider paths. */
export function toPublicRequestError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    /(?:ENOENT|EACCES|EPERM|secure-io|(?:^|[\s:(])(?:[A-Za-z]:[\\/]|\/|active[\\/])|(?:path|directory|out_dir|file_path))/iu.test(
      raw
    )
  ) {
    return {
      code: 'storage_or_provider_error',
      message: '操作を完了できませんでした。設定と権限を確認してください。',
    };
  }
  return {
    code: 'request_failed',
    message: raw || '操作を完了できませんでした。',
  };
}

export function createPersonalPadsServer(
  base: LocalPadContext,
  storageRoot: string,
  token: string,
  surface: PersonalPadsSurface = PERSONAL_PADS_SURFACE
): http.Server {
  const activeCaptureCounts = new Map<string, number>();
  const acquireCapture = (padId: string, maxConcurrent: number): (() => void) | undefined => {
    const active = activeCaptureCounts.get(padId) ?? 0;
    if (active >= maxConcurrent) return undefined;
    activeCaptureCounts.set(padId, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeCaptureCounts.get(padId) ?? 1) - 1;
      if (remaining > 0) activeCaptureCounts.set(padId, remaining);
      else activeCaptureCounts.delete(padId);
    };
  };
  const authorize = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const host = req.headers.host;
    if (host && !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host)) {
      json(res, 403, { error: 'host must be localhost' });
      req.resume();
      return false;
    }
    if (req.headers['x-pads-token'] !== token && req.headers.authorization !== `Bearer ${token}`) {
      json(res, 403, { error: 'invalid local pads token' });
      req.resume();
      return false;
    }
    if (!isLocalPadOriginAllowed(req.headers.origin)) {
      json(res, 403, { error: 'origin must be localhost' });
      req.resume();
      return false;
    }
    try {
      validateLocalPadContentLength(req.headers['content-length'], PERSONAL_PADS_MAX_BODY_BYTES);
    } catch {
      json(res, 413, { error: 'request body too large' });
      req.resume();
      return false;
    }
    return true;
  };

  return http.createServer(async (req, res) => {
    let releaseCapture: (() => void) | undefined;
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        html(res, personalPadsPage(token, base, surface));
        return;
      }
      if (!authorize(req, res)) return;
      const context = scopeForRequest(base, url.searchParams.get('tier') || undefined);
      if (req.method === 'GET' && url.pathname === '/api/context') {
        json(res, 200, {
          top: surface.getTop(context),
          ...surface.getSurfaceContract(),
          scope: context.scope,
          viewer_principal: context.viewer_principal,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/pads') {
        json(res, 200, {
          menu: surface.getMenu(),
          content: surface.getSurfaceContract().content,
          scope: context.scope,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/action-readiness') {
        const content = surface.getContent(url.searchParams.get('pad'));
        json(res, 200, {
          actions: content.adapter.actions.map((action) => {
            try {
              return (
                surface.getActionAvailability ??
                ((padId, actionId) => getPadActionAvailability(padId, actionId, content.adapter))
              )(content.entry.id, action.id);
            } catch {
              return {
                action_id: action.id,
                status: 'ready' as const,
                message: 'host-provided action',
              };
            }
          }),
          scope: context.scope,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const padId = url.searchParams.get('pad');
        const content = surface.getContent(padId);
        const history = surface.getHistory(
          context,
          content.entry.id,
          {
            cursor: url.searchParams.get('cursor') || undefined,
            limit: Number(url.searchParams.get('limit') || 25),
          },
          storageRoot
        );
        json(res, 200, {
          ...history,
          records: history.records.map(toPublicPadRecord),
          scope: context.scope,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
        const padId = url.searchParams.get('pad');
        const content = surface.getContent(padId);
        const store = new PadRecordStore(
          context.scope,
          context.viewer_principal,
          content.entry.id,
          surface.resolveStoragePolicyId(content.entry.id, context.scope.tier),
          storageRoot
        );
        const artifactId = url.searchParams.get('artifact');
        if (artifactId) {
          const artifact = store.readArtifact(id, artifactId);
          if (!artifact) {
            json(res, 404, { error: 'artifact not found' });
            return;
          }
          json(res, 200, { artifact, scope: context.scope });
          return;
        }
        const record = store.get(id);
        if (!record) {
          json(res, 404, { error: 'record not found' });
          return;
        }
        json(res, 200, { record: toPublicPadRecord(record), scope: context.scope });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/capture') {
        const body = parseSafeJsonInput(
          await readLocalPadRequestBody(req, PERSONAL_PADS_MAX_BODY_BYTES),
          'personal pads capture'
        ) as Record<string, unknown>;
        const padId = body.pad_id;
        const content = surface.getContent(padId);
        const { adapter } = content;
        releaseCapture = acquireCapture(content.entry.id, content.entry.max_concurrent);
        if (!releaseCapture) {
          json(res, 503, {
            error: '同じ pad の保存処理が上限に達しています。完了を待ってください。',
          });
          return;
        }
        if (body.tier !== undefined && body.tier !== context.scope.tier) {
          json(res, 403, { error: 'tier must match server-derived scope' });
          return;
        }
        if (typeof body.body !== 'string') {
          json(res, 400, { error: 'body is required' });
          return;
        }
        const fields =
          body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
            ? (body.fields as Record<string, unknown>)
            : {};
        const hasFieldValue = Object.values(fields).some(
          (value) => typeof value === 'string' && value.trim().length > 0
        );
        if (adapter.body_mode === 'freeform' && !body.body.trim()) {
          json(res, 400, { error: 'body is required' });
          return;
        }
        if (adapter.body_mode === 'composed' && !body.body.trim() && !hasFieldValue) {
          json(res, 400, { error: 'adapter input is required' });
          return;
        }
        const composed = adapter.composeCapture({
          body: body.body,
          title: typeof body.title === 'string' ? body.title : '',
          fields,
          artifact_manifest: Array.isArray(body.artifact_manifest)
            ? body.artifact_manifest.filter((v): v is string => typeof v === 'string')
            : [],
        });
        const maxBytes = content.entry.max_body_bytes;
        if (Buffer.byteLength(composed.body, 'utf8') > maxBytes) {
          json(res, 413, { error: 'capture exceeds pad adapter size limit' });
          return;
        }
        const record = new PadRecordStore(
          context.scope,
          context.viewer_principal,
          content.entry.id,
          surface.resolveStoragePolicyId(content.entry.id, context.scope.tier),
          storageRoot
        ).save({
          title: typeof body.title === 'string' ? body.title : '',
          body: composed.body,
          adapter_id: adapter.id,
          adapter_schema_version: '1',
          payload: composed.payload,
          artifacts: composed.artifacts,
          idempotency_key:
            typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined,
          artifact_manifest: composed.artifact_manifest,
        });
        // Capture shares the same browser-facing projection as history/detail.
        // The durable handoff reference remains server-side even on the write
        // response; clients only need the logical record/artifact metadata.
        json(res, 201, { record: toPublicPadRecord(record), scope: context.scope });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const body = parseSafeJsonInput(
          await readLocalPadRequestBody(req, PERSONAL_PADS_MAX_BODY_BYTES),
          'personal pads action'
        ) as Record<string, unknown>;
        const padId = body.pad_id;
        const content = surface.getContent(padId);
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') > content.entry.max_body_bytes) {
          json(res, 413, { error: 'action input exceeds pad adapter size limit' });
          return;
        }
        const actionId = typeof body.action_id === 'string' ? body.action_id : '';
        if (!actionId) {
          json(res, 400, { error: 'action_id is required' });
          return;
        }
        if (!content.adapter.actions.some((action) => action.id === actionId)) {
          json(res, 400, { error: `unknown pad action: ${content.entry.id}/${actionId}` });
          return;
        }
        if (body.tier !== undefined && body.tier !== context.scope.tier) {
          json(res, 403, { error: 'tier must match server-derived scope' });
          return;
        }
        const fields =
          body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
            ? (body.fields as Record<string, unknown>)
            : {};
        let record;
        if (typeof body.record_id === 'string' && body.record_id.trim()) {
          const store = new PadRecordStore(
            context.scope,
            context.viewer_principal,
            content.entry.id,
            surface.resolveStoragePolicyId(content.entry.id, context.scope.tier),
            storageRoot
          );
          record = store.get(body.record_id.trim());
          if (!record) {
            json(res, 404, { error: 'record not found' });
            return;
          }
        }
        const result = await (surface.executeAction ?? executePadAction)({
          pad_id: content.entry.id,
          action_id: actionId,
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
          fields,
          context,
          storage_root: storageRoot,
          adapter: content.adapter,
          ...(record ? { record } : {}),
        });
        json(res, 200, { ...result, scope: context.scope });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      const publicError = toPublicRequestError(error);
      json(res, requestErrorStatus(error), {
        error: publicError.message,
        code: publicError.code,
      });
    } finally {
      releaseCapture?.();
    }
  });
}

export async function runPersonalPadsServer(
  args: string[] = [],
  options: PersonalPadsServerOptions = {}
): Promise<PersonalPadsServerResult | undefined> {
  assertProtocolServiceRegistered('personal-pads');
  assertPadAdaptersComplete();
  const { context, storageRoot, port } = resolveStartupScope(args);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const preview: PersonalPadsServerResult = {
    ok: true,
    mode,
    port,
    url: `http://127.0.0.1:${port}/`,
    storage_root: storageRoot,
    scope: context.scope,
    viewer_principal: context.viewer_principal,
    listening: false,
  };
  const print = options.print || (() => undefined);
  if (options.check || options.dryRun) {
    print(preview);
    return preview;
  }
  const token = randomBytes(16).toString('hex');
  const server = createPersonalPadsServer(context, storageRoot, token);
  server.requestTimeout = PERSONAL_PADS_REQUEST_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  print({ ...preview, listening: true, token });
  return { ...preview, listening: true };
}

export const main = defineScript({
  name: 'personal-pads:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, print }) => runPersonalPadsServer(argv, { dryRun, check, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js'))
  void main();
