/**
 * DL-08 — authenticated inbound event intake that wakes resident dots.
 *
 * Flow: `scripts/event_intake_surface.ts` receives `POST /events/<source>`,
 * {@link processInboundEventRequest} checks the source against
 * `event-intake-policy.json` (every source disabled by default), verifies the
 * HMAC-SHA256 signature over the raw body, normalizes the event and appends
 * it once (dedup by source + delivery id) to an `events.jsonl` ledger. The
 * supervisor sweep then calls {@link evaluateDotEventTriggers} per charter;
 * each matching, not-yet-handled event becomes one `event:<event_id>` wake.
 *
 * Security decisions:
 * - The sender is a machine principal authenticated only by the shared HMAC
 *   secret; there is no viewer and no client-supplied scope. `tenant_slug` is
 *   taken from the policy entry of the source, never from the payload.
 * - Tenant-bound sources write under the physical tenant namespace
 *   (`active/shared/runtime/dot/tenants/<slug>/events.jsonl`); untenanted
 *   sources write the system floor (`active/shared/runtime/dot/events.jsonl`).
 *   A tenant dot only reads its tenant's ledger, an untenanted dot only the
 *   system ledger, so events never cross tenants.
 * - The events ledger is tenant-scoped, not organization-scoped: the policy
 *   binds a source to a tenant only, so every dot of that tenant shares it.
 * - Stored payloads are bounded to {@link DOT_EVENT_PAYLOAD_MAX_BYTES}; the
 *   digest always covers the full raw body. Payload text is external input:
 *   the wake detail labels it untrusted and carries only a bounded summary.
 */

import * as path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFileTail } from '../secure-io.js';
import { appendJsonLine, readJson } from '../foundation/json.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { createLogger } from '../logger.js';
import { physicalScopedPath } from '../physical-namespace.js';
import { getSecret as secretGuardGetSecret } from '../secret/secret-guard.js';
import type { DotCharter, DotTrigger } from './dot-charter.js';
import { DOT_EVENTS_FILE, DOT_STATE_ROOT, type DotInboundEvent } from './dot-state-paths.js';
import {
  buildDotDueChecker,
  readDotWakeLedger,
  type DotRuntimeDeps,
  type DueDotTrigger,
} from './dot-runtime.js';

const logger = createLogger('dot-event-intake');

export const EVENT_INTAKE_POLICY_PATH = 'knowledge/product/governance/event-intake-policy.json';
export const EVENT_INTAKE_POLICY_SCHEMA_PATH =
  'knowledge/product/schemas/event-intake-policy.schema.json';
/** Max serialized size of the payload kept in the ledger (16 KB). */
export const DOT_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
/** A dot with no handled event yet only sees events this recent. */
export const DOT_EVENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Max event wakes offered per dot per sweep (oldest first). */
export const DOT_EVENT_MAX_DUE_PER_SWEEP = 5;
/** Only the ledger tail is scanned per sweep / dedup check. */
export const DOT_EVENT_SCAN_TAIL = 2000;
/** Byte bound of the tail read (the whole ledger is never loaded). */
export const DOT_EVENT_SCAN_TAIL_BYTES = 4 * 1024 * 1024;
/** A same-source event with an identical payload digest inside this window is a replay. */
export const DOT_EVENT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Shorter HMAC secrets are treated as unconfigured (fail closed). */
export const EVENT_INTAKE_MIN_SECRET_LENGTH = 16;
const EVENT_SUMMARY_MAX = 300;
const EVENT_DETAIL_MAX = 500;
const HEADER_VALUE_MAX = 200;

export interface EventIntakeSourcePolicy {
  enabled: boolean;
  description?: string;
  signature_header: string;
  prefix?: string;
  secret_key: string;
  event_type_header: string;
  delivery_id_header: string;
  tenant_slug?: string;
  max_body_bytes: number;
  /**
   * Payload-digest replay window in hours (default 24). Dedupe ignores the
   * unsigned event type, so a sender that legitimately re-sends an identical
   * body (e.g. a fixed ping) must lower this; 0 disables payload-digest dedupe
   * and leaves only (source, delivery_id) dedupe.
   */
  replay_window_hours?: number;
}

export interface EventIntakePolicy {
  $schema?: string;
  version: string;
  description?: string;
  sources: Record<string, EventIntakeSourcePolicy>;
}

/** Fail closed: a missing or invalid policy enables nothing. */
const CLOSED_POLICY: EventIntakePolicy = { version: '0', sources: {} };

const eventIntakePolicyCatalog = defineCatalog<EventIntakePolicy>({
  id: 'event-intake-policy',
  path: () => pathResolver.rootResolve(EVENT_INTAKE_POLICY_PATH),
  schema: pathResolver.rootResolve(EVENT_INTAKE_POLICY_SCHEMA_PATH),
  fallback: CLOSED_POLICY,
  fallbackOnInvalid: true,
  onFallback: (error) =>
    logger.warn(
      `event intake policy unavailable — every source stays disabled | fix ${EVENT_INTAKE_POLICY_PATH} | ${error instanceof Error ? error.message : String(error)}`
    ),
});

/**
 * Host opt-in: KYBERION_EVENT_INTAKE_SOURCES lists source ids (comma-separated)
 * this host accepts in addition to the policy's `enabled` flags, so enabling a
 * source on one machine is an env change, not an edit to the shared governed
 * policy. Only sources the policy declares can be enabled; unknown ids are
 * ignored with a warning. The HMAC secret is still required per request.
 */
export function applyEventIntakeHostOptIn(
  policy: EventIntakePolicy,
  optIn = getRegisteredEnvText('KYBERION_EVENT_INTAKE_SOURCES')
): EventIntakePolicy {
  const ids = (optIn ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) return policy;
  const sources = { ...policy.sources };
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(sources, id)) {
      logger.warn(
        `event intake host opt-in ignored — source '${id}' is not declared in ${EVENT_INTAKE_POLICY_PATH} | next: declare it in the policy or fix KYBERION_EVENT_INTAKE_SOURCES`
      );
      continue;
    }
    sources[id] = { ...sources[id], enabled: true };
  }
  return { ...policy, sources };
}

/** Load the governed intake policy; `path` overrides the location (tests). */
export function loadEventIntakePolicy(
  options: { path?: string; hostOptIn?: string } = {}
): EventIntakePolicy {
  const optIn = options.hostOptIn ?? getRegisteredEnvText('KYBERION_EVENT_INTAKE_SOURCES');
  if (!options.path) return applyEventIntakeHostOptIn(eventIntakePolicyCatalog.load(), optIn);
  try {
    return applyEventIntakeHostOptIn(
      eventIntakePolicyCatalog.validate(readJson<unknown>(options.path), options.path),
      optIn
    );
  } catch (error) {
    logger.warn(
      `event intake policy unavailable — every source stays disabled | fix ${options.path} | ${error instanceof Error ? error.message : String(error)}`
    );
    return structuredClone(CLOSED_POLICY);
  }
}

export function _resetEventIntakePolicyCacheForTests(): void {
  eventIntakePolicyCatalog.reset();
}

// ---------------------------------------------------------------------------
// signature
// ---------------------------------------------------------------------------

/**
 * Constant-time HMAC-SHA256 check of `signature` (`<prefix><hex>`) over the
 * raw body. Missing/short secret, missing header, wrong prefix or a non-hex
 * digest are all plain `false` — never an exception the caller could leak.
 */
export function verifyInboundSignature(input: {
  body: Buffer | string;
  signature: string | undefined;
  secret: string | null | undefined;
  prefix?: string;
}): boolean {
  const { secret, signature } = input;
  if (typeof secret !== 'string' || secret.length < EVENT_INTAKE_MIN_SECRET_LENGTH) return false;
  if (typeof signature !== 'string') return false;
  const prefix = input.prefix ?? '';
  if (!signature.startsWith(prefix)) return false;
  const provided = signature.slice(prefix.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(input.body).digest('hex');
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Shared-secret lookup for one source; the value never leaves this module's callers. */
export function resolveEventIntakeSecret(
  source: EventIntakeSourcePolicy,
  getSecret: (key: string) => string | null = (key) =>
    secretGuardGetSecret(key, undefined, 'event_intake.verify')
): string | null {
  try {
    return getSecret(source.secret_key);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

export type EventIntakeErrorCode =
  'unknown_source' | 'disabled_source' | 'bad_signature' | 'too_large' | 'invalid_payload';

export class EventIntakeError extends Error {
  constructor(
    readonly code: EventIntakeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EventIntakeError';
  }
}

export type InboundHeaders = Record<string, string | string[] | undefined>;

function headerValue(headers: InboundHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** Bounded, printable header token; anything else collapses to `fallback`. */
function cleanToken(value: string | undefined, fallback: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._:/@#-]/g, '_')
    .slice(0, HEADER_VALUE_MAX);
  return cleaned || fallback;
}

function readPath(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** `$.a.b[0].c` / `a.b.0.c` → segments. Prototype keys never resolve (own-property walk). */
export function parseEventJsonPath(jsonPath: string): string[] {
  return jsonPath
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[['"]([^'"\]]+)['"]\]/g, '.$1')
    .split('.')
    .filter(Boolean);
}

const SUMMARY_FIELDS: readonly string[][] = [
  ['action'],
  ['repository', 'full_name'],
  ['pull_request', 'title'],
  ['issue', 'title'],
  ['workflow_run', 'name'],
  ['workflow_run', 'conclusion'],
  ['status'],
  ['conclusion'],
  ['subject'],
  ['title'],
];

function buildEventSummary(source: string, type: string, payload: unknown): string {
  const parts = [`${source}/${type}`];
  for (const segments of SUMMARY_FIELDS) {
    const value = readPath(payload, segments);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${segments.join('.')}=${String(value).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  return parts.join(' ').slice(0, EVENT_SUMMARY_MAX);
}

export function dotEventId(source: string, deliveryId: string): string {
  return `evt_${createHash('sha256').update(`${source}\n${deliveryId}`).digest('hex').slice(0, 24)}`;
}

/**
 * Raw request → stored event. `tenant_slug` comes only from the policy; the
 * body must be JSON and at most the source's `max_body_bytes`.
 */
export function normalizeInboundEvent(input: {
  source: string;
  policy: EventIntakePolicy;
  headers: InboundHeaders;
  body: Buffer | string;
  now?: Date;
}): DotInboundEvent {
  const sourcePolicy = Object.prototype.hasOwnProperty.call(input.policy.sources, input.source)
    ? input.policy.sources[input.source]
    : undefined;
  if (!sourcePolicy) throw new EventIntakeError('unknown_source', 'undeclared event source');
  const raw = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');
  if (raw.length > sourcePolicy.max_body_bytes) {
    throw new EventIntakeError('too_large', 'event body exceeds the source limit');
  }
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw.toString('utf8'), `event ${input.source}`);
  } catch {
    throw new EventIntakeError('invalid_payload', 'event body is not valid JSON');
  }
  const digestHex = createHash('sha256').update(raw).digest('hex');
  const type = cleanToken(headerValue(input.headers, sourcePolicy.event_type_header), 'event');
  const deliveryId = cleanToken(
    headerValue(input.headers, sourcePolicy.delivery_id_header),
    `digest:${digestHex.slice(0, 32)}`
  );
  const serialized = JSON.stringify(parsed) ?? 'null';
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  const payload =
    payloadBytes <= DOT_EVENT_PAYLOAD_MAX_BYTES ? parsed : { truncated: true, bytes: payloadBytes };
  return {
    event_id: dotEventId(input.source, deliveryId),
    source: input.source,
    type,
    delivery_id: deliveryId,
    ...(sourcePolicy.tenant_slug ? { tenant_slug: sourcePolicy.tenant_slug } : {}),
    received_at: (input.now ?? new Date()).toISOString(),
    summary: buildEventSummary(input.source, type, parsed),
    payload_digest: `sha256:${digestHex}`,
    payload,
  };
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

/** Repo-relative events ledger for a tenant (or the system floor). */
export function dotEventsLedgerPath(tenantSlug?: string): string {
  if (!tenantSlug) return `${DOT_STATE_ROOT}/${DOT_EVENTS_FILE}`;
  return physicalScopedPath(DOT_STATE_ROOT, { tenant_slug: tenantSlug }, DOT_EVENTS_FILE);
}

export interface DotEventDeps {
  rootDir?: string;
  /** Payload-digest replay window; defaults to {@link DOT_EVENT_REPLAY_WINDOW_MS}, 0 disables. */
  replayWindowMs?: number;
}

/** The source's configured payload replay window in ms (default 24 h, 0 = disabled). */
export function sourceReplayWindowMs(sourcePolicy: EventIntakeSourcePolicy): number {
  const hours = sourcePolicy.replay_window_hours;
  return typeof hours === 'number' && Number.isFinite(hours) && hours >= 0
    ? hours * 60 * 60 * 1000
    : DOT_EVENT_REPLAY_WINDOW_MS;
}

function absolute(rel: string, deps: DotEventDeps): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), rel);
}

/**
 * Bounded JSONL tail: at most {@link DOT_EVENT_SCAN_TAIL_BYTES} from the end of
 * the ledger. When the window was cut, its first line is a fragment and is
 * dropped; malformed lines are skipped.
 */
function readLedgerTail(filePath: string): unknown[] {
  if (!safeExistsSync(filePath)) return [];
  const { buffer, truncated } = safeReadFileTail(filePath, DOT_EVENT_SCAN_TAIL_BYTES);
  const lines = buffer.toString('utf8').split(/\r?\n/);
  if (truncated) lines.shift();
  const rows: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(parseSafeJsonInput(line, 'dot events ledger tail entry'));
    } catch {
      /* a torn or malformed line must not hide the rest of the tail */
    }
  }
  return rows;
}

/** Ledger tail for one tenant (or the system floor); a bounded read. */
export function readDotInboundEvents(tenantSlug: string | undefined, deps: DotEventDeps = {}) {
  const rows = (
    readLedgerTail(absolute(dotEventsLedgerPath(tenantSlug), deps)) as DotInboundEvent[]
  ).filter(
    (row) =>
      typeof row?.event_id === 'string' &&
      typeof row?.source === 'string' &&
      typeof row?.received_at === 'string'
  );
  return rows.slice(-DOT_EVENT_SCAN_TAIL);
}

export interface IngestInboundEventResult {
  status: 'accepted' | 'duplicate';
  event_id: string;
  /** Repo-relative ledger path. */
  ledger: string;
}

/**
 * True when `row` replays `event`: same source and payload digest, within the
 * source's replay window (default 24 h; 0 disables). Type and delivery headers
 * are unsigned; changing either cannot bypass dedup.
 */
function isPayloadReplay(row: DotInboundEvent, event: DotInboundEvent, windowMs: number): boolean {
  if (windowMs <= 0) return false;
  if (row.source !== event.source) return false;
  if (!row.payload_digest || row.payload_digest !== event.payload_digest) return false;
  const gap = Math.abs(Date.parse(event.received_at) - Date.parse(row.received_at));
  return Number.isFinite(gap) && gap < windowMs;
}

/**
 * Append once: a repeated (source, delivery_id) — or a replay of the same
 * payload under a fresh delivery id within the replay window — is reported as duplicate,
 * not re-written.
 */
export function ingestInboundEvent(
  event: DotInboundEvent,
  deps: DotEventDeps = {}
): IngestInboundEventResult {
  const ledger = dotEventsLedgerPath(event.tenant_slug);
  const filePath = absolute(ledger, deps);
  const lockId = `dot-event-intake-${createHash('sha256').update(filePath).digest('hex').slice(0, 24)}`;
  return withLockSync(lockId, () => {
    const duplicate = readDotInboundEvents(event.tenant_slug, deps).some(
      (row) =>
        (row.source === event.source && row.delivery_id === event.delivery_id) ||
        isPayloadReplay(row, event, deps.replayWindowMs ?? DOT_EVENT_REPLAY_WINDOW_MS)
    );
    if (duplicate) return { status: 'duplicate', event_id: event.event_id, ledger };
    safeMkdir(path.dirname(filePath), { recursive: true });
    appendJsonLine(filePath, event);
    return { status: 'accepted', event_id: event.event_id, ledger };
  });
}

export interface InboundEventRequest {
  source: string;
  headers: InboundHeaders;
  body: Buffer | string;
  policy?: EventIntakePolicy;
  /** Secret lookup seam; defaults to secret-guard. */
  getSecret?: (key: string) => string | null;
  rootDir?: string;
  now?: Date;
}

export type InboundEventResponse =
  | { status: 202; result: IngestInboundEventResult }
  | { status: 400 | 401 | 413; code: EventIntakeErrorCode };

/**
 * Full authenticated intake for one request body. Unknown and disabled
 * sources answer exactly like a bad signature (401) so the response never
 * reveals which sources are configured.
 */
export function processInboundEventRequest(request: InboundEventRequest): InboundEventResponse {
  const policy = request.policy ?? loadEventIntakePolicy();
  const sourcePolicy = Object.prototype.hasOwnProperty.call(policy.sources, request.source)
    ? policy.sources[request.source]
    : undefined;
  if (!sourcePolicy) return { status: 401, code: 'unknown_source' };
  if (!sourcePolicy.enabled) return { status: 401, code: 'disabled_source' };
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, 'utf8');
  if (raw.length > sourcePolicy.max_body_bytes) return { status: 413, code: 'too_large' };
  const verified = verifyInboundSignature({
    body: raw,
    signature: headerValue(request.headers, sourcePolicy.signature_header),
    secret: resolveEventIntakeSecret(sourcePolicy, request.getSecret),
    prefix: sourcePolicy.prefix,
  });
  if (!verified) return { status: 401, code: 'bad_signature' };
  try {
    const event = normalizeInboundEvent({
      source: request.source,
      policy,
      headers: request.headers,
      body: raw,
      now: request.now,
    });
    return {
      status: 202,
      result: ingestInboundEvent(event, {
        rootDir: request.rootDir,
        replayWindowMs: sourceReplayWindowMs(sourcePolicy),
      }),
    };
  } catch (error) {
    if (error instanceof EventIntakeError) {
      return { status: error.code === 'too_large' ? 413 : 400, code: error.code };
    }
    throw error;
  }
}

/**
 * Local-testing path (operator CLI, no HMAC): the source must be declared in
 * the policy but may be disabled; tenant binding still comes from the policy.
 */
export function ingestLocalEvent(input: {
  source: string;
  body: string | Buffer | Record<string, unknown> | unknown[];
  type?: string;
  deliveryId?: string;
  policy?: EventIntakePolicy;
  rootDir?: string;
  now?: Date;
}): IngestInboundEventResult & { event: DotInboundEvent } {
  const policy = input.policy ?? loadEventIntakePolicy();
  const sourcePolicy = Object.prototype.hasOwnProperty.call(policy.sources, input.source)
    ? policy.sources[input.source]
    : undefined;
  if (!sourcePolicy) throw new EventIntakeError('unknown_source', 'undeclared event source');
  const body =
    typeof input.body === 'string' || Buffer.isBuffer(input.body)
      ? input.body
      : JSON.stringify(input.body);
  const event = normalizeInboundEvent({
    source: input.source,
    policy,
    headers: {
      [sourcePolicy.event_type_header]: input.type ?? 'local',
      [sourcePolicy.delivery_id_header]: input.deliveryId ?? `local-${randomUUID()}`,
    },
    body,
    now: input.now,
  });
  return {
    ...ingestInboundEvent(event, {
      rootDir: input.rootDir,
      replayWindowMs: sourceReplayWindowMs(sourcePolicy),
    }),
    event,
  };
}

// ---------------------------------------------------------------------------
// trigger evaluation
// ---------------------------------------------------------------------------

type EventTrigger = Extract<DotTrigger, { kind: 'event' }>;

export function dotEventMatchesTrigger(event: DotInboundEvent, trigger: EventTrigger): boolean {
  if (!trigger.sources.includes(event.source)) return false;
  if (trigger.types && trigger.types.length > 0 && !trigger.types.includes(event.type)) {
    return false;
  }
  if (!trigger.match) return true;
  const value = readPath(event.payload, parseEventJsonPath(trigger.match.json_path));
  if (value === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(trigger.match, 'equals')) {
    if (!isDeepStrictEqual(value, trigger.match.equals)) return false;
  }
  if (Array.isArray(trigger.match.in)) {
    if (!trigger.match.in.some((candidate) => isDeepStrictEqual(value, candidate))) return false;
  }
  return true;
}

/**
 * Event wakes due for THIS dot. Reads only the ledger of the dot's own
 * tenant (system floor for untenanted dots). An event is offered when it
 * matches a declared `event` trigger, its key `event:<event_id>` is due per
 * {@link buildDotDueChecker} (delivered/rejected consume; failed backs off),
 * and it is newer than the newest event this dot already handled — or, for
 * a dot that handled none yet, within {@link DOT_EVENT_LOOKBACK_MS}. Failed
 * keys stay eligible (retry with backoff) even behind the watermark.
 */
export function evaluateDotEventTriggers(
  charter: DotCharter,
  deps: DotRuntimeDeps = {}
): DueDotTrigger[] {
  const triggers = charter.attention.triggers.filter(
    (trigger): trigger is EventTrigger => trigger.kind === 'event'
  );
  if (triggers.length === 0) return [];
  const tenantSlug = charter.scope.tenant_slug || undefined;
  const events = readDotInboundEvents(tenantSlug, deps).filter(
    (event) => (event.tenant_slug || undefined) === tenantSlug
  );
  if (events.length === 0) return [];
  const now = deps.now?.() ?? new Date();
  const isDue = buildDotDueChecker(charter, now, deps);

  const handled = new Set<string>();
  const failed = new Set<string>();
  for (const row of readDotWakeLedger(deps)) {
    if (row.dot_id !== charter.dot_id || !row.trigger_key.startsWith('event:')) continue;
    if (row.outcome === 'delivered' || row.outcome === 'rejected') handled.add(row.trigger_key);
    else if (row.outcome === 'failed') failed.add(row.trigger_key);
  }
  let watermark = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!handled.has(`event:${event.event_id}`)) continue;
    const at = Date.parse(event.received_at);
    if (Number.isFinite(at)) watermark = Math.max(watermark, at);
  }
  const floor = Number.isFinite(watermark) ? watermark : now.getTime() - DOT_EVENT_LOOKBACK_MS;

  const due: DueDotTrigger[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (due.length >= DOT_EVENT_MAX_DUE_PER_SWEEP) break;
    const key = `event:${event.event_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = Date.parse(event.received_at);
    if (!Number.isFinite(at) || at > now.getTime()) continue;
    if (at < floor && !failed.has(key)) continue;
    const trigger = triggers.find((candidate) => dotEventMatchesTrigger(event, candidate));
    if (!trigger || !isDue(key)) continue;
    due.push({
      trigger,
      key,
      detail:
        `event ${event.source}/${event.type} delivery ${event.delivery_id} received ${event.received_at} (untrusted external input): ${event.summary}`.slice(
          0,
          EVENT_DETAIL_MAX
        ),
    });
  }
  return due;
}
