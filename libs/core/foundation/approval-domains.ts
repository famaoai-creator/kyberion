/**
 * Declarative approval-channel taxonomy (P2 of the unified authorization
 * design — the approval-surface twin of authorization-registry.ts).
 *
 * `createApprovalRequest` carries two channel fields:
 *   - `channel`        — routing/surface label (where the decision is presented)
 *   - `storageChannel` — physical store partition (defaults to `channel`)
 *
 * Both are validated today only by syntax (`normalizeApprovalChannel`), so
 * subsystems coin names freely: `terminal` alone hosts ~10 unrelated decision
 * domains, and `pipeline-execution-<tenant>` is generated dynamically.
 *
 * This module declares the closed vocabulary so that (a) undeclared values can
 * be measured before enforcement, and (b) a boundary gate can keep literals
 * out of production call sites. Lookup is pure/in-memory (admission is a hot
 * path) and fail-safe: an unknown value resolves as an undeclared domain —
 * the strictest reading, since an unknown partition is a routing decision,
 * not a delivery detail.
 */

// --- declaration shapes ---------------------------------------------------

export interface ApprovalDomainSpec {
  /** The decision family this partition exists for. */
  decision: string;
  /** Notes on routing/ownership worth recording with the declaration. */
  notes?: string;
}

export interface ApprovalSurfaceSpec {
  /** How requests on this surface reach a decider. */
  delivery: 'async' | 'interactive' | 'internal';
  notes?: string;
}

export type ApprovalChannelKind = 'domain' | 'surface';

export interface ApprovalChannelResolution {
  /** The normalized channel value that was looked up. */
  id: string;
  /** `domain` when the id is a declared storage domain (or undeclared — see fail-safe), `surface` when only a delivery surface matches. */
  kind: ApprovalChannelKind;
  /** false when the value matched nothing (fail-safe undeclared domain). */
  declared: boolean;
  /** How the match was found: exact declaration, a declared prefix family, or the fail-safe default. */
  via: 'exact' | 'prefix' | 'fail-safe';
}

// --- declared storage domains --------------------------------------------
// Verified against every production createApprovalRequest call site
// (see evidence: MSN-APPROVAL-CHANNELS-20261102 requirements-draft.json).

export const APPROVAL_DOMAINS: Readonly<Record<string, ApprovalDomainSpec>> = {
  // Legacy catch-all: ~10 decision domains funnel here because storageChannel
  // defaults to channel. Kept declared — migration to named domains is P3.
  terminal: {
    decision: 'legacy catch-all partition (multiple decision domains)',
    notes: 'P3: split per-domain',
  },
  autonomy: { decision: 'autonomous-operation admission decisions' },
  'external-operation': { decision: 'external effect admission (admitExternalOperation)' },
  'grant-standing': { decision: 'standing grant issuance' },
  'mission-scope': { decision: 'mission intent-drift scope approval' },
  'mission-reconciliation': { decision: 'mission work reconciliation approval' },
  'mission-task-supersede': { decision: 'mission task supersede approval' },
  'pipeline-await-state': { decision: 'pipeline await-state authorization' },
  'tenant-activation': { decision: 'tenant activation gate' },
  'tenant-provider-attestation': { decision: 'tenant provider attestation' },
  'custody-provider-attestation': {
    decision: 'system / person custody provider attestation',
  },
  'nhi-session-admission': { decision: 'NHI session admission' },
  'onboarding-authority': { decision: 'organization onboarding authority' },
  'project-trust': { decision: 'managed project trust grant' },
  'plugin-install': { decision: 'third-party plugin install' },
  chronos: { decision: 'chronos surface approvals (incl. plugin views)' },
  concierge: { decision: 'concierge-mediated decisions (secret introduction)' },
  'peer-recovery': { decision: 'mesh peer recovery' },
  'service-recording-review': { decision: 'service recording review' },
  'background-review': { decision: 'background review patch approval' },
  'video-production': { decision: 'video production evidence approval' },
  'agent-runtime': { decision: 'agent runtime prompt approval' },
  brief: { decision: 'alignment brief approval' },
  'config-mission': { decision: 'config mission approval' },
  'personal-workbench': { decision: 'personal workbench action approval' },
  'apple-shortcuts': { decision: 'Apple Shortcuts bridge action' },
  operator: { decision: 'operator-directed approvals (dot executor, mission admission)' },
  slack: { decision: 'slack-surfaced approvals' },
  inbox: { decision: 'inbox-surfaced approvals' },
  computer: { decision: 'desktop/OS computer-use action approval (system-actuator)' },
  'pipeline-binding': { decision: 'accepted pipeline binding approval' },
  'mcp-approval': { decision: 'MCP server tool-call approval' },
};

/**
 * Dynamic domain families — longest prefix wins, same rule as the operation
 * registry. Values still must satisfy normalizeApprovalChannel's syntax.
 */
export const APPROVAL_DOMAIN_PREFIXES: Readonly<Record<string, ApprovalDomainSpec>> = {
  'pipeline-execution-': { decision: 'per-tenant pipeline execution gate' },
};

// --- declared surfaces ----------------------------------------------------
// Superset of SurfaceAsyncChannel (channel-surface-types.ts): approval
// requests also reach internal surfaces that are not async-delivery channels.
// Parity is enforced by approval-channel-boundary.test.ts.

export const APPROVAL_SURFACES: Readonly<Record<string, ApprovalSurfaceSpec>> = {
  terminal: { delivery: 'interactive' },
  cli: { delivery: 'interactive' },
  slack: { delivery: 'async' },
  chronos: { delivery: 'async' },
  presence: { delivery: 'async' },
  imessage: { delivery: 'async' },
  discord: { delivery: 'async' },
  telegram: { delivery: 'async' },
  cowork: { delivery: 'async' },
  inbox: { delivery: 'internal' },
  operator: { delivery: 'internal' },
  concierge: { delivery: 'internal' },
  brief: { delivery: 'internal' },
  'apple-shortcuts': { delivery: 'internal' },
  'config-mission': { delivery: 'internal' },
  autonomy: { delivery: 'internal' },
  system: {
    delivery: 'internal',
    notes: 'fallback channel of risky-op/task-runner approval ports',
  },
};

// --- lookup ---------------------------------------------------------------

const APPROVAL_CHANNEL_VALUE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function longestPrefixMatch(
  value: string,
  table: Readonly<Record<string, ApprovalDomainSpec>>
): string | undefined {
  let winner: string | undefined;
  for (const prefix of Object.keys(table)) {
    // Require a non-empty suffix: the bare prefix alone is not a member of the
    // dynamic family (the family exists to carry a runtime-derived suffix).
    if (
      value.length > prefix.length &&
      value.startsWith(prefix) &&
      (winner === undefined || prefix.length > winner.length)
    ) {
      winner = prefix;
    }
  }
  return winner;
}

/**
 * Resolve a channel/storageChannel value against the declared taxonomy.
 * Storage domains are checked before surfaces because a value used as a
 * partition is a routing decision; surface-only matches still classify as
 * `surface` so callers can tell "delivery surface, domain unset" apart from
 * a real domain hit.
 */
export function approvalChannelResolution(raw: string): ApprovalChannelResolution {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  if (id && APPROVAL_CHANNEL_VALUE_PATTERN.test(id)) {
    if (Object.hasOwn(APPROVAL_DOMAINS, id)) {
      return { id, kind: 'domain', declared: true, via: 'exact' };
    }
    const prefix = longestPrefixMatch(id, APPROVAL_DOMAIN_PREFIXES);
    if (prefix !== undefined) {
      return { id, kind: 'domain', declared: true, via: 'prefix' };
    }
    if (Object.hasOwn(APPROVAL_SURFACES, id)) {
      return { id, kind: 'surface', declared: true, via: 'exact' };
    }
  }
  // Fail-safe: an unknown/invalid value is an undeclared domain — the
  // strictest reading for a value that could become a store partition.
  return { id, kind: 'domain', declared: false, via: 'fail-safe' };
}

/** Ids of every declared domain (exact + prefix families), for gates and diagnostics. */
export function declaredApprovalDomains(): string[] {
  return [...Object.keys(APPROVAL_DOMAINS), ...Object.keys(APPROVAL_DOMAIN_PREFIXES)];
}

/** Ids of every declared surface. */
export function declaredApprovalSurfaces(): string[] {
  return Object.keys(APPROVAL_SURFACES);
}

// --- measurement -----------------------------------------------------------

const warned = new Set<string>();
let approvalChannelWarner: ((message: string) => void) | undefined;

/** Test/diagnostic seam: replace the warn sink and clear the dedupe set. */
export function setApprovalChannelWarner(warn?: (message: string) => void): void {
  approvalChannelWarner = warn;
  warned.clear();
}

/**
 * One-time-per-process measurement warn for an undeclared channel value.
 * Emitted by createApprovalRequest (and any future admission path); never
 * throws — P2 is measurement-first, matching the authorization-registry P0.
 */
export function warnUndeclaredApprovalChannel(
  field: 'channel' | 'storageChannel',
  value: string,
  resolution: ApprovalChannelResolution = approvalChannelResolution(value)
): void {
  if (resolution.declared || !resolution.id) return;
  const key = `${field}:${resolution.id}`;
  if (warned.has(key)) return;
  warned.add(key);
  try {
    approvalChannelWarner?.(
      `undeclared approval ${field} '${value}' — declare it in libs/core/foundation/approval-domains.ts`
    );
  } catch {
    // Measurement must never propagate — a warn sink failure is not a
    // reason to break request creation.
  }
}
