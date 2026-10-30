/**
 * Browser bridge pull mailbox (Kyberion -> Chrome extension).
 *
 * Kyberion never pushes into the browser. A caller (CLI, mission worker)
 * enqueues a `browser-bridge-request.v1`; the extension polls the native
 * messaging host (`poll_requests`), asks the user, and answers through
 * `respond_request`. This module is the only writer of the mailbox store.
 *
 * Storage: `active/shared/runtime/browser-bridge-mailbox/<tier>/<tenant|shared>/<request_id>.json`
 * — a registered tier/tenant-partitioned runtime state root
 * (`PARTITIONED_RUNTIME_STATE_ROOTS.browser_bridge_mailbox`), so tier-guard
 * maps each record path onto the `knowledge/<tier>/<tenant>/` rules for the
 * calling identity and tenant requests never land in `system/`. That
 * partitioning is *placement*, not viewer isolation.
 *
 * Single-operator channel: the native host is a local, single-operator
 * channel. It runs under the sovereign concierge role and `poll_requests`
 * returns the deliverable requests of *every* partition (all tiers, all
 * tenants) to the one operator's allowlisted Chrome extension. There is no
 * per-viewer filtering on that path — do not expose the poll surface to a
 * second principal or a shared browser profile. Because the operator's
 * currently open tab may belong to any tenant, a tenant-scoped `observe_tab`
 * (any tier with `scope.tenant_slug` — a `<tier>/<tenant>` partition, as in
 * the storage layout) must name non-empty `allowed_origins`; the response is
 * then rejected unless the observed origin is one of them.
 *
 * Invariants:
 *   - A request never carries an executable instruction. `observe_tab` asks for
 *     per-request user consent in the extension; `local_infer` results must
 *     declare `executable: false`; `notify` is display-only and never carries
 *     page data.
 *   - Responses are re-validated and re-redacted here (observation schema +
 *     `redactObservationText`), capped at 64 KiB, and only accepted while the
 *     request is pending/delivered and unexpired.
 *   - Approvals are exposed as a read-only summary; nothing here decides one.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { Buffer } from 'node:buffer';
import { compileSchema } from '../foundation/ajv.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  isApprovalRequestExpired,
  listApprovalRequests,
} from '../governance/approval-store-reader.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  STORAGE_DATA_TIERS,
  UNTENANTED_PARTITION_SEGMENT,
  storagePartitionSegments,
  type StorageDataTier,
} from '../storage-layout.js';
import {
  redactObservationText,
  validateBrowserExtensionObservation,
} from './browser-extension-bridge.js';

export const BROWSER_BRIDGE_REQUEST_KIND = 'browser-bridge-request.v1';
export const BROWSER_BRIDGE_MAILBOX_ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.browser_bridge_mailbox;
/** Default request lifetime when the caller names none. */
export const BROWSER_BRIDGE_DEFAULT_TTL_MS = 10 * 60_000;
/** Longest lifetime a caller may ask for. */
export const BROWSER_BRIDGE_MAX_TTL_MS = 60 * 60_000;
/** Cap on a serialized respond_request body. */
export const BROWSER_BRIDGE_MAX_RESPONSE_BYTES = 64 * 1024;
/** `procedure_id` an observe_tab observation must carry (binds it to the mailbox). */
export const BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID = 'browser-bridge-observe';
export const BROWSER_BRIDGE_MAX_WEBMCP_TOOLS = 50;
const MAX_APPROVAL_SUMMARIES = 20;

const REQUEST_ID_PATTERN = /^BBR-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/browser-bridge-request.schema.json');
const TENANT_OBSERVE_ORIGINS_ERROR =
  'a tenant-scoped (scope.tenant_slug) observe_tab request requires non-empty payload.allowed_origins';
/** Schema maxLength of the free-text payload fields redaction may lengthen. */
const PAYLOAD_TEXT_LIMITS = { purpose: 300, input: 30000, title: 120, body: 1000 } as const;

export type BrowserBridgeRequestKind = 'observe_tab' | 'local_infer' | 'notify';
export type BrowserBridgeRequestStatus =
  'pending' | 'delivered' | 'completed' | 'declined' | 'failed' | 'expired';
export type BrowserBridgeResponseStatus = 'completed' | 'declined' | 'failed';
export type BrowserBridgeLocalTask =
  | 'summarize'
  | 'classify'
  | 'extract'
  | 'translate'
  | 'detect_language'
  | 'proofread'
  | 'rewrite'
  | 'write';

export interface BrowserBridgeObservePayload {
  purpose: string;
  allowed_origins?: string[];
  mode: 'text' | 'structure';
}

export interface BrowserBridgeLocalInferPayload {
  task: BrowserBridgeLocalTask;
  input: string;
  options?: Record<string, unknown>;
}

export interface BrowserBridgeNotifyPayload {
  level: 'info' | 'progress' | 'approval_pending';
  title: string;
  body: string;
  approval_request_id?: string;
  mission_id?: string;
  progress?: { done: number; total: number };
}

export type BrowserBridgePayload =
  BrowserBridgeObservePayload | BrowserBridgeLocalInferPayload | BrowserBridgeNotifyPayload;

export interface BrowserBridgeScope {
  tier: StorageDataTier;
  tenant_slug?: string;
}

export interface BrowserBridgeResponseRecord {
  status: BrowserBridgeResponseStatus | 'expired';
  result?: Record<string, unknown>;
  error?: string;
  responded_at: string;
  origin?: string;
}

export interface BrowserBridgeRequest {
  kind: typeof BROWSER_BRIDGE_REQUEST_KIND;
  request_id: string;
  request_kind: BrowserBridgeRequestKind;
  created_at: string;
  expires_at: string;
  requested_by: { actor_id: string; mission_id?: string };
  scope: BrowserBridgeScope;
  payload: BrowserBridgePayload;
  status: BrowserBridgeRequestStatus;
  delivered_at?: string;
  response?: BrowserBridgeResponseRecord;
}

/** What the extension receives from poll_requests — no response, no internals. */
export interface BrowserBridgeRequestView {
  request_id: string;
  request_kind: BrowserBridgeRequestKind;
  created_at: string;
  expires_at: string;
  requested_by: { actor_id: string; mission_id?: string };
  scope: BrowserBridgeScope;
  payload: BrowserBridgePayload;
  status: 'pending' | 'delivered';
}

export interface BrowserBridgeApprovalSummary {
  request_id: string;
  title: string;
  risk: string;
  requested_at: string;
  expires_at?: string;
  /** The only way to decide: an authenticated human on the approval path. */
  approve_command: string;
}

export interface EnqueueBrowserBridgeRequestInput {
  request_kind: BrowserBridgeRequestKind;
  payload: BrowserBridgePayload;
  requested_by: { actor_id: string; mission_id?: string };
  scope: BrowserBridgeScope;
  /** Lifetime in ms; default 10 min, max 60 min. */
  ttl_ms?: number;
}

export interface BrowserBridgeRespondInput {
  status: BrowserBridgeResponseStatus;
  result?: unknown;
  error?: string;
  origin?: string;
}

export interface BrowserBridgeMailboxOptions {
  now?: Date;
  /** Tenant registry check for confidential scope; throws when the tenant is unusable. */
  assertTenant?: (tenantSlug: string) => void;
}

export type BrowserBridgeMailboxErrorCode =
  'invalid_input' | 'not_found' | 'expired' | 'terminal' | 'too_large' | 'invalid_response';

export class BrowserBridgeMailboxError extends Error {
  constructor(
    readonly code: BrowserBridgeMailboxErrorCode,
    message: string
  ) {
    super(`[BROWSER_BRIDGE_${code.toUpperCase()}] ${message}`);
    this.name = 'BrowserBridgeMailboxError';
  }
}

const TERMINAL_STATUSES: ReadonlySet<BrowserBridgeRequestStatus> = new Set([
  'completed',
  'declined',
  'failed',
  'expired',
]);

export function isTerminalBrowserBridgeStatus(status: BrowserBridgeRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

let requestValidator: ValidateFunction | null = null;

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function canonicalHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Schema + semantic validation of a stored or new request record. */
export function validateBrowserBridgeRequest(input: unknown): {
  valid: boolean;
  errors: string[];
  value?: BrowserBridgeRequest;
} {
  requestValidator ??= compileSchema(SCHEMA_PATH);
  if (!requestValidator(input)) return { valid: false, errors: formatErrors(requestValidator) };
  const value = input as BrowserBridgeRequest;
  const errors: string[] = [];
  if (value.scope.tenant_slug && !isValidTenantSlug(value.scope.tenant_slug)) {
    errors.push('scope.tenant_slug must be a tenant slug (reserved scope names are not tenants)');
  }
  const created = Date.parse(value.created_at);
  const expires = Date.parse(value.expires_at);
  if (!(expires > created) || expires - created > BROWSER_BRIDGE_MAX_TTL_MS) {
    errors.push('expires_at must be after created_at and at most 60 minutes later');
  }
  if (value.request_kind === 'observe_tab') {
    const origins = (value.payload as BrowserBridgeObservePayload).allowed_origins ?? [];
    if (origins.some((origin) => canonicalHttpOrigin(origin) !== origin)) {
      errors.push('payload.allowed_origins must be canonical http(s) origins');
    }
    if (value.scope.tenant_slug && origins.length === 0) {
      errors.push(TENANT_OBSERVE_ORIGINS_ERROR);
    }
  }
  if (value.request_kind === 'notify') {
    const payload = value.payload as BrowserBridgeNotifyPayload;
    if (payload.level === 'approval_pending' && !payload.approval_request_id) {
      errors.push('approval_pending notify requires payload.approval_request_id');
    }
    if (payload.progress && payload.progress.done > payload.progress.total) {
      errors.push('payload.progress.done must not exceed total');
    }
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [], value };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function partitionDir(scope: BrowserBridgeScope): string {
  return pathResolver.rootResolve(
    path.posix.join(
      BROWSER_BRIDGE_MAILBOX_ROOT,
      ...storagePartitionSegments({ kind: 'tier', tier: scope.tier, tenant: scope.tenant_slug })
    )
  );
}

function requestPath(scope: BrowserBridgeScope, requestId: string): string {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new BrowserBridgeMailboxError('invalid_input', `invalid request id: ${requestId}`);
  }
  return assertSafeRepositoryPath(path.join(partitionDir(scope), `${requestId}.json`), {
    allowMissingLeaf: true,
  });
}

function lockId(requestId: string): string {
  return `browser-bridge-mailbox-${requestId}`;
}

function writeRequest(record: BrowserBridgeRequest): void {
  const check = validateBrowserBridgeRequest(record);
  if (!check.valid) {
    throw new BrowserBridgeMailboxError(
      'invalid_input',
      `invalid request ${record.request_id}: ${check.errors.join('; ')}`
    );
  }
  const filePath = requestPath(record.scope, record.request_id);
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, record);
}

/** Read one stored record; null when missing, invalid or misplaced (fail closed). */
function readRequestAt(scope: BrowserBridgeScope, requestId: string): BrowserBridgeRequest | null {
  let raw: unknown;
  try {
    raw = readJsonIfPresent<unknown>(requestPath(scope, requestId));
  } catch {
    return null;
  }
  const check = validateBrowserBridgeRequest(raw);
  if (!check.valid || !check.value) return null;
  const record = check.value;
  if (
    record.request_id !== requestId ||
    record.scope.tier !== scope.tier ||
    (record.scope.tenant_slug ?? undefined) !== (scope.tenant_slug ?? undefined)
  ) {
    return null;
  }
  return record;
}

/** Unlocked, unvalidated peek: true only when the stored record says it is terminal. */
function hasTerminalStatusOnDisk(scope: BrowserBridgeScope, requestId: string): boolean {
  try {
    const raw = readJsonIfPresent<{ status?: unknown }>(requestPath(scope, requestId));
    return (
      typeof raw?.status === 'string' &&
      TERMINAL_STATUSES.has(raw.status as BrowserBridgeRequestStatus)
    );
  } catch {
    return false;
  }
}

/** Every partition (tier × tenant|shared) present on disk that this process may list. */
function mailboxPartitions(): BrowserBridgeScope[] {
  const scopes: BrowserBridgeScope[] = [];
  for (const tier of STORAGE_DATA_TIERS) {
    const tierDir = pathResolver.rootResolve(path.posix.join(BROWSER_BRIDGE_MAILBOX_ROOT, tier));
    let names: string[];
    try {
      if (!safeExistsSync(tierDir)) continue;
      names = safeReaddir(tierDir);
    } catch {
      continue; // a tier this identity may not read is skipped, not fatal
    }
    for (const name of names.sort()) {
      if (name === UNTENANTED_PARTITION_SEGMENT) scopes.push({ tier });
      else if (isValidTenantSlug(name)) scopes.push({ tier, tenant_slug: name });
    }
  }
  return scopes;
}

function requestIdsIn(scope: BrowserBridgeScope): string[] {
  try {
    const dir = partitionDir(scope);
    if (!safeExistsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => REQUEST_ID_PATTERN.test(id))
      .sort();
  } catch {
    return [];
  }
}

function findRequestScope(requestId: string): BrowserBridgeScope | null {
  for (const scope of mailboxPartitions()) {
    if (requestIdsIn(scope).includes(requestId)) return scope;
  }
  return null;
}

function isExpiredAt(record: BrowserBridgeRequest, now: Date): boolean {
  return Date.parse(record.expires_at) <= now.getTime();
}

function expireRecord(record: BrowserBridgeRequest, now: Date): BrowserBridgeRequest {
  const expired: BrowserBridgeRequest = {
    ...record,
    status: 'expired',
    response: { status: 'expired', responded_at: now.toISOString() },
  };
  writeRequest(expired);
  return expired;
}

/**
 * Re-read under the per-request lock and expire a non-terminal record whose
 * lifetime has passed. Returns the current record (or null when gone).
 */
function settleExpiry(scope: BrowserBridgeScope, requestId: string, now: Date) {
  return withLockSync(lockId(requestId), () => {
    const current = readRequestAt(scope, requestId);
    if (!current) return null;
    if (!isTerminalBrowserBridgeStatus(current.status) && isExpiredAt(current, now)) {
      return expireRecord(current, now);
    }
    return current;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function defaultAssertTenant(tenantSlug: string): void {
  resolveTenant(tenantSlug);
}

/**
 * Validate a tier/tenant scope: confidential needs a tenant, a tenant must be
 * a slug (never a reserved scope name) registered in the tenant registry.
 * Shared by the mailbox and the native host's send_page.
 */
export function normalizeBrowserBridgeScope(
  scope: BrowserBridgeScope,
  options: BrowserBridgeMailboxOptions = {}
): BrowserBridgeScope {
  if (!scope || !STORAGE_DATA_TIERS.includes(scope.tier)) {
    throw new BrowserBridgeMailboxError(
      'invalid_input',
      'scope.tier must be personal|confidential|public'
    );
  }
  const tenant = scope.tenant_slug?.trim().toLowerCase();
  if (tenant !== undefined && tenant !== '' && !isValidTenantSlug(tenant)) {
    throw new BrowserBridgeMailboxError(
      'invalid_input',
      `scope.tenant_slug '${scope.tenant_slug}' is not a tenant slug (reserved scope names are not tenants)`
    );
  }
  if (scope.tier === 'confidential' && !tenant) {
    throw new BrowserBridgeMailboxError('invalid_input', 'confidential scope requires tenant_slug');
  }
  if (tenant) {
    try {
      (options.assertTenant ?? defaultAssertTenant)(tenant);
    } catch {
      // The registry's own message names repository paths; keep it off the wire.
      throw new BrowserBridgeMailboxError(
        'invalid_input',
        `tenant '${tenant}' is not a registered, operational tenant`
      );
    }
  }
  return tenant ? { tier: scope.tier, tenant_slug: tenant } : { tier: scope.tier };
}

/**
 * Redact, then clamp to the schema maxLength: a redaction token
 * (`[redacted-email]`) can be longer than what it replaces, and an input that
 * was valid as given must not fail because of redaction. Never ends on a
 * lone high surrogate.
 */
function redactAndClamp(value: string, max: number): string {
  const redacted = redactObservationText(value);
  if (redacted.length <= max) return redacted;
  const clipped = redacted.slice(0, max);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

/**
 * Redact the free-text fields of an already schema-validated payload (lengths
 * were checked on the raw input) and clamp them back under maxLength.
 */
function redactPayload(
  kind: BrowserBridgeRequestKind,
  payload: BrowserBridgePayload
): BrowserBridgePayload {
  if (kind === 'local_infer') {
    const local = payload as BrowserBridgeLocalInferPayload;
    // The caller already governs the input; redact again so no PII shape
    // leaves Kyberion through the mailbox even if the caller forgot.
    return { ...local, input: redactAndClamp(local.input, PAYLOAD_TEXT_LIMITS.input) };
  }
  if (kind === 'observe_tab') {
    const observe = payload as BrowserBridgeObservePayload;
    return { ...observe, purpose: redactAndClamp(observe.purpose, PAYLOAD_TEXT_LIMITS.purpose) };
  }
  // notify: only the declared display fields survive (schema rejects extras);
  // it never carries page data, so redact its free text as well.
  const notify = payload as BrowserBridgeNotifyPayload;
  return {
    ...notify,
    title: redactAndClamp(notify.title, PAYLOAD_TEXT_LIMITS.title),
    body: redactAndClamp(notify.body, PAYLOAD_TEXT_LIMITS.body),
  };
}

/** Validate and store a new request; returns the stored record (status `pending`). */
export function enqueueBrowserBridgeRequest(
  input: EnqueueBrowserBridgeRequestInput,
  options: BrowserBridgeMailboxOptions = {}
): BrowserBridgeRequest {
  const now = options.now ?? new Date();
  const ttl = input.ttl_ms ?? BROWSER_BRIDGE_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > BROWSER_BRIDGE_MAX_TTL_MS) {
    throw new BrowserBridgeMailboxError('invalid_input', 'ttl must be > 0 and at most 60 minutes');
  }
  const scope = normalizeBrowserBridgeScope(input.scope, options);
  if (!input.payload || typeof input.payload !== 'object') {
    throw new BrowserBridgeMailboxError('invalid_input', 'payload must be an object');
  }
  if (
    input.request_kind === 'observe_tab' &&
    scope.tenant_slug &&
    !((input.payload as BrowserBridgeObservePayload).allowed_origins?.length ?? 0)
  ) {
    throw new BrowserBridgeMailboxError('invalid_input', TENANT_OBSERVE_ORIGINS_ERROR);
  }
  const raw: BrowserBridgeRequest = {
    kind: BROWSER_BRIDGE_REQUEST_KIND,
    request_id: `BBR-${randomUUID()}`,
    request_kind: input.request_kind,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    requested_by: {
      actor_id: String(input.requested_by?.actor_id ?? '').trim(),
      ...(input.requested_by?.mission_id ? { mission_id: input.requested_by.mission_id } : {}),
    },
    scope,
    payload: input.payload,
    status: 'pending',
  };
  // Validate the caller's input as given (lengths included), then redact;
  // writeRequest re-validates the redacted, clamped record.
  const check = validateBrowserBridgeRequest(raw);
  if (!check.valid) throw new BrowserBridgeMailboxError('invalid_input', check.errors.join('; '));
  const record: BrowserBridgeRequest = {
    ...raw,
    payload: redactPayload(raw.request_kind, raw.payload),
  };
  writeRequest(record);
  try {
    auditChain.record({
      agentId: record.requested_by.actor_id,
      action: 'browser_bridge_request',
      operation: `browser:bridge:enqueue:${record.request_kind}`,
      result: 'completed',
      reason: `Queued ${record.request_kind} request for the Chrome extension`,
      metadata: {
        request_id: record.request_id,
        request_kind: record.request_kind,
        tier: scope.tier,
        ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
        ...(record.requested_by.mission_id ? { mission_id: record.requested_by.mission_id } : {}),
        expires_at: record.expires_at,
      },
    });
  } catch {
    /* audit enrichment is best-effort */
  }
  return record;
}

/** Load a request by id from any partition this process may read; expiry is settled first. */
export function loadBrowserBridgeRequest(
  requestId: string,
  options: { now?: Date } = {}
): BrowserBridgeRequest | null {
  if (!REQUEST_ID_PATTERN.test(requestId)) return null;
  const scope = findRequestScope(requestId);
  if (!scope) return null;
  return settleExpiry(scope, requestId, options.now ?? new Date());
}

/**
 * Requests the extension may show: pending or delivered and unexpired, oldest
 * first. Marks pending → delivered and sweeps lapsed requests to `expired`.
 */
export function listDeliverableBrowserBridgeRequests(
  options: { now?: Date } = {}
): BrowserBridgeRequest[] {
  const now = options.now ?? new Date();
  const out: BrowserBridgeRequest[] = [];
  for (const scope of mailboxPartitions()) {
    for (const id of requestIdsIn(scope)) {
      // Terminal is final (nothing moves a record out of it), so an unlocked
      // status peek is enough to skip it — no lock, no schema validation.
      // Anything else (or an unreadable file) takes the locked path below.
      if (hasTerminalStatusOnDisk(scope, id)) continue;
      let record: BrowserBridgeRequest | null;
      try {
        record = withLockSync(lockId(id), () => {
          const current = readRequestAt(scope, id);
          if (!current || isTerminalBrowserBridgeStatus(current.status)) return null;
          if (isExpiredAt(current, now)) {
            expireRecord(current, now);
            return null;
          }
          if (current.status === 'pending') {
            const delivered: BrowserBridgeRequest = {
              ...current,
              status: 'delivered',
              delivered_at: now.toISOString(),
            };
            writeRequest(delivered);
            return delivered;
          }
          return current;
        });
      } catch {
        continue; // one unreadable/locked record must not blind the whole poll
      }
      if (record) out.push(record);
    }
  }
  return out.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.request_id.localeCompare(b.request_id)
  );
}

/** Extension-facing view (drops the response and delivery bookkeeping). */
export function toBrowserBridgeRequestView(record: BrowserBridgeRequest): BrowserBridgeRequestView {
  return {
    request_id: record.request_id,
    request_kind: record.request_kind,
    created_at: record.created_at,
    expires_at: record.expires_at,
    requested_by: { ...record.requested_by },
    scope: { ...record.scope },
    payload: record.payload,
    status: record.status === 'pending' ? 'pending' : 'delivered',
  };
}

/**
 * Redact every string — object keys included (an extraction keyed by an
 * email is still an email) — and clip below depth 8. Keys that collide after
 * redaction keep the first entry's key; later ones get ` (2)`, ` (3)`, … in
 * input order, so the output is deterministic and nothing is dropped.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return redactObservationText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const base = redactObservationText(key);
      let unique = base;
      for (let n = 2; used.has(unique); n += 1) unique = `${base} (${n})`;
      used.add(unique);
      Object.defineProperty(out, unique, {
        value: redactDeep(item, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? redactObservationText(trimmed).slice(0, max) : undefined;
}

function normalizeWebMcpTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > BROWSER_BRIDGE_MAX_WEBMCP_TOOLS) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      `webmcp_tools must be an array of at most ${BROWSER_BRIDGE_MAX_WEBMCP_TOOLS} tools`
    );
  }
  return value.map((tool) => {
    const name = cleanString((tool as Record<string, unknown>)?.name, 120);
    if (!name) throw new BrowserBridgeMailboxError('invalid_response', 'webmcp tool needs a name');
    const description = cleanString((tool as Record<string, unknown>).description, 500);
    const keys = (tool as Record<string, unknown>).input_keys;
    const inputKeys = Array.isArray(keys)
      ? keys
          .slice(0, 32)
          .map((key) => cleanString(key, 80))
          .filter((key): key is string => Boolean(key))
      : [];
    // Names, descriptions and schema keys only — tools are never invoked.
    return { name, ...(description ? { description } : {}), input_keys: inputKeys };
  });
}

function normalizeObserveResult(
  record: BrowserBridgeRequest,
  result: Record<string, unknown>,
  origin: string | undefined
): { result: Record<string, unknown>; origin: string } {
  const validation = validateBrowserExtensionObservation(result.observation);
  if (!validation.value) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      `observation invalid: ${validation.errors.join('; ')}`
    );
  }
  const observation = validation.value;
  if (
    observation.procedure_id !== BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID ||
    observation.recording_id !== record.request_id ||
    observation.lease_id !== `LEASE-${record.request_id}`
  ) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      `observation must be bound to the request (procedure_id=${BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID}, recording_id=<request_id>, lease_id=LEASE-<request_id>)`
    );
  }
  const allowed = (record.payload as BrowserBridgeObservePayload).allowed_origins ?? [];
  if (allowed.length > 0 && !allowed.includes(observation.origin)) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      `observation origin ${observation.origin} is not in allowed_origins`
    );
  }
  if (origin !== undefined && origin !== observation.origin) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      'origin does not match observation.origin'
    );
  }
  const webmcpTools = normalizeWebMcpTools(result.webmcp_tools);
  return {
    origin: observation.origin,
    result: {
      observation: {
        ...observation,
        fields: observation.fields.map((field) => ({
          ...field,
          name: redactObservationText(field.name),
          text: redactObservationText(field.text),
        })),
      },
      ...(webmcpTools ? { webmcp_tools: webmcpTools } : {}),
    },
  };
}

function normalizeLocalInferResult(
  record: BrowserBridgeRequest,
  result: Record<string, unknown>
): Record<string, unknown> {
  if (result.executable !== false) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      'local_infer result must declare executable: false'
    );
  }
  const task = (record.payload as BrowserBridgeLocalInferPayload).task;
  if (result.task !== task) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      `local_infer result task must be '${task}'`
    );
  }
  const provider = cleanString(result.provider, 80);
  if (!provider)
    throw new BrowserBridgeMailboxError('invalid_response', 'local_infer result needs a provider');
  const output = result.output;
  if (
    typeof output !== 'string' &&
    (output === null || typeof output !== 'object' || Array.isArray(output))
  ) {
    throw new BrowserBridgeMailboxError(
      'invalid_response',
      'local_infer output must be a string or object'
    );
  }
  return {
    provider,
    task,
    output: redactDeep(output),
    truncated: result.truncated === true,
    executable: false,
  };
}

/**
 * Record the extension's answer. Rejects unknown, expired and already
 * terminal requests; validates and re-redacts the result per request kind.
 */
export function respondBrowserBridgeRequest(
  requestId: string,
  response: BrowserBridgeRespondInput,
  options: { now?: Date } = {}
): BrowserBridgeRequest {
  const now = options.now ?? new Date();
  if (!REQUEST_ID_PATTERN.test(String(requestId))) {
    throw new BrowserBridgeMailboxError(
      'invalid_input',
      `invalid request id: ${String(requestId)}`
    );
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(response ?? null), 'utf8');
  } catch {
    throw new BrowserBridgeMailboxError('invalid_response', 'response is not serializable');
  }
  if (size > BROWSER_BRIDGE_MAX_RESPONSE_BYTES) {
    throw new BrowserBridgeMailboxError(
      'too_large',
      `response is ${size} bytes; the cap is ${BROWSER_BRIDGE_MAX_RESPONSE_BYTES}`
    );
  }
  if (!response || !['completed', 'declined', 'failed'].includes(response.status)) {
    throw new BrowserBridgeMailboxError(
      'invalid_input',
      'status must be completed|declined|failed'
    );
  }
  const scope = findRequestScope(requestId);
  if (!scope) throw new BrowserBridgeMailboxError('not_found', `unknown request ${requestId}`);

  return withLockSync(lockId(requestId), () => {
    const current = readRequestAt(scope, requestId);
    if (!current) throw new BrowserBridgeMailboxError('not_found', `unknown request ${requestId}`);
    if (isTerminalBrowserBridgeStatus(current.status)) {
      throw new BrowserBridgeMailboxError(
        current.status === 'expired' ? 'expired' : 'terminal',
        `request ${requestId} is already ${current.status}`
      );
    }
    if (isExpiredAt(current, now)) {
      expireRecord(current, now);
      throw new BrowserBridgeMailboxError('expired', `request ${requestId} has expired`);
    }

    const origin =
      response.origin === undefined ? undefined : canonicalHttpOrigin(String(response.origin));
    if (response.origin !== undefined && origin !== response.origin) {
      throw new BrowserBridgeMailboxError(
        'invalid_response',
        'origin must be a canonical http(s) origin'
      );
    }
    let record: BrowserBridgeResponseRecord;
    if (response.status === 'completed') {
      const raw = response.result;
      if (current.request_kind === 'notify') {
        if (raw !== undefined) {
          throw new BrowserBridgeMailboxError('invalid_response', 'notify takes no result');
        }
        record = { status: 'completed', responded_at: now.toISOString() };
      } else {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new BrowserBridgeMailboxError(
            'invalid_response',
            'completed response needs a result object'
          );
        }
        if (current.request_kind === 'observe_tab') {
          const normalized = normalizeObserveResult(
            current,
            raw as Record<string, unknown>,
            origin ?? undefined
          );
          record = {
            status: 'completed',
            result: normalized.result,
            responded_at: now.toISOString(),
            origin: normalized.origin,
          };
        } else {
          record = {
            status: 'completed',
            result: normalizeLocalInferResult(current, raw as Record<string, unknown>),
            responded_at: now.toISOString(),
            ...(origin ? { origin } : {}),
          };
        }
      }
    } else {
      if (response.result !== undefined) {
        throw new BrowserBridgeMailboxError(
          'invalid_response',
          `${response.status} takes no result`
        );
      }
      const error = cleanString(response.error, 1000);
      record = {
        status: response.status,
        ...(error ? { error } : {}),
        responded_at: now.toISOString(),
        ...(origin ? { origin } : {}),
      };
    }
    const updated: BrowserBridgeRequest = { ...current, status: record.status, response: record };
    writeRequest(updated);
    return updated;
  });
}

/**
 * Wait until the request reaches a terminal status (or its lifetime ends).
 * Returns the terminal record; on timeout returns the current, non-terminal one.
 */
export async function awaitBrowserBridgeResponse(
  requestId: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<BrowserBridgeRequest> {
  const clock = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = Math.max(0, options.timeoutMs ?? BROWSER_BRIDGE_DEFAULT_TTL_MS);
  const pollMs = Math.max(50, options.pollMs ?? 1000);
  const deadline = clock().getTime() + timeoutMs;
  for (;;) {
    const record = loadBrowserBridgeRequest(requestId, { now: clock() });
    if (!record) throw new BrowserBridgeMailboxError('not_found', `unknown request ${requestId}`);
    if (isTerminalBrowserBridgeStatus(record.status)) return record;
    const remaining = deadline - clock().getTime();
    if (remaining <= 0) return record;
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Pending approvals as a read-only summary for the extension's inbox. There is
 * no decision capability here: deciding stays on the authenticated approval
 * path (`pnpm kyberion approvals --approve <id>`).
 */
export function listPendingApprovalsForBridge(
  options: { now?: Date; limit?: number; list?: () => ApprovalRequestRecord[] } = {}
): BrowserBridgeApprovalSummary[] {
  const now = (options.now ?? new Date()).getTime();
  const limit = Math.min(
    MAX_APPROVAL_SUMMARIES,
    Math.max(1, options.limit ?? MAX_APPROVAL_SUMMARIES)
  );
  const records = (options.list ?? (() => listApprovalRequests({ status: 'pending' })))();
  return records
    .filter((record) => record.status === 'pending' && !isApprovalRequestExpired(record, now))
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, limit)
    .map((record) => ({
      request_id: record.id,
      title: redactObservationText(String(record.title ?? '')).slice(0, 200),
      risk: String(record.severity ?? 'medium'),
      requested_at: record.requestedAt,
      ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
      approve_command: `pnpm kyberion approvals --approve ${record.id}`,
    }));
}
