/**
 * Declarative authorization facts for operations (P0+P1 of the unified
 * authorization design — see docs/UNIFIED_AUTHORIZATION_POLICY_DESIGN.ja.md).
 *
 * Today "which operation needs which authority" is declared in four disjoint
 * places (approval-policy intent rules, PROTECTED_ARGUMENTS,
 * EXTERNAL_OPERATION_DELEGATION, grant-capability-policy) plus free-form
 * approval `channel` literals embedded at each call site. This registry is the
 * consolidation target: one table mapping an operation to its effect class
 * and authority requirement, with delegation attributes folded in as fields.
 *
 * Effect classes are a closed set describing the technical effect an
 * operation produces; they route the operation to its admission boundary.
 * The charter-facing `actionClass` (business decision vocabulary) is a
 * separate axis: technical effect alone cannot tell a payment-bearing send
 * from a notification.
 *
 * Lookup semantics: `operationAuthorization` never returns undefined. An
 * undeclared operation resolves to the fail-safe default
 * `external_mutation` + external admission with `declared: false` — the
 * caller may measure coverage (`declared`) while undeclared operations still
 * cannot route anywhere privileged.
 */
export type EffectClass =
  /** Mutating state outside this runtime: vcs push/merge/create, email/slack
   * sends, meeting posts, MCP tool calls, paid provider generation. */
  | 'external_mutation'
  /** Reads that send information to an external party: navigation/fetch
   * egress, remote VCS reads. */
  | 'external_read'
  /** Recording a human judgment: steward curation, inbox arbitration,
   * scope-approve, executor release. */
  | 'internal_decision'
  /** Writing governed knowledge: memory approve/promote, scoped learning. */
  | 'knowledge_write'
  /** Consuming or minting credential material: bindings, grants, allocations. */
  | 'credential_use'
  /** Process/system control: kill switch, halt, daemon lifecycle. */
  | 'system_control'
  /** No external effect; declared so it may pass without an admission. */
  | 'local_only';

export type AssuranceClass = 'A1' | 'A2' | 'A3';

export type AuthorityRequirement =
  /** local_only operations only: no admission needed. */
  | { kind: 'free' }
  /** Must enter through an admission boundary (external-operation today;
   * internal admission shape lands with P2). */
  | { kind: 'admission'; boundary: 'external' | 'internal' }
  /** Requires a human approval decision at the given assurance class. */
  | { kind: 'approval'; assurance?: AssuranceClass; dualKey?: boolean }
  /** Requires a credential binding scoped to the given level. */
  | { kind: 'binding'; scope: 'tenant' | 'task' };

/** Charter-delegation attributes (folded from EXTERNAL_OPERATION_DELEGATION):
 * whether an exact charter grant may satisfy this operation's authority, the
 * grant's canonical target fields, and the reputational class stamped on the
 * delegated charter action. */
export interface DelegationSpec {
  readonly fields: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly reputational_class: 'A' | 'B';
}

export interface OperationAuthorization {
  readonly effectClass: EffectClass;
  readonly authority: AuthorityRequirement;
  readonly delegable?: DelegationSpec;
  /** Optional charter decision-vocabulary class (payment, sign_contract, …)
   * used for envelope pricing — separate axis from effectClass. */
  readonly actionClass?: string;
  /** False when resolved via the fail-safe default (operation not declared). */
  readonly declared: boolean;
  /** Declaration provenance — see {@link AuthorizationSource}. */
  readonly source: AuthorizationSource;
}

/** A declaration without lookup-time metadata (declared flag, provenance). */
export type AuthorizationRegistryEntry = Omit<OperationAuthorization, 'declared' | 'source'>;
type RegistryEntry = AuthorizationRegistryEntry;

/** Exact-match declarations. */
const OPERATIONS: Readonly<Record<string, RegistryEntry>> = {
  // --- Version control (external-vcs.ts routes these through admission) ---
  'vcs:pr_create': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['repository'],
      optionalFields: ['visibility'],
      reputational_class: 'B',
    },
  },
  'vcs:pr_merge': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['repository', 'branch'],
      optionalFields: ['visibility'],
      reputational_class: 'A',
    },
  },
  'vcs:push': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['repository', 'branch'],
      optionalFields: ['visibility'],
      reputational_class: 'A',
    },
  },
  'vcs:fetch': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'vcs:pull': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'vcs:read_remote': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'vcs:github:read': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
  },
  // --- Browser navigation can reach arbitrary external origins ---
  'browser:goto': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: { fields: ['origin'], reputational_class: 'B' },
  },
  'browser:open_tab': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: { fields: ['origin'], reputational_class: 'B' },
  },
  // --- External messaging / meetings ---
  'service:slack:preset:post_message': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
  },
  'meeting:chat': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
  },
  'meeting:speak': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
  },
  // --- Service execution ---
  'service:mcp': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'mcp:connect': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'mcp:call_tool': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  // --- Provider-backed media / voice (egress + spend) ---
  'voice:transcribe_provider': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'voice:record_sample': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'voice:playback': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'voice:speak': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'video:filter_apply': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  // --- Tenant attestation (delegable via ExternalOperationGrant) ---
  'tenant:attest_provider': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['attested_by', 'basis', 'plan', 'provider', 'tenant_slug', 'training_use'],
      reputational_class: 'A',
    },
  },
};

/** Prefix declarations for operation families built as `prefix${…}`.
 * Longest prefix wins. */
const OPERATION_PREFIXES: Readonly<Record<string, RegistryEntry>> = {
  // email:${op} — send/create_draft/… all mutate or deliver externally.
  'email:': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
  },
  // calendar:${kind} — external calendar writes.
  'calendar:': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  // media:image:${provider.id}:generate — paid external generation.
  'media:image:': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
};

const FAILSAFE_UNDECLARED: RegistryEntry = {
  effectClass: 'external_mutation',
  authority: { kind: 'admission', boundary: 'external' },
};

/** Where a declaration came from. `code` entries are reviewed with the repo;
 * `overlay` comes from knowledge/product/governance/authorization-registry.json
 * (or its customer override); `plugin:<id>` comes from a managed plugin
 * manifest's `authorizations` block. */
export type AuthorizationSource = 'code' | 'overlay' | `plugin:${string}`;

/** Non-code declarations supplied by authorization-overlay.ts. Same shape as
 * the code tables: `operations` are exact ids, `prefixes` end in ':'. */
export interface AuthorizationOverlay {
  readonly source: AuthorizationSource;
  readonly operations: Readonly<Record<string, RegistryEntry>>;
  readonly prefixes: Readonly<Record<string, RegistryEntry>>;
}

let overlayProvider: (() => readonly AuthorizationOverlay[]) | undefined;

/** Registered once by `authorization-overlay.ts` at import time. Without a
 * provider, lookups use code declarations only — missing data resolves to the
 * fail-safe default, never to a weaker authority. Returns the previous
 * provider so tests can restore state; pass `undefined` to clear. */
export function setAuthorizationOverlayProvider(
  provider: (() => readonly AuthorizationOverlay[]) | undefined
): (() => readonly AuthorizationOverlay[]) | undefined {
  const previous = overlayProvider;
  overlayProvider = provider;
  return previous;
}

/** Collision rule enforced at lookup: a code declaration always wins over any
 * overlay/plugin declaration, so data files can add coverage but can never
 * weaken a reviewed entry — including via a longer shadowing prefix.
 * Within the data layers an exact id always beats every prefix regardless of
 * overlay order; among prefixes the longest wins, ties go to the earlier
 * overlay. */
function lookupOverlay(
  operationId: string
): { entry: RegistryEntry; source: AuthorizationSource } | undefined {
  const overlays = overlayProvider?.() ?? [];
  for (const overlay of overlays) {
    const exact = overlay.operations[operationId];
    if (exact) return { entry: exact, source: overlay.source };
  }
  let best: { entry: RegistryEntry; source: AuthorizationSource } | undefined;
  let bestLen = -1;
  for (const overlay of overlays) {
    for (const [prefix, entry] of Object.entries(overlay.prefixes)) {
      if (operationId.startsWith(prefix) && prefix.length > bestLen) {
        best = { entry, source: overlay.source };
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

export function operationAuthorization(operationId: string): OperationAuthorization {
  const exact = OPERATIONS[operationId];
  if (exact) return { ...exact, declared: true, source: 'code' };
  let best: RegistryEntry | undefined;
  let bestLen = -1;
  for (const [prefix, entry] of Object.entries(OPERATION_PREFIXES)) {
    if (operationId.startsWith(prefix) && prefix.length > bestLen) {
      best = entry;
      bestLen = prefix.length;
    }
  }
  if (best) return { ...best, declared: true, source: 'code' };
  const overlaid = lookupOverlay(operationId);
  if (overlaid) return { ...overlaid.entry, declared: true, source: overlaid.source };
  return { ...FAILSAFE_UNDECLARED, declared: false, source: 'code' };
}

/** The code-owned declaration key space. Overlay loaders use this to reject
 * (and loudly warn about) data entries that collide with reviewed code —
 * the lookup already ignores them, the warning tells the author why. */
export function codeOperationPatterns(): {
  readonly operations: readonly string[];
  readonly prefixes: readonly string[];
} {
  return { operations: Object.keys(OPERATIONS), prefixes: Object.keys(OPERATION_PREFIXES) };
}

/** All operation ids/prefixes declared so far (for coverage reporting).
 * Prefix patterns are reported with a trailing '*'. */
export function declaredOperationPatterns(): readonly string[] {
  const code = [...Object.keys(OPERATIONS), ...Object.keys(OPERATION_PREFIXES).map((p) => `${p}*`)];
  const overlaid = (overlayProvider?.() ?? []).flatMap((o) => [
    ...Object.keys(o.operations),
    ...Object.keys(o.prefixes).map((p) => `${p}*`),
  ]);
  return [...code, ...overlaid];
}
