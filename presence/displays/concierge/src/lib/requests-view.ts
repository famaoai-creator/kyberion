/**
 * 仕事 › 依頼 (`/work?tab=requests`) view helpers — pure and client-safe.
 * The wire shape is the shared progress read model
 * (`@agent/core/surface/front-desk-progress`, types only here).
 */
import type {
  ProgressActiveItem,
  ProgressDeliveredItem,
  ProgressDetail,
  ProgressDoneItem,
  ProgressPayload,
  ProgressTaskState,
} from '@agent/core/surface/front-desk-progress';
import type { ConciergeMessageKey, FrontDeskMessageKey } from './i18n';
import { inboxHref } from './needs-you-client';
import { PERSONAL_SELECTION, SYSTEM_SELECTION } from './tenant-context';

export type RequestsSection = 'active' | 'delivered' | 'done';
export type RequestItem = ProgressActiveItem | ProgressDeliveredItem | ProgressDoneItem;
export type RequestsPayload = Pick<
  ProgressPayload,
  'active' | 'delivered' | 'done' | 'mirror_href'
>;
/** Detail; a delivery read on its own also names its artifact kind. */
export type RequestDetail = ProgressDetail & { artifact_kind?: string };

/** Query parameter that opens one request directly (id or request correlation). */
export const REQUEST_PARAM = 'request';
/**
 * 受信箱 filtered to deliverable reviews — the inbox reason a deliverable-inbox
 * entry is listed under (`libs/core/surface/needs-you.ts` `fromOutcome`).
 */
export const REQUESTS_INBOX_PATH = inboxHref({ reason: 'review', overdue: false });

const NARROWING: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant', ['tenant', 'tenant_slug']],
  ['organizationId', ['organizationId', 'organization_id']],
  ['projectId', ['projectId', 'project_id']],
];

function narrowingQuery(params: Pick<URLSearchParams, 'get'>): string {
  const query = new URLSearchParams();
  for (const [name, aliases] of NARROWING) {
    const value = aliases.map((alias) => params.get(alias)?.trim()).find(Boolean);
    if (value) query.set(name, value);
  }
  return query.toString();
}

/**
 * `/api/progress[/<id>]` with the page's narrowing hints — the same ones the
 * other 仕事 tabs pass. `tenant` is also the header's selection hint
 * (`personal` / `shared` included): the server resolves the selection itself
 * and only ever narrows.
 */
export function requestsApiPath(params: Pick<URLSearchParams, 'get'>, id?: string): string {
  const search = narrowingQuery(params);
  return '/api/progress' + (id ? '/' + encodeURIComponent(id) : '') + (search ? '?' + search : '');
}

/** `/api/work-inventory/candidates` with the page's selection hint. */
export function workInventoryPanelPath(params: Pick<URLSearchParams, 'get'>): string {
  const tenant = params.get('tenant')?.trim();
  return '/api/work-inventory/candidates' + (tenant ? '?tenant=' + encodeURIComponent(tenant) : '');
}

/** A company the page is narrowed to (not the personal / system views), for outgoing links. */
export function selectedCompany(params: Pick<URLSearchParams, 'get'>): string | null {
  const tenant = params.get('tenant')?.trim();
  return tenant && tenant !== PERSONAL_SELECTION && tenant !== SYSTEM_SELECTION ? tenant : null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const rows = <T>(value: unknown): T[] | null =>
  Array.isArray(value) && value.every((row) => record(row) && typeof row.id === 'string')
    ? (value as T[])
    : null;

export function parseRequestsPayload(body: unknown): RequestsPayload | null {
  if (!record(body) || body.ok !== true) return null;
  const active = rows<ProgressActiveItem>(body.active);
  const delivered = rows<ProgressDeliveredItem>(body.delivered);
  const done = rows<ProgressDoneItem>(body.done);
  if (!active || !delivered || !done) return null;
  return {
    active,
    delivered,
    done,
    mirror_href: typeof body.mirror_href === 'string' ? body.mirror_href : '',
  };
}

export function parseRequestDetail(body: unknown): RequestDetail | null {
  if (!record(body) || body.ok !== true || !record(body.item)) return null;
  const item = body.item;
  if (typeof item.requested !== 'string' || !Array.isArray(item.log)) return null;
  return item as unknown as RequestDetail;
}

export interface RequestTarget {
  section: RequestsSection;
  item: RequestItem;
}

function* allItems(payload: RequestsPayload): Generator<RequestTarget> {
  for (const item of payload.active) yield { section: 'active', item };
  for (const item of payload.delivered) yield { section: 'delivered', item };
  for (const item of payload.done) yield { section: 'done', item };
}

/**
 * The item a link opens: an exact id first, then the request correlation the
 * secretary dock links with (`?request=<id>`). Nothing asked → the newest
 * active item the read model marks as the default.
 */
export function findRequestTarget(
  payload: RequestsPayload,
  wanted: string | null
): RequestTarget | null {
  if (wanted) {
    for (const target of allItems(payload)) if (target.item.id === wanted) return target;
    for (const target of allItems(payload)) {
      const correlation = (target.item as { correlation_id?: string }).correlation_id;
      if (correlation && correlation === wanted) return target;
    }
    return null;
  }
  const fallback = payload.active.find((item) => item.selected_default);
  return fallback ? { section: 'active', item: fallback } : null;
}

/** The 依頼 page path. */
export const REQUESTS_PATH = '/work?tab=requests';

/**
 * A link that opens one request: `href` (which may already carry a query,
 * e.g. `/work?tab=requests`) plus `request=<id>` in the same query string.
 */
export function requestLinkHref(href: string, id: string): string {
  const hashIndex = href.indexOf('#');
  const base = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const queryIndex = base.indexOf('?');
  const path = queryIndex === -1 ? base : base.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex === -1 ? '' : base.slice(queryIndex + 1));
  query.set(REQUEST_PARAM, id);
  return path + '?' + query.toString();
}

/** The page URL with `?request=` set (or cleared), every other parameter kept. */
export function requestHref(pathname: string, current: URLSearchParams, id: string | null): string {
  const next = new URLSearchParams(current);
  if (id) next.set(REQUEST_PARAM, id);
  else next.delete(REQUEST_PARAM);
  const search = next.toString();
  return pathname + (search ? '?' + search : '');
}

/** Task states that are never "running": the record says so. */
export function taskStateKey(state: ProgressTaskState | undefined): FrontDeskMessageKey {
  return `progress_task_state_${state ?? 'unknown'}` as FrontDeskMessageKey;
}

/** The recorded-state hint under a task's detail (what the person can do next). */
export function taskStateHintKey(state: ProgressTaskState | undefined): FrontDeskMessageKey {
  switch (state) {
    case 'awaiting_input':
      return 'progress_task_next_input';
    case 'awaiting_confirmation':
      return 'progress_task_next_confirmation';
    case 'completed':
      return 'progress_task_next_result';
    case 'blocked':
    case 'paused':
    case 'failed':
    case 'released':
    case 'unknown':
    case undefined:
      return 'progress_task_next_inspect';
    default:
      return 'progress_task_next_refresh';
  }
}

export type InboxStatus = 'unread' | 'read' | 'accepted' | 'rejected' | 'changes_requested';
const INBOX_STATUSES: ReadonlySet<string> = new Set([
  'unread',
  'read',
  'accepted',
  'rejected',
  'changes_requested',
]);

export function isInboxStatus(value: unknown): value is InboxStatus {
  return typeof value === 'string' && INBOX_STATUSES.has(value);
}

/** Label key of an inbox status (Concierge home uses the same labels). */
export function inboxStatusKey(status: InboxStatus): ConciergeMessageKey {
  return `home.status.${status}` as ConciergeMessageKey;
}

export function itemTaskState(item: RequestItem): ProgressTaskState | undefined {
  return (item as { task_state?: ProgressTaskState }).task_state;
}

/**
 * A delivered item whose inbox entry still waits for a decision. The decision
 * is made in 受信箱, never on this page.
 */
export function needsInboxDecision(item: RequestItem): boolean {
  return (item as ProgressDeliveredItem).can_verdict === true;
}

/** `0–100`, or `null` when the read model has no estimate for the state. */
export function estimatedPercent(item: RequestItem): number | null {
  const active = item as ProgressActiveItem;
  if (active.progress_basis !== 'phase_estimate' || typeof active.percent !== 'number') return null;
  return Math.max(0, Math.min(100, Math.round(active.percent)));
}

export const WORK_INVENTORY_STATUSES = [
  'draft',
  'confirmed',
  'candidate',
  'promoted',
  'retired',
] as const;
export type WorkInventoryStatus = (typeof WORK_INVENTORY_STATUSES)[number];

export interface WorkInventoryPanelView {
  /** False when no inventory is in view: the page asks for a company instead. */
  scoped: boolean;
  candidates: Array<{
    entry_id: string;
    title: string;
    score: number;
    hours_per_month: number;
    automatable_ratio: number;
    status: WorkInventoryStatus;
  }>;
  counts: Record<WorkInventoryStatus, number>;
  consent?: { active: number; expires_soonest?: string; pending_summaries: number };
  start_href: string;
  operator_hint: boolean;
}

const isStatus = (value: unknown): value is WorkInventoryStatus =>
  (WORK_INVENTORY_STATUSES as readonly unknown[]).includes(value);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function parseWorkInventoryPanel(body: unknown): WorkInventoryPanelView | null {
  if (!record(body) || body.ok !== true || !Array.isArray(body.candidates)) return null;
  if (typeof body.start_href !== 'string' || !record(body.counts)) return null;
  const counts = body.counts;
  const candidates = body.candidates
    .filter(record)
    .filter((row) => typeof row.entry_id === 'string' && isStatus(row.status))
    .map((row) => ({
      entry_id: row.entry_id as string,
      title: typeof row.title === 'string' ? row.title : (row.entry_id as string),
      score: num(row.score),
      hours_per_month: num(row.hours_per_month),
      automatable_ratio: num(row.automatable_ratio),
      status: row.status as WorkInventoryStatus,
    }));
  const consent = record(body.consent)
    ? {
        active: num(body.consent.active),
        ...(typeof body.consent.expires_soonest === 'string'
          ? { expires_soonest: body.consent.expires_soonest }
          : {}),
        pending_summaries: num(body.consent.pending_summaries),
      }
    : undefined;
  return {
    scoped: body.scoped === true,
    candidates,
    counts: Object.fromEntries(
      WORK_INVENTORY_STATUSES.map((status) => [status, num(counts[status])])
    ) as Record<WorkInventoryStatus, number>,
    ...(consent ? { consent } : {}),
    start_href: body.start_href,
    operator_hint: body.operator_hint === true,
  };
}

/** Artifact kinds grouped into the few labels a person needs. */
const KIND_GROUPS: ReadonlyArray<readonly [ConciergeMessageKey, readonly string[]]> = [
  [
    'ia_work_requests_kind_report',
    [
      'report',
      'operations_report',
      'research_report',
      'summary',
      'evaluation',
      'incident_analysis',
    ],
  ],
  ['ia_work_requests_kind_deck', ['deck', 'ppt', 'pptx', 'presentation', 'slide', 'slides']],
  [
    'ia_work_requests_kind_document',
    [
      'doc',
      'document',
      'docx',
      'pdf',
      'md',
      'markdown',
      'txt',
      'text',
      'guide',
      'brief',
      'proposal',
      'plan',
    ],
  ],
  ['ia_work_requests_kind_data', ['json', 'csv', 'xls', 'xlsx', 'yaml', 'yml', 'data_analysis']],
  ['ia_work_requests_kind_image', ['image', 'png', 'jpg', 'jpeg', 'gif', 'svg']],
  ['ia_work_requests_kind_media', ['audio', 'mp3', 'wav', 'video', 'mp4', 'webm', 'media']],
];

/** Label key for an artifact kind; anything unlisted is a generic deliverable. */
export function artifactKindKey(kind: string | undefined): ConciergeMessageKey {
  const value = String(kind ?? '').toLowerCase();
  return (
    KIND_GROUPS.find(([, kinds]) => kinds.includes(value))?.[0] ?? 'ia_work_requests_kind_other'
  );
}

const DATE_STEM = /^(\d{4}-\d{2}-\d{2})(?:[T_ -][\d:.-]+)?$/u;

/** What the server says about a delivery row (`lib/progress-server.ts`). */
export interface DeliveryTitleFacts {
  title: string;
  artifact_kind?: string;
  /** The title is the delivery's file name (not a preview line or a kind). */
  title_from_file?: boolean;
}

/**
 * A readable title for a delivery. Only a title the server marks as a file
 * name is rewritten: a bare date file (`2026-10-24.json`) becomes
 * "<kind label> 2026-10-24", any other file name loses its extension.
 * Request (task-session) titles are the person's own words and stay as is.
 */
export function readableDeliveryTitle(
  item: DeliveryTitleFacts,
  kindLabel: (key: ConciergeMessageKey) => string
): string {
  if (!item.title_from_file) return item.title;
  const stem = item.title.replace(/\.[A-Za-z0-9]{1,8}$/u, '');
  const date = stem.match(DATE_STEM)?.[1];
  if (date) return `${kindLabel(artifactKindKey(item.artifact_kind))} ${date}`;
  return stem || item.title;
}
