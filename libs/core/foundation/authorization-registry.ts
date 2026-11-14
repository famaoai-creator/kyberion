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
  /** Exactly one of these optional fields must appear in a valid grant. */
  readonly requiredOneOf?: readonly string[];
  readonly reputational_class: 'A' | 'B';
}

export interface OperationAuthorization {
  readonly effectClass: EffectClass;
  readonly authority: AuthorityRequirement;
  readonly delegable?: DelegationSpec;
  /** Optional charter decision-vocabulary class (payment, sign_contract, …)
   * used for envelope pricing — separate axis from effectClass. */
  readonly actionClass?: string;
  /** When this subject's authority path produces a human approval request,
   * the declared approval domain (storage partition) it belongs to — see
   * foundation/approval-domains.ts. Derived by request creation, so the
   * partition comes from the declaration, not a call-site literal. */
  readonly approvalDomain?: string;
  /** Reviewed effect paths whose values must carry host-attested origins
   * (folded from operation-protection.ts PROTECTED_ARGUMENTS). */
  readonly protectedPaths?: readonly (readonly string[])[];
  /** False when resolved via the fail-safe default (operation not declared). */
  readonly declared: boolean;
  /** Declaration provenance — see {@link AuthorizationSource}. */
  readonly source: AuthorizationSource;
}

/** A declaration without lookup-time metadata (declared flag, provenance). */
export type AuthorizationRegistryEntry = Omit<OperationAuthorization, 'declared' | 'source'>;
type RegistryEntry = AuthorizationRegistryEntry;

/** Meeting session grants pin one meeting or one calendar series — a bare
 * platform grant is rejected by `requiredOneOf`. */
const MEETING_SESSION_DELEGATION: DelegationSpec = {
  fields: ['platform'],
  optionalFields: ['meeting_id', 'series_id'],
  requiredOneOf: ['meeting_id', 'series_id'],
  reputational_class: 'B',
};

/** Exact-match declarations. */
const OPERATIONS: Readonly<Record<string, RegistryEntry>> = {
  // Information asset metadata surfaces retain owner/viewer/scope checks in their detail layers.
  'information-asset:catalog:read': { effectClass: 'local_only', authority: { kind: 'free' } },
  'information-asset:coverage:read': { effectClass: 'local_only', authority: { kind: 'free' } },
  'chronos.information-assets.read': { effectClass: 'local_only', authority: { kind: 'free' } },
  'information-asset:catalog:write': {
    effectClass: 'internal_decision',
    authority: { kind: 'admission', boundary: 'internal' },
  },
  // --- Version control (external-vcs.ts routes these through admission) ---
  'vcs:pr_create': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['repository'],
      optionalFields: ['visibility'],
      reputational_class: 'B',
    },
    protectedPaths: [['repository']],
  },
  'vcs:pr_merge': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['repository'],
      optionalFields: ['branch', 'branch_pattern', 'visibility'],
      requiredOneOf: ['branch', 'branch_pattern'],
      reputational_class: 'A',
    },
    protectedPaths: [['repository'], ['baseRefName']],
  },
  'vcs:push': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: ['repository'],
      optionalFields: ['branch', 'branch_pattern', 'visibility'],
      requiredOneOf: ['branch', 'branch_pattern'],
      reputational_class: 'A',
    },
    protectedPaths: [['url'], ['destination']],
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
    delegable: {
      fields: [],
      optionalFields: ['origin'],
      reputational_class: 'B',
    },
    protectedPaths: [['params', 'url']],
  },
  'browser:open_tab': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['origin'],
      reputational_class: 'B',
    },
    protectedPaths: [['params', 'url']],
  },
  // --- External messaging / meetings ---
  'service:slack:preset:post_message': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
    delegable: {
      fields: [],
      optionalFields: ['channel'],
      reputational_class: 'B',
    },
    protectedPaths: [['params', 'channel']],
  },
  'meeting:join': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: MEETING_SESSION_DELEGATION,
    protectedPaths: [
      ['params', 'url'],
      ['params', 'meeting_id'],
      ['params', 'series_id'],
    ],
  },
  'meeting:listen': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: MEETING_SESSION_DELEGATION,
    protectedPaths: [
      ['params', 'meeting_id'],
      ['params', 'series_id'],
    ],
  },
  'meeting:chat': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
    delegable: MEETING_SESSION_DELEGATION,
    protectedPaths: [
      ['params', 'meeting_id'],
      ['params', 'series_id'],
    ],
  },
  'meeting:speak': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
    delegable: MEETING_SESSION_DELEGATION,
    protectedPaths: [
      ['params', 'meeting_id'],
      ['params', 'series_id'],
    ],
  },
  'meeting:leave': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'meeting:status': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  'meeting:check_consent': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  // --- Email ops with reviewed protected paths (narrower than the email: prefix union) ---
  'email:send': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
    protectedPaths: [['params', 'to'], ['params', 'cc'], ['params', 'from'], ['account']],
  },
  'email:create_draft': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
    protectedPaths: [
      ['params', 'to'],
      ['params', 'cc'],
      ['params', 'from'],
    ],
  },
  // --- Admitted information-asset work and its fixed external effect targets ---
  'service:information_asset_work': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    approvalDomain: 'external-operation',
    protectedPaths: [['params']],
  },
  'service:google-workspace:preset:gmail_reply': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    approvalDomain: 'external-operation',
    protectedPaths: [['params']],
  },
  'service:github:preset:resolve_review_thread': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    approvalDomain: 'external-operation',
    protectedPaths: [['params']],
  },
  'service:jira:preset:answer_request_approval': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    approvalDomain: 'external-operation',
    protectedPaths: [['params']],
  },
  'service:jira:preset:transition_issue': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    approvalDomain: 'external-operation',
    protectedPaths: [['params']],
  },
  'service:jira:preset:add_comment': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    approvalDomain: 'external-operation',
    protectedPaths: [['params']],
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
    delegable: {
      fields: [],
      optionalFields: ['platform', 'format', 'content_hash'],
      reputational_class: 'B',
    },
  },
  'voice:speak': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['platform'],
      reputational_class: 'B',
    },
  },
  'video:filter_apply': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
  },
  // --- Network actuator boundary ops (charter-delegable by exact target) ---
  'network:fetch': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['method', 'origin'],
      reputational_class: 'A',
    },
    protectedPaths: [['params', 'url']],
  },
  'network:exposure_check': {
    effectClass: 'external_read',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['origin'],
      reputational_class: 'B',
    },
  },
  // Grants pin the full command string — 'df -h' yes, anything else no.
  'network:shell': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['cmd'],
      reputational_class: 'A',
    },
    protectedPaths: [['params', 'cmd']],
  },
  'network:a2a_send': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    actionClass: 'send_message_external',
    delegable: {
      fields: [],
      optionalFields: ['method', 'peer_id'],
      reputational_class: 'A',
    },
  },
  // --- Calendar mutations (exact entries extend the calendar: prefix family) ---
  'calendar:create_event': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend', 'calendar_id'],
      reputational_class: 'A',
    },
  },
  'calendar:update_event': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend', 'calendar_id', 'event_id'],
      reputational_class: 'A',
    },
  },
  'calendar:delete_event': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend', 'calendar_id', 'event_id'],
      reputational_class: 'A',
    },
  },
  // --- Deployment (grant pins adapter + environment, project optional) ---
  'deployment:deploy_release': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['adapter', 'environment', 'project_name'],
      reputational_class: 'A',
    },
  },
  // --- Media generation (grant pins the paid backend) ---
  'media:generation:generate_image': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend'],
      reputational_class: 'A',
    },
  },
  'media:generation:generate_video': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend'],
      reputational_class: 'A',
    },
  },
  'media:generation:generate_music': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend'],
      reputational_class: 'A',
    },
  },
  'media:generation:run_workflow': {
    effectClass: 'external_mutation',
    authority: { kind: 'admission', boundary: 'external' },
    delegable: {
      fields: [],
      optionalFields: ['backend'],
      reputational_class: 'A',
    },
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
    // Union of PROTECTED_ARGUMENTS email:send / email:create_draft — the extra
    // ['account'] path only binds when the field is present (fail-secure).
    protectedPaths: [['params', 'to'], ['params', 'cc'], ['params', 'from'], ['account']],
  },
  // service:${provider}:… lives in the governed overlay, not here: a code
  // prefix would shadow every data-layer (overlay/plugin) `service:*`
  // declaration — provider plugins are exactly who declares those ops.
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
  // media:video:${provider}:submit|cancel — paid external generation.
  'media:video:': {
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

// ─── Subject axes ────────────────────────────────────────────────────────────
// The unified lookup surface covers four authorization subject axes. Bare ids
// name operations (an `op:`-shaped id is just an operation id — no namespace
// is stripped); `intent:`, `capability:` and
// `verb:` are reserved namespaces bridged to their detail-layer policy
// systems — approval-policy.json intent rules, grant-capability-policy.json
// capabilities, and command-credential-policy.ts verb requirements. Each axis
// keeps its detail semantics in `detail`; the shared envelope (effectClass,
// authority, approvalDomain, declared, source) is what boundaries consume.

export type SubjectAxis = 'operation' | 'intent' | 'capability' | 'verb';

/** Axis-specific detail carried alongside the shared authorization envelope. */
export type AuthorizationDetail =
  /** intent axis: the approval-policy.json rule that declares this intent.
   * Payload-conditional `when` clauses are not evaluated here — the declared
   * authority is the strongest the intent can attract. */
  | { kind: 'approval-policy-rule'; ruleId: string }
  /** capability axis: the grant-capability-policy.json capability key. */
  | { kind: 'grant-capability'; capability: string }
  /** verb axis: the command-credential-policy requirement. */
  | { kind: 'credential-requirement'; requirement: 'none' | 'degrading' | 'required' };

/** A declaration for a non-operation axis (detail layers register these). */
export interface SubjectAxisEntry extends AuthorizationRegistryEntry {
  readonly detail?: AuthorizationDetail;
}

export interface SubjectAuthorization extends OperationAuthorization {
  readonly axis: SubjectAxis;
  /** The full subject string as queried (including the axis prefix). */
  readonly subject: string;
  readonly detail?: AuthorizationDetail;
}

/** A detail layer's view of one axis. Registered once per axis by the module
 * owning that policy system; `resolve` answers axis-local ids and `keys`
 * enumerates declarations for coverage checks. */
export interface SubjectAxisBridge {
  readonly source: AuthorizationSource;
  resolve(id: string): SubjectAxisEntry | undefined;
  keys(): readonly string[];
}

const SUBJECT_AXIS_PREFIXES: Readonly<Record<string, SubjectAxis>> = {
  'intent:': 'intent',
  'capability:': 'capability',
  'verb:': 'verb',
};

const subjectAxisBridges = new Map<SubjectAxis, SubjectAxisBridge>();

/** Registered by each detail layer at import time (approval-policy.ts,
 * grant-capability-policy.ts, command-credential-policy.ts). Without a bridge
 * the axis resolves to its fail-safe, never to a weaker authority. Returns the
 * previous bridge so tests can restore state; pass `undefined` to clear. */
export function setSubjectAxisBridge(
  axis: Exclude<SubjectAxis, 'operation'>,
  bridge: SubjectAxisBridge | undefined
): SubjectAxisBridge | undefined {
  const previous = subjectAxisBridges.get(axis);
  if (bridge) subjectAxisBridges.set(axis, bridge);
  else subjectAxisBridges.delete(axis);
  return previous;
}

/** Per-axis undeclared postures — every axis fails toward more authority, not
 * less. Undeclared intents need a human approval, undeclared capabilities a
 * tenant binding, undeclared verbs a task binding (the same 'required'
 * default command-credential-policy applies). */
const SUBJECT_FAILSAFE: Readonly<Record<SubjectAxis, SubjectAxisEntry>> = {
  operation: FAILSAFE_UNDECLARED,
  intent: { effectClass: 'internal_decision', authority: { kind: 'approval' } },
  capability: {
    effectClass: 'credential_use',
    authority: { kind: 'binding', scope: 'tenant' },
  },
  verb: {
    effectClass: 'credential_use',
    authority: { kind: 'binding', scope: 'task' },
    detail: { kind: 'credential-requirement', requirement: 'required' },
  },
};

function parseSubject(subject: string): { axis: SubjectAxis; id: string } {
  for (const [prefix, axis] of Object.entries(SUBJECT_AXIS_PREFIXES)) {
    if (subject.startsWith(prefix)) {
      const id = subject.slice(prefix.length);
      // An empty axis-local id is not a declared subject — it resolves as an
      // operation-shaped fail-safe rather than matching anything.
      if (id) return { axis, id };
      return { axis, id: '' };
    }
  }
  return { axis: 'operation', id: subject };
}

export function subjectAuthorization(subject: string): SubjectAuthorization {
  const { axis, id } = parseSubject(subject);
  if (axis === 'operation') {
    return { ...operationAuthorization(subject), axis, subject };
  }
  const bridge = subjectAxisBridges.get(axis);
  const entry = id ? bridge?.resolve(id) : undefined;
  if (entry) {
    return { ...entry, declared: true, source: bridge!.source, axis, subject };
  }
  const failSafe = SUBJECT_FAILSAFE[axis];
  return {
    ...failSafe,
    declared: false,
    source: 'code',
    axis,
    subject,
    ...(failSafe.detail ? { detail: failSafe.detail } : {}),
  };
}

/** Declared subject ids for one axis (axis-local, without the prefix) —
 * the coverage surface boundary gates consume. */
export function declaredSubjectKeys(axis: Exclude<SubjectAxis, 'operation'>): readonly string[] {
  return subjectAxisBridges.get(axis)?.keys() ?? [];
}

// ─── Declaration enumeration ─────────────────────────────────────────────────
// Serialization (authorization-policy-document.ts) needs every declaration —
// including shadowed ones — with enough provenance to reproduce precedence
// without registry internals: layer_rank orders layers (code first), the
// overlay_index preserves each data layer's source order for prefix ties.

/** One declared authorization entry as enumerated for serialization. */
export interface DeclaredAuthorization {
  readonly axis: SubjectAxis;
  /** Operation ids/prefixes verbatim; non-operation axes carry the axis
   * prefix (`intent:<id>`) so the subject string is directly usable. */
  readonly subject: string;
  readonly match: 'exact' | 'prefix';
  readonly entry: SubjectAxisEntry;
  readonly source: AuthorizationSource;
  /** 0 = code, 1 = file overlay, 2 = plugin manifest. Code declarations
   * always outrank data declarations regardless of pattern shape. */
  readonly layerRank: 0 | 1 | 2;
  /** Position of the declaring overlay in provider order — tie-break for
   * equal-length data prefixes; 0 for code entries. */
  readonly overlayIndex: number;
}

function sourceLayerRank(source: AuthorizationSource): 0 | 1 | 2 {
  if (source === 'code') return 0;
  return source === 'overlay' ? 1 : 2;
}

/** Every declaration across all axes and layers, shadowed entries included.
 * Order is deterministic: code first, then overlays in provider order, then
 * subject axes in a fixed axis order. */
export function declaredAuthorizationEntries(): readonly DeclaredAuthorization[] {
  const out: DeclaredAuthorization[] = [];
  for (const [id, entry] of Object.entries(OPERATIONS)) {
    out.push({
      axis: 'operation',
      subject: id,
      match: 'exact',
      entry,
      source: 'code',
      layerRank: 0,
      overlayIndex: 0,
    });
  }
  for (const [prefix, entry] of Object.entries(OPERATION_PREFIXES)) {
    out.push({
      axis: 'operation',
      subject: prefix,
      match: 'prefix',
      entry,
      source: 'code',
      layerRank: 0,
      overlayIndex: 0,
    });
  }
  const overlays = overlayProvider?.() ?? [];
  overlays.forEach((overlay, overlayIndex) => {
    const layerRank = sourceLayerRank(overlay.source);
    for (const [id, entry] of Object.entries(overlay.operations)) {
      out.push({
        axis: 'operation',
        subject: id,
        match: 'exact',
        entry,
        source: overlay.source,
        layerRank,
        overlayIndex,
      });
    }
    for (const [prefix, entry] of Object.entries(overlay.prefixes)) {
      out.push({
        axis: 'operation',
        subject: prefix,
        match: 'prefix',
        entry,
        source: overlay.source,
        layerRank,
        overlayIndex,
      });
    }
  });
  const subjectAxes: readonly Exclude<SubjectAxis, 'operation'>[] = [
    'intent',
    'capability',
    'verb',
  ];
  for (const axis of subjectAxes) {
    const bridge = subjectAxisBridges.get(axis);
    if (!bridge) continue;
    const layerRank = sourceLayerRank(bridge.source);
    for (const key of bridge.keys()) {
      const entry = bridge.resolve(key);
      if (!entry) continue;
      out.push({
        axis,
        subject: `${axis}:${key}`,
        match: 'exact',
        entry,
        source: bridge.source,
        layerRank,
        overlayIndex: 0,
      });
    }
  }
  return out;
}

/** The per-axis undeclared posture, exposed so serializers can emit explicit
 * default policies instead of leaving fail-safes implicit. */
export function subjectAxisFailSafe(axis: SubjectAxis): SubjectAxisEntry {
  return SUBJECT_FAILSAFE[axis];
}
