/**
 * Shared helpers for localhost artifact-review pads (sketch / meeting / personal pads).
 * Keeps request bounds, token/origin checks, and scope context consistent.
 */
import { randomUUID } from 'node:crypto';
import type { EventScope, EventScopeKind } from '@agent/core/event-scope';
import { normalizeEventScope } from '@agent/core/event-scope';

export type PadTier = 'public' | 'confidential' | 'personal';

export interface LocalPadContext {
  session_id: string;
  artifact_ref: string;
  viewer_principal: string;
  scope: EventScope;
}

export function createLocalPadContext(input: {
  serviceId: string;
  sessionPrefix: string;
  artifact_ref: string;
  viewer_principal: string;
  tier: PadTier;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
}): LocalPadContext {
  const artifactRef = input.artifact_ref.trim();
  if (!artifactRef) {
    throw new Error(`[${input.serviceId.toUpperCase()}_SCOPE_REQUIRED] artifact_ref is required`);
  }
  const viewerPrincipal = input.viewer_principal.trim();
  if (!viewerPrincipal) {
    throw new Error(
      `[${input.serviceId.toUpperCase()}_VIEWER_REQUIRED] viewer_principal is required`
    );
  }
  if (input.tier !== 'public' && !input.tenant_slug?.trim()) {
    throw new Error(
      `[${input.serviceId.toUpperCase()}_SCOPE_REQUIRED] confidential and personal pads require a tenant`
    );
  }
  const scopeKind: EventScopeKind = input.mission_id
    ? 'mission'
    : input.project_id
      ? 'project'
      : input.organization_id
        ? 'organization'
        : input.tenant_slug
          ? 'tenant'
          : 'system';
  const scope = normalizeEventScope({
    scope_kind: scopeKind,
    tier: input.tier,
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    ...(input.organization_id ? { organization_id: input.organization_id } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
  });
  return {
    session_id: `${input.sessionPrefix}-${randomUUID()}`,
    artifact_ref: artifactRef,
    viewer_principal: viewerPrincipal,
    scope,
  };
}

export function localPadReceiptPath(serviceId: string, context: LocalPadContext): string {
  const prefix = context.scope.tenant_slug
    ? `active/shared/observability/${serviceId}/tenants/${context.scope.tenant_slug}`
    : `active/shared/observability/${serviceId}`;
  return `${prefix}/receipts/${context.session_id}.json`;
}

export function localPadHandoffPath(outDir: string): string {
  return `${outDir.replace(/\/$/, '')}/handoff.json`;
}

export function localPadSessionDir(outDir: string, sessionId: string): string {
  return `${outDir.replace(/\/$/, '')}/sessions/${sessionId}`;
}

export class LocalPadRequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = 'LocalPadRequestBodyTooLargeError';
  }
}

export async function readLocalPadRequestBody(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new LocalPadRequestBodyTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function validateLocalPadContentLength(
  value: string | undefined,
  maxBytes: number
): number | undefined {
  if (value === undefined) return undefined;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw new LocalPadRequestBodyTooLargeError(maxBytes);
  }
  return bytes;
}

/** Reject non-localhost Origin headers (same policy as sketch / meeting pads). */
export function isLocalPadOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin);
}

export function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function positionalArgs(args: string[], consumingFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (consumingFlags.includes(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export const LOCAL_PAD_COMMON_FLAGS = [
  '--out',
  '--instruction',
  '--title',
  '--artifact-ref',
  '--tier',
  '--tenant',
  '--organization-id',
  '--project-id',
  '--mission-id',
];

export function escHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function padShellCss(accent = '#2f6f5e'): string {
  return `
  :root{--bg:#eef2f6;--panel:#fff;--ink:#1a2230;--line:#d5dbe5;--accent:${accent};--muted:#5c6778;--danger:#a33}
  @media (prefers-color-scheme:dark){:root{--bg:#10151d;--panel:#18202c;--ink:#e8eef6;--line:#2a3545;--accent:#4fb39a;--muted:#9aa6b8;--danger:#e07272}}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;background:var(--bg);color:var(--ink)}
  header{padding:16px 18px 8px}
  header h1{margin:0;font-size:20px;font-weight:650}
  header p{margin:6px 0 0;font-size:13px;color:var(--muted);line-height:1.45;max-width:56rem}
  .bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
  .bar button,.bar label.btn{background:#e8eef4;border:1px solid var(--line);color:inherit;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;font-family:inherit}
  @media (prefers-color-scheme:dark){.bar button,.bar label.btn{background:#222c3b}}
  .bar button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .bar button.rec,.bar button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  .bar button.danger{background:var(--danger);color:#fff;border-color:var(--danger)}
  .status{font-size:11px;opacity:.8;margin-left:4px}
  main{display:grid;gap:14px;padding:14px 18px 28px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;display:grid;gap:8px;align-content:start}
  label.field{font-size:12px;color:var(--muted)}
  input[type=text],textarea,select{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;background:var(--bg);color:inherit}
  textarea{min-height:140px;resize:vertical}
  .note{font-size:11px;color:var(--muted);line-height:1.45}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  .list li{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:12px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg)}
  .list li button{border:0;background:transparent;color:var(--danger);cursor:pointer;font:inherit}
  canvas{display:block;width:100%;height:min(60vh,640px);touch-action:none;cursor:crosshair;background:#111;border-radius:8px}
  input[type=file]{display:none}
  pre.face{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;min-height:180px;margin:0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);overflow:auto}
`;
}
