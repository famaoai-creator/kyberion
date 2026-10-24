/**
 * CD-10 bolt review (plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-10 の実装設計"): the pure rules behind `customer-decision bolt-review`,
 * the `attachment` verb, the next-bolt milestone and the routing of the
 * customer's answer. No I/O, no clock.
 *
 *   - attachments: png / jpeg / webp only, sniffed from the bytes (the file
 *     extension must agree), at most {@link MAX_ATTACHMENT_BYTES} each and
 *     {@link MAX_ATTACHMENTS_PER_ENTRY} per entry; the id is the sha256 of the
 *     bytes, so the content hash binds the exact image;
 *   - links: public `https` URLs only — never localhost, loopback, private /
 *     link-local / CGNAT IP literals, `.local` / `.internal` / `.lan` names or
 *     a bare host name (an internal environment is never shown to a customer);
 *   - milestone: `bolt-after:<MISSION>` passes when the next mission of the
 *     case starts (the override window of the review closes then);
 *   - routing: `request_changes` → one backlog WorkItem, `reject` → the
 *     operator; each keyed by agenda × entry × decision (or change-request
 *     receipt), so a re-run never files twice.
 */
import { createHash } from 'node:crypto';
import {
  AGENDA_ATTACHMENT_MEDIA_TYPES,
  type AgendaAttachmentMediaType,
  type BoltReviewRouting,
  type DecisionAgenda,
  type DecisionReceipt,
} from './model.js';

export const MAX_ATTACHMENTS_PER_ENTRY = 6;
export const MAX_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_LINKS_PER_ENTRY = 6;
export const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{64}$/u;

export const BOLT_REVIEW_TEMPLATE_ID = 'bolt-review';
export const BOLT_REVIEW_ENTRY_ID = 'bolt_review';
export const BOLT_REVIEW_KEY = 'bolt.acceptance';
export const BOLT_MILESTONE_PREFIX = 'bolt-after:';
/** Same grammar as mission ids (`mission-creation.ts`). */
export const BOLT_MISSION_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/u;

/** The milestone the next bolt passes: `bolt-after:<MISSION>`. */
export function boltMilestone(missionId: string): string {
  return `${BOLT_MILESTONE_PREFIX}${missionId.toUpperCase()}`;
}

/** The ledger item of a mission's bolt review (one per mission, so open reviews never overlap). */
export function boltReviewItem(missionId: string): string {
  return `bolt:${missionId.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const EXTENSIONS: Record<AgendaAttachmentMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The stored file extension of a media type. */
export function attachmentExtension(mediaType: AgendaAttachmentMediaType): string {
  return EXTENSIONS[mediaType];
}

/** The media type a file name claims (`.png`, `.jpg` / `.jpeg`, `.webp`), or null. */
export function mediaTypeForFileName(name: string): AgendaAttachmentMediaType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

/** The media type the bytes are (magic number), or null. */
export function sniffImageMediaType(bytes: Uint8Array): AgendaAttachmentMediaType | null {
  const at = (index: number) => bytes[index];
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  )
    return 'image/png';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  const ascii = (start: number, text: string) =>
    [...text].every((char, offset) => at(start + offset) === char.charCodeAt(0));
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

export function isAttachmentMediaType(value: unknown): value is AgendaAttachmentMediaType {
  return (
    typeof value === 'string' &&
    (AGENDA_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value)
  );
}

export type AttachmentProblem = 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch';

/**
 * Check an image before it is stored: size, the type the name claims and the
 * type the bytes are must agree. Returns the media type and sha256 id.
 */
export function checkAttachmentBytes(
  name: string,
  bytes: Uint8Array
):
  | { ok: true; media_type: AgendaAttachmentMediaType; id: string }
  | { ok: false; problem: AttachmentProblem } {
  if (bytes.length === 0) return { ok: false, problem: 'empty' };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, problem: 'too_large' };
  const claimed = mediaTypeForFileName(name);
  if (!claimed) return { ok: false, problem: 'unsupported_type' };
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed !== claimed) return { ok: false, problem: 'type_mismatch' };
  return { ok: true, media_type: claimed, id: createHash('sha256').update(bytes).digest('hex') };
}

/** Every attachment id an agenda's entries list. */
export function agendaAttachmentIds(agenda: Pick<DecisionAgenda, 'entries'>): Set<string> {
  return new Set(
    agenda.entries.flatMap((entry) => (entry.attachments ?? []).map((item) => item.id))
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type LinkProblem =
  'invalid_url' | 'not_https' | 'credentials' | 'internal_host' | 'private_address' | 'bare_host';

const INTERNAL_SUFFIXES = ['.local', '.internal', '.lan', '.localhost', '.home.arpa', '.intranet'];

function ipv4Private(host: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(literal: string): boolean {
  const host = literal.toLowerCase();
  // `::`, `::1` and every address in ::/80 — IPv4-compatible (`::7f00:1`,
  // the normalized `::127.0.0.1`) and IPv4-mapped (`::ffff:…`): never public.
  if (host.startsWith('::')) return true;
  const groups = host.split(':');
  const first = Number.parseInt(groups[0] || '0', 16);
  const second = Number.parseInt(groups[1] || '0', 16);
  if (Number.isNaN(first) || Number.isNaN(second)) return true;
  return (
    first === 0 ||
    // NAT64 64:ff9b::/96 and its local-use 64:ff9b:1::/48 embed an IPv4 address.
    (first === 0x64 && second === 0xff9b) ||
    // 6to4 2002::/16 and Teredo 2001:0::/32 tunnel to an embedded IPv4 address.
    first === 0x2002 ||
    (first === 0x2001 && second === 0) ||
    // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
}

/**
 * Is this a link a customer may be sent? Null when it is, else the problem.
 * Only a public `https` host name or public IP literal passes.
 */
export function linkProblem(raw: unknown): LinkProblem | null {
  if (typeof raw !== 'string' || raw.length > 2000) return 'invalid_url';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  if (url.protocol !== 'https:') return 'not_https';
  if (url.username || url.password) return 'credentials';
  const hostname = url.hostname.replace(/\.+$/u, '').toLowerCase();
  if (!hostname) return 'invalid_url';
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return ipv6Private(hostname.slice(1, -1)) ? 'private_address' : null;
  }
  const v4 = ipv4Private(hostname);
  if (v4 !== null) return v4 ? 'private_address' : null;
  if (hostname === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
    return 'internal_host';
  if (!hostname.includes('.')) return 'bare_host';
  return null;
}

// ---------------------------------------------------------------------------
// Answers and routing
// ---------------------------------------------------------------------------

export interface BoltRoutingTarget {
  entry_id: string;
  ref: string;
  outcome: BoltReviewRouting['outcome'];
}

/**
 * The answers of a bolt-review agenda that must be routed: a decider's
 * `request_changes` / `reject` that became a ledger decision (ref: its
 * decision id) or a change request after the next bolt started (ref: the
 * receipt id). `unchanged` repeats an earlier decision, already a target.
 */
export function boltRoutingTargets(
  agenda: Pick<DecisionAgenda, 'agenda_id' | 'entries' | 'bolt_mission_id'>,
  receipts: readonly DecisionReceipt[]
): BoltRoutingTarget[] {
  if (!agenda.bolt_mission_id) return [];
  const approvals = new Set(
    agenda.entries.filter((entry) => entry.kind === 'approval').map((entry) => entry.entry_id)
  );
  const targets = new Map<string, BoltRoutingTarget>();
  for (const receipt of receipts) {
    if (receipt.agenda_id !== agenda.agenda_id || receipt.participant.role !== 'decider') continue;
    let decided = 0;
    for (const answer of receipt.answers) {
      const index = answer.outcome === 'decided' ? decided++ : -1;
      if (!approvals.has(answer.entry_id)) continue;
      if (answer.choice !== 'request_changes' && answer.choice !== 'reject') continue;
      const ref =
        answer.outcome === 'decided'
          ? receipt.decision_ids[index]
          : answer.outcome === 'change_request'
            ? receipt.receipt_id
            : undefined;
      if (!ref) continue;
      const target: BoltRoutingTarget = { entry_id: answer.entry_id, ref, outcome: answer.choice };
      targets.set(`${target.entry_id}\u0000${ref}`, target);
    }
  }
  return [...targets.values()];
}

/** Routed already: a WorkItem for request_changes, a notification for reject. */
export function isBoltTargetRouted(
  target: BoltRoutingTarget,
  routing: readonly BoltReviewRouting[] = []
): boolean {
  return routing.some(
    (entry) =>
      entry.entry_id === target.entry_id &&
      entry.ref === target.ref &&
      (target.outcome === 'request_changes'
        ? Boolean(entry.work_item_id)
        : Boolean(entry.notified_at))
  );
}

function shortDigest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16).toUpperCase();
}

/** The backlog WorkItem of a `request_changes` answer (one per agenda × entry × decision). */
export function boltReworkWorkItemId(agendaId: string, entryId: string, ref: string): string {
  return `WI-CDB-${shortDigest([agendaId, entryId, ref])}`;
}

/** The inbox entry (and notification identity) of a `reject` answer. */
export function boltRejectInboxEntryId(agendaId: string, entryId: string, ref: string): string {
  return `INBOX-CDB-${shortDigest([agendaId, entryId, ref])}`;
}
