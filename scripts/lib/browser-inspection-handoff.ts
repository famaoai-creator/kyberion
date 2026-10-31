/**
 * Browser inspection hand-off (Chrome extension -> `pnpm kyberion browser inspect --mode extension`).
 *
 * The extension never talks to the CLI directly (no loopback HTTP; spec §4.2).
 * Instead:
 *
 *   1. The CLI opens a short-lived *ticket* on the staging floor of the
 *      tier/tenant partition the operator chose
 *      (`active/shared/staging/<tier>/<tenant|shared>/browser-inspection/<ticket_id>.json`).
 *      It prints a 6-character pairing code; only the code's digest is stored.
 *   2. The operator types that code into the side panel and presses
 *      "Kyberion CLIへ送信", which sends a `submit_inspection` native message.
 *      The native host (the only trust boundary reachable from the allowlisted
 *      extension) validates, bounds and re-redacts the payload and writes it
 *      into the single waiting, unexpired ticket whose code matches — never
 *      "the newest ticket", so data cannot cross into another tier/tenant.
 *      An optional `--origin` pin on the ticket is enforced too.
 *   3. The CLI polls its own ticket, reads the inspection and deletes the file.
 *
 * A submission with no waiting CLI is refused, so nothing lands unless the
 * operator asked for it; stale tickets (crashed CLI) are ignored once expired
 * and swept by the host. All I/O goes through secure-io under the sovereign
 * concierge role, like the browser-bridge mailbox and send_page.
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { redactObservationText } from '@agent/core/browser/browser-extension-bridge';
import { readJsonIfPresent, writeJson } from '@agent/core/foundation/json';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { auditChain } from '@agent/core/governance/audit-chain';
import { createLogger } from '@agent/core/logger';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
} from '@agent/core/secure-io';
import {
  STORAGE_DATA_TIERS,
  STORAGE_FLOOR_ROOTS,
  UNTENANTED_PARTITION_SEGMENT,
  resolveStorageFloor,
  type StorageDataTier,
} from '@agent/core/storage-layout';

export const INSPECTION_HANDOFF_KIND = 'browser-inspection-handoff.v1';
export const INSPECTION_HANDOFF_DOMAIN = 'browser-inspection';
/** Longest a CLI may wait for a submission. */
export const INSPECTION_HANDOFF_MAX_TTL_MS = 10 * 60_000;
/** Cap on the serialized inspection the host accepts. */
export const INSPECTION_HANDOFF_MAX_BYTES = 64 * 1024;

export const INSPECTION_LIMITS = {
  headings: 30,
  inputs: 40,
  buttons: 40,
  links: 40,
  title: 300,
  text: 200,
  buttonText: 120,
  className: 80,
  href: 2048,
  excerpt: 1000,
} as const;

const TICKET_ID_PATTERN = /^BIH-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TENANT_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const INPUT_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const HEADING_LEVELS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export interface InspectionHandoffScope {
  tier: StorageDataTier;
  tenant_slug?: string;
}

export interface InspectionHandoffPayload {
  url: string;
  origin: string;
  title: string;
  headings: Array<{ level: string; text: string }>;
  inputs: Array<{
    tag: string;
    type?: string;
    name?: string;
    id?: string;
    placeholder?: string;
    label?: string;
    required?: boolean;
  }>;
  buttons: Array<{ text: string; id?: string; className?: string; disabled?: boolean }>;
  links: Array<{ text: string; href: string }>;
  textExcerpt: string;
  truncated: boolean;
}

export interface InspectionHandoffTicket {
  kind: typeof INSPECTION_HANDOFF_KIND;
  ticket_id: string;
  status: 'waiting' | 'submitted';
  created_at: string;
  expires_at: string;
  scope: InspectionHandoffScope;
  /**
   * Random per-ticket salt and sha256(salt:code) of the pairing code the CLI
   * printed; the code itself is never stored. The code keeps concurrent CLIs
   * from receiving each other's inspection — it is not an authentication secret.
   */
  pairing_salt: string;
  pairing_code_sha256: string;
  /** Optional `--origin` pin: the host refuses inspections of any other origin. */
  allowed_origin?: string;
  submitted_at?: string;
  inspection?: InspectionHandoffPayload;
}

export type InspectionHandoffErrorCode =
  | 'invalid_input'
  | 'too_large'
  | 'no_waiting_cli'
  | 'pairing_code_required'
  | 'pairing_mismatch'
  | 'ambiguous_waiting_cli'
  | 'origin_mismatch'
  | 'audit_unavailable'
  | 'timeout'
  | 'not_found';

export class InspectionHandoffError extends Error {
  constructor(
    readonly code: InspectionHandoffErrorCode,
    message: string
  ) {
    super(`[BROWSER_INSPECTION_${code.toUpperCase()}] ${message}`);
    this.name = 'InspectionHandoffError';
  }
}

const logger = createLogger('browser-inspection-handoff');

const asConcierge = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', fn, 'sovereign');

// ---------------------------------------------------------------------------
// Payload validation (the host's trust boundary)
// ---------------------------------------------------------------------------

/** Redact, collapse whitespace and clamp; never ends on a lone high surrogate. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const redacted = redactObservationText(value.replace(/\s+/gu, ' ').trim());
  if (redacted.length <= max) return redacted;
  const clipped = redacted.slice(0, max);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

function optionalText(value: unknown, max: number): string | undefined {
  const cleaned = cleanText(value, max);
  return cleaned ? cleaned : undefined;
}

/** http(s) URL without query string or fragment (they can carry tokens). */
function stripQuery(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > INSPECTION_LIMITS.href) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url;
  } catch {
    return null;
  }
}

function boundedList(value: unknown, max: number, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new InspectionHandoffError('invalid_input', `${field} must be an array`);
  return value.slice(0, max);
}

/**
 * Validate, bound and re-redact an inspection coming from the extension.
 * Input values are never accepted; URLs lose query strings and fragments.
 */
export function sanitizeInspectionPayload(raw: unknown): InspectionHandoffPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InspectionHandoffError('invalid_input', 'inspection must be an object');
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    throw new InspectionHandoffError('invalid_input', 'inspection is not serializable');
  }
  if (size > INSPECTION_HANDOFF_MAX_BYTES) {
    throw new InspectionHandoffError(
      'too_large',
      `inspection is ${size} bytes; the cap is ${INSPECTION_HANDOFF_MAX_BYTES}`
    );
  }
  const input = raw as Record<string, unknown>;
  const pageUrl = stripQuery(input.url);
  if (!pageUrl) throw new InspectionHandoffError('invalid_input', 'url must be an http(s) URL');
  if (input.origin !== undefined && input.origin !== pageUrl.origin) {
    throw new InspectionHandoffError('invalid_input', 'origin does not match url');
  }

  const rawHeadings = Array.isArray(input.headings) ? input.headings.length : 0;
  const rawInputs = Array.isArray(input.inputs) ? input.inputs.length : 0;
  const rawButtons = Array.isArray(input.buttons) ? input.buttons.length : 0;
  const rawLinks = Array.isArray(input.links) ? input.links.length : 0;

  const headings = boundedList(input.headings, INSPECTION_LIMITS.headings, 'headings')
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const level = typeof item.level === 'string' ? item.level.toLowerCase() : '';
      return { level, text: cleanText(item.text, INSPECTION_LIMITS.text) };
    })
    .filter((item) => HEADING_LEVELS.has(item.level) && item.text);

  const inputs = boundedList(input.inputs, INSPECTION_LIMITS.inputs, 'inputs')
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const tag = typeof item.tag === 'string' ? item.tag.toLowerCase() : '';
      const type =
        typeof item.type === 'string' && /^[a-z-]{1,40}$/u.test(item.type.toLowerCase())
          ? item.type.toLowerCase()
          : undefined;
      // `value` is deliberately never copied: field contents stay in the browser.
      const out: InspectionHandoffPayload['inputs'][number] = { tag };
      if (type) out.type = type;
      const name = optionalText(item.name, INSPECTION_LIMITS.text);
      const id = optionalText(item.id, INSPECTION_LIMITS.text);
      const placeholder = optionalText(item.placeholder, INSPECTION_LIMITS.text);
      const label = optionalText(item.label, INSPECTION_LIMITS.text);
      if (name) out.name = name;
      if (id) out.id = id;
      if (placeholder) out.placeholder = placeholder;
      if (label) out.label = label;
      if (item.required === true) out.required = true;
      return out;
    })
    .filter(
      (item) => INPUT_TAGS.has(item.tag) && (item.name || item.id || item.placeholder || item.label)
    );

  const buttons = boundedList(input.buttons, INSPECTION_LIMITS.buttons, 'buttons')
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const out: InspectionHandoffPayload['buttons'][number] = {
        text: cleanText(item.text, INSPECTION_LIMITS.buttonText),
      };
      const id = optionalText(item.id, INSPECTION_LIMITS.text);
      const className = optionalText(item.className, INSPECTION_LIMITS.className);
      if (id) out.id = id;
      if (className) out.className = className;
      if (item.disabled === true) out.disabled = true;
      return out;
    })
    .filter((item) => item.text);

  const links = boundedList(input.links, INSPECTION_LIMITS.links, 'links')
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const href = stripQuery(item.href);
      return {
        text: cleanText(item.text, INSPECTION_LIMITS.buttonText),
        href: href ? redactObservationText(href.toString()) : '',
      };
    })
    .filter((item) => item.text && item.href);

  return {
    url: redactObservationText(pageUrl.toString()),
    origin: pageUrl.origin,
    title: cleanText(input.title, INSPECTION_LIMITS.title),
    headings,
    inputs,
    buttons,
    links,
    textExcerpt: cleanText(input.textExcerpt, INSPECTION_LIMITS.excerpt),
    truncated:
      rawHeadings > INSPECTION_LIMITS.headings ||
      rawInputs > INSPECTION_LIMITS.inputs ||
      rawButtons > INSPECTION_LIMITS.buttons ||
      rawLinks > INSPECTION_LIMITS.links,
  };
}

// ---------------------------------------------------------------------------
// Ticket storage
// ---------------------------------------------------------------------------

function ticketDir(scope: InspectionHandoffScope): string {
  return resolveStorageFloor(
    'staging',
    { kind: 'tier', tier: scope.tier, tenant: scope.tenant_slug },
    INSPECTION_HANDOFF_DOMAIN
  );
}

function ticketPath(scope: InspectionHandoffScope, ticketId: string): string {
  if (!TICKET_ID_PATTERN.test(ticketId)) {
    throw new InspectionHandoffError('invalid_input', `invalid ticket id: ${ticketId}`);
  }
  return assertSafeRepositoryPath(path.join(ticketDir(scope), `${ticketId}.json`), {
    allowMissingLeaf: true,
  });
}

function lockId(ticketId: string): string {
  return `browser-inspection-${ticketId}`;
}

function readTicket(
  scope: InspectionHandoffScope,
  ticketId: string
): InspectionHandoffTicket | null {
  try {
    const parsed = readJsonIfPresent<InspectionHandoffTicket>(ticketPath(scope, ticketId));
    if (
      !parsed ||
      parsed.kind !== INSPECTION_HANDOFF_KIND ||
      parsed.ticket_id !== ticketId ||
      parsed.scope?.tier !== scope.tier ||
      (parsed.scope?.tenant_slug ?? undefined) !== (scope.tenant_slug ?? undefined)
    ) {
      return null;
    }
    return parsed as InspectionHandoffTicket;
  } catch {
    return null;
  }
}

function writeTicket(ticket: InspectionHandoffTicket): void {
  const filePath = ticketPath(ticket.scope, ticket.ticket_id);
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, ticket);
}

function removeTicket(scope: InspectionHandoffScope, ticketId: string): void {
  safeRmSync(ticketPath(scope, ticketId), { force: true });
}

/** Every tier/tenant partition that currently has a browser-inspection directory. */
function ticketPartitions(): InspectionHandoffScope[] {
  const scopes: InspectionHandoffScope[] = [];
  for (const tier of STORAGE_DATA_TIERS) {
    const tierDir = pathResolver.rootResolve(path.posix.join(STORAGE_FLOOR_ROOTS.staging, tier));
    let names: string[];
    try {
      if (!safeExistsSync(tierDir)) continue;
      names = safeReaddir(tierDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      let scope: InspectionHandoffScope;
      if (name === UNTENANTED_PARTITION_SEGMENT) scope = { tier };
      else if (TENANT_SEGMENT_PATTERN.test(name)) scope = { tier, tenant_slug: name };
      else continue;
      try {
        if (safeExistsSync(ticketDir(scope))) scopes.push(scope);
      } catch {
        /* a reserved name or unreadable partition is skipped */
      }
    }
  }
  return scopes;
}

function ticketIdsIn(scope: InspectionHandoffScope): string[] {
  try {
    return safeReaddir(ticketDir(scope))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => TICKET_ID_PATTERN.test(id));
  } catch {
    return [];
  }
}

export interface InspectionAuditEntry {
  action: string;
  operation: string;
  result: 'completed' | 'denied' | 'failed';
  reason: string;
  metadata: Record<string, unknown>;
}

/** Record an audit entry; returns false (and warns) when it could not be written. */
function recordAudit(entry: InspectionAuditEntry): boolean {
  try {
    auditChain.record({ agentId: 'browser-inspect', ...entry });
    return true;
  } catch (err) {
    logger.warn(
      `browser inspection audit not recorded — ${err instanceof Error ? err.message.slice(0, 200) : 'audit chain unavailable'} | next: check the audit chain | evidence: ${entry.operation}`
    );
    return false;
  }
}

function scopeMetadata(scope: InspectionHandoffScope): Record<string, unknown> {
  return { tier: scope.tier, ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}) };
}

/** Confidential hand-offs fail closed when their audit record cannot be written. */
function requiresAudit(scope: InspectionHandoffScope): boolean {
  return scope.tier === 'confidential';
}

// ---------------------------------------------------------------------------
// Pairing code
// ---------------------------------------------------------------------------

/** No 0/O, 1/I/L: easy to read off a terminal and type into the side panel. */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 6;

function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/** Uppercase and drop spaces/hyphens; null when it is not a well-formed code. */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[\s-]+/gu, '').toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const char of code) if (!PAIRING_ALPHABET.includes(char)) return null;
  return code;
}

/** sha256(per-ticket random salt : code). */
function pairingDigest(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/** Does `code` match this ticket's salted digest? Constant-time comparison. */
function ticketMatchesCode(ticket: InspectionHandoffTicket, code: string): boolean {
  const { pairing_salt: salt, pairing_code_sha256: expected } = ticket;
  if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/u.test(salt)) return false;
  const actual = pairingDigest(salt, code);
  if (typeof expected !== 'string' || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

// ---------------------------------------------------------------------------
// CLI side
// ---------------------------------------------------------------------------

export interface OpenedInspectionTicket extends InspectionHandoffTicket {
  /** Shown to the operator only; the stored ticket keeps just its digest. */
  pairing_code: string;
}

/** Open a waiting ticket in an already-normalized scope (see normalizeBrowserBridgeScope). */
export function openInspectionTicket(
  scope: InspectionHandoffScope,
  options: { ttlMs: number; now?: Date; allowedOrigin?: string }
): OpenedInspectionTicket {
  const ttl = options.ttlMs;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > INSPECTION_HANDOFF_MAX_TTL_MS) {
    throw new InspectionHandoffError('invalid_input', 'timeout must be > 0 and at most 10 minutes');
  }
  let allowedOrigin: string | undefined;
  if (options.allowedOrigin !== undefined) {
    try {
      const url = new URL(options.allowedOrigin);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.origin !== options.allowedOrigin.replace(/\/$/u, '')
      ) {
        throw new Error('not an origin');
      }
      allowedOrigin = url.origin;
    } catch {
      throw new InspectionHandoffError(
        'invalid_input',
        'origin must be a canonical http(s) origin such as https://example.com'
      );
    }
  }
  const now = options.now ?? new Date();
  const pairingCode = generatePairingCode();
  const pairingSalt = randomBytes(16).toString('hex');
  const ticket: InspectionHandoffTicket = {
    kind: INSPECTION_HANDOFF_KIND,
    ticket_id: `BIH-${randomUUID()}`,
    status: 'waiting',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    scope: scope.tenant_slug
      ? { tier: scope.tier, tenant_slug: scope.tenant_slug }
      : { tier: scope.tier },
    pairing_salt: pairingSalt,
    pairing_code_sha256: pairingDigest(pairingSalt, pairingCode),
    ...(allowedOrigin ? { allowed_origin: allowedOrigin } : {}),
  };
  asConcierge(() => {
    writeTicket(ticket);
    const audited = recordAudit({
      action: 'browser_inspection_wait',
      operation: 'browser:inspect:extension:wait',
      result: 'completed',
      reason: 'CLI is waiting for an extension inspection via the native host',
      metadata: {
        ticket_id: ticket.ticket_id,
        expires_at: ticket.expires_at,
        ...scopeMetadata(scope),
        ...(allowedOrigin ? { allowed_origin: allowedOrigin } : {}),
      },
    });
    if (!audited && requiresAudit(scope)) {
      removeTicket(ticket.scope, ticket.ticket_id);
      throw new InspectionHandoffError(
        'audit_unavailable',
        'the audit chain could not record a confidential hand-off; nothing is waiting'
      );
    }
  });
  return { ...ticket, pairing_code: pairingCode };
}

/** Remove a ticket (consumed, timed out or abandoned). */
export function closeInspectionTicket(
  ticket: Pick<InspectionHandoffTicket, 'scope' | 'ticket_id'>
): void {
  asConcierge(() =>
    withLockSync(lockId(ticket.ticket_id), () => removeTicket(ticket.scope, ticket.ticket_id))
  );
}

/**
 * Remove the ticket under its lock and return what it held, so a submission
 * that lands right at the deadline is still delivered instead of discarded.
 */
function takeInspectionTicket(
  ticket: Pick<InspectionHandoffTicket, 'scope' | 'ticket_id'>
): InspectionHandoffTicket | null {
  return asConcierge(() =>
    withLockSync(lockId(ticket.ticket_id), () => {
      const current = readTicket(ticket.scope, ticket.ticket_id);
      removeTicket(ticket.scope, ticket.ticket_id);
      return current;
    })
  );
}

/**
 * Poll the ticket until the host fills it in. The ticket is always removed
 * before returning or throwing.
 */
export async function awaitInspectionTicket(
  ticket: Pick<InspectionHandoffTicket, 'scope' | 'ticket_id' | 'expires_at'>,
  options: { pollMs?: number; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}
): Promise<InspectionHandoffPayload> {
  const clock = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(50, options.pollMs ?? 500);
  const deadline = Date.parse(ticket.expires_at);
  try {
    for (;;) {
      const current = asConcierge(() => readTicket(ticket.scope, ticket.ticket_id));
      if (!current) {
        throw new InspectionHandoffError('not_found', `ticket ${ticket.ticket_id} disappeared`);
      }
      if (current.status === 'submitted' && current.inspection) return current.inspection;
      const remaining = deadline - clock().getTime();
      if (remaining <= 0) {
        const last = takeInspectionTicket(ticket);
        if (last?.status === 'submitted' && last.inspection) return last.inspection;
        throw new InspectionHandoffError(
          'timeout',
          'no inspection arrived from the extension before the timeout'
        );
      }
      await sleep(Math.min(pollMs, remaining));
    }
  } finally {
    closeInspectionTicket(ticket);
  }
}

// ---------------------------------------------------------------------------
// Native host side
// ---------------------------------------------------------------------------

export interface InspectionSubmitResult {
  ticket_id: string;
  scope: InspectionHandoffScope;
  inspection: InspectionHandoffPayload;
}

/** How long a submitted ticket may outlive its deadline before the host deletes it (CLI crash). */
export const INSPECTION_SUBMITTED_GRACE_MS = 2 * 60_000;

/** Expired waiting tickets, and submitted ones past the grace, hold nothing a live CLI needs. */
function isSweepable(ticket: InspectionHandoffTicket, nowMs: number): boolean {
  const expires = Date.parse(ticket.expires_at);
  if (ticket.status === 'waiting') return expires <= nowMs;
  return expires + INSPECTION_SUBMITTED_GRACE_MS <= nowMs;
}

const SUBMIT_AUDIT = {
  action: 'browser_bridge_submit_inspection',
  operation: 'browser:bridge:submit_inspection',
} as const;

function deny(
  code: InspectionHandoffErrorCode,
  message: string,
  metadata: Record<string, unknown>
): never {
  recordAudit({
    ...SUBMIT_AUDIT,
    result: 'denied',
    reason: message.slice(0, 200),
    metadata: { code, ...metadata },
  });
  throw new InspectionHandoffError(code, message);
}

/**
 * Deliver a sanitized inspection to the one waiting, unexpired ticket whose
 * pairing code the operator typed into the side panel. There is no "newest
 * ticket" fallback: the code alone selects the tier/tenant partition, so data
 * never lands in a scope the operator did not pair with. Expired waiting
 * tickets, and submitted ones more than INSPECTION_SUBMITTED_GRACE_MS past
 * their deadline (a crashed CLI), are swept on the way. Every outcome is
 * audited; the delivery audit is written before the ticket shows the
 * inspection, and a confidential delivery is skipped when it cannot be.
 */
export function submitInspectionToWaitingTicket(
  raw: unknown,
  options: { pairingCode?: unknown; clock?: () => Date } = {}
): InspectionSubmitResult {
  const clock = options.clock ?? (() => new Date());
  return asConcierge(() => {
    if (
      options.pairingCode === undefined ||
      options.pairingCode === null ||
      options.pairingCode === ''
    ) {
      deny(
        'pairing_code_required',
        'enter the pairing code that pnpm kyberion browser inspect --mode extension printed',
        {}
      );
    }
    const code = normalizePairingCode(options.pairingCode);
    if (!code) {
      deny('invalid_input', `pairing code must be ${PAIRING_CODE_LENGTH} letters/digits`, {});
    }
    let inspection: InspectionHandoffPayload;
    try {
      inspection = sanitizeInspectionPayload(raw);
    } catch (err) {
      if (err instanceof InspectionHandoffError) deny(err.code, err.message, {});
      throw err;
    }
    let waitingCount = 0;
    const matches: Array<{ scope: InspectionHandoffScope; ticket: InspectionHandoffTicket }> = [];
    for (const scope of ticketPartitions()) {
      for (const id of ticketIdsIn(scope)) {
        const ticket = readTicket(scope, id);
        if (!ticket) continue;
        if (Date.parse(ticket.expires_at) <= clock().getTime()) {
          try {
            withLockSync(lockId(id), () => {
              const current = readTicket(scope, id);
              if (current && isSweepable(current, clock().getTime())) removeTicket(scope, id);
            });
          } catch {
            /* a locked stale ticket is swept next time */
          }
          continue;
        }
        if (ticket.status !== 'waiting') continue;
        waitingCount += 1;
        if (ticketMatchesCode(ticket, code!)) matches.push({ scope, ticket });
      }
    }
    if (matches.length === 0) {
      if (waitingCount === 0) {
        deny(
          'no_waiting_cli',
          'no Kyberion CLI is waiting; run pnpm kyberion browser inspect --mode extension first',
          { origin: inspection!.origin }
        );
      }
      deny('pairing_mismatch', 'the pairing code does not match a waiting Kyberion CLI', {
        origin: inspection!.origin,
      });
    }
    if (matches.length > 1) {
      // Two CLIs drew the same code: refuse rather than guess a scope.
      deny(
        'ambiguous_waiting_cli',
        'more than one waiting Kyberion CLI matches this pairing code; restart one of them',
        { origin: inspection!.origin }
      );
    }
    const [{ scope, ticket }] = matches;
    const outcome = withLockSync(lockId(ticket.ticket_id), () => {
      const now = clock();
      const current = readTicket(scope, ticket.ticket_id);
      if (
        !current ||
        current.status !== 'waiting' ||
        Date.parse(current.expires_at) <= now.getTime() ||
        !ticketMatchesCode(current, code!)
      ) {
        return 'gone' as const;
      }
      if (current.allowed_origin && current.allowed_origin !== inspection.origin) {
        return 'origin_mismatch' as const;
      }
      // Audit first: the CLI polls without this lock, so the ticket must not
      // show the inspection before its audit record exists.
      const audited = recordAudit({
        ...SUBMIT_AUDIT,
        result: 'completed',
        reason: `Extension inspection of ${inspection.origin} handed to the paired CLI`,
        metadata: {
          ticket_id: current.ticket_id,
          ...scopeMetadata(scope),
          origin: inspection.origin,
          counts: {
            headings: inspection.headings.length,
            inputs: inspection.inputs.length,
            buttons: inspection.buttons.length,
            links: inspection.links.length,
          },
          truncated: inspection.truncated,
        },
      });
      if (!audited && requiresAudit(scope)) return 'audit_unavailable' as const;
      const updated: InspectionHandoffTicket = {
        ...current,
        status: 'submitted',
        submitted_at: now.toISOString(),
        inspection,
      };
      writeTicket(updated);
      return 'delivered' as const;
    });
    const meta = {
      ticket_id: ticket.ticket_id,
      ...scopeMetadata(scope),
      origin: inspection.origin,
    };
    if (outcome === 'gone') {
      deny('no_waiting_cli', 'the paired Kyberion CLI stopped waiting', meta);
    }
    if (outcome === 'origin_mismatch') {
      deny(
        'origin_mismatch',
        `the waiting CLI only accepts ${ticket.allowed_origin}; this page is ${inspection.origin}`,
        meta
      );
    }
    if (outcome === 'audit_unavailable') {
      throw new InspectionHandoffError(
        'audit_unavailable',
        'the audit chain could not record a confidential hand-off; nothing was delivered'
      );
    }
    return { ticket_id: ticket.ticket_id, scope, inspection };
  });
}
