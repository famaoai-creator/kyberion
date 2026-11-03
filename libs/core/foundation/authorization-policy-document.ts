/**
 * P4 of the unified authorization design (docs/UNIFIED_AUTHORIZATION_POLICY_DESIGN.ja.md
 * §3.5 + phase table): fix the registry's serialization form so every declaration
 * axis maps to Cedar-style permit/forbid conditions — a future engine swap then
 * needs no declaration rewrite.
 *
 * Three contracts live here:
 *
 * 1. **Normalized authorization request** — `principal` (the credential
 *    execution identity) + `action` (subject incl. effect class) + `resource` +
 *    `context` (envelope, lineage, assurance). Host-assembled and insulated
 *    from model input; this type is the contract, not prose.
 * 2. **3-value decision** — `permit | forbid | require_approval{...}`.
 *    `binding` without the binding is `forbid` (no approval path exists);
 *    `degrading` credentials degrade explicitly (`permit{degraded}`) via the
 *    detail record rather than silently.
 * 3. **Policy document** — every declaration (all axes, all layers, per-axis
 *    fail-safes included as `defaults`) serialized with enough provenance
 *    (`layerRank`, `overlayIndex`) to reproduce registry precedence without
 *    registry access. `evaluatePolicyDocument` is the reference evaluator over
 *    the document alone — the meaning-preservation gate runs it against the
 *    live registry's resolution semantics.
 *
 * `cedarDocumentText` renders the document as Cedar-style statements:
 * `permit ... when` / `forbid ... unless` plus `@` annotations carrying id,
 * effect_class, the third decision value and requires_lineage. Conformance is
 * to the FORM only — no Cedar/Dogwood engine is adopted.
 */
import {
  declaredAuthorizationEntries,
  subjectAxisFailSafe,
  type AssuranceClass,
  type AuthorityRequirement,
  type AuthorizationDetail,
  type SubjectAxisEntry,
  type AuthorizationSource,
  type DeclaredAuthorization,
  type EffectClass,
  type SubjectAxis,
} from './authorization-registry.js';

// ─── Normalized authorization request ───────────────────────────────────────

export interface NormalizedAuthorizationRequest {
  /** The credential execution identity — assembled by the host, never
   * accepted raw from model output. */
  readonly principal: {
    readonly id: string;
    readonly kind?: 'human' | 'agent' | 'service';
  };
  /** The subject under authorization: an op id, or an axis-prefixed subject
   * (`intent:<id>`, `capability:<id>`, `verb:<id>`). */
  readonly action: { readonly subject: string };
  readonly resource?: {
    readonly tenant?: string;
    readonly target?: string;
  };
  readonly context: {
    /** A prior approval decision exists for this request. */
    readonly approved?: boolean;
    /** Assurance class the approval was rendered at (A3 strongest). */
    readonly assurance?: AssuranceClass;
    /** The approval required and received a second key. */
    readonly dualKey?: boolean;
    /** An admission boundary granted this request. */
    readonly admissionGranted?: 'external' | 'internal';
    /** Credential binding scope held by the principal. A tenant binding
     * satisfies a task-scope requirement. */
    readonly bindingScope?: 'tenant' | 'task';
    /** Delegation/claim lineage chain — non-empty when lineage is attested. */
    readonly lineage?: readonly string[];
    /** Opaque envelope passthrough for host-specific context. */
    readonly envelope?: Readonly<Record<string, unknown>>;
  };
}

/** Validates and completes a request — the only construction path, so the
 * contract stays honest (principal id and subject are mandatory). */
export function normalizeAuthorizationRequest(input: {
  principal: { id: string; kind?: 'human' | 'agent' | 'service' };
  action: { subject: string };
  resource?: { tenant?: string; target?: string };
  context?: NormalizedAuthorizationRequest['context'];
}): NormalizedAuthorizationRequest {
  if (!input.principal.id) throw new Error('[AUTHZ_REQUEST_INVALID] principal.id is required');
  if (!input.action.subject) throw new Error('[AUTHZ_REQUEST_INVALID] action.subject is required');
  return { ...input, context: input.context ?? {} };
}

// ─── 3-value decision ────────────────────────────────────────────────────────

export type AuthorizationDecision =
  | { readonly kind: 'permit'; readonly degraded?: boolean }
  | { readonly kind: 'forbid'; readonly reason: string }
  | {
      readonly kind: 'require_approval';
      readonly assurance?: AssuranceClass;
      readonly dualKey?: boolean;
      readonly approvalDomain?: string;
    };

// ─── Serialized policy shape ────────────────────────────────────────────────

/** Conditions a request must satisfy for the declaration to grant `permit`.
 * An empty object means unconditional. */
export interface GrantedWhen {
  readonly approved?: { readonly assurance?: AssuranceClass; readonly dualKey?: boolean };
  readonly admitted?: 'external' | 'internal';
  readonly binding_scope?: 'tenant' | 'task';
}

export interface SerializedAuthorizationPolicy {
  /** Stable identifier: `op:<id>` / `op-prefix:<p>` / `<axis>:<key>` /
   * `default:<axis>`. */
  readonly id: string;
  readonly subject_axis: SubjectAxis;
  /** Operation declarations: the bare id/prefix. Other axes: the
   * axis-prefixed subject (`intent:<key>`). */
  readonly subject: string;
  readonly match: 'exact' | 'prefix';
  readonly effect_class: EffectClass;
  readonly granted_when: GrantedWhen;
  /** Decision applied when granted_when is not satisfied. */
  readonly unmet_decision: AuthorizationDecision;
  /** Optional charter decision-vocabulary class (payment, sign_contract, …)
   * used for envelope pricing — separate axis from effect_class. */
  readonly action_class?: string;
  /** Charter-delegation contract, preserved verbatim — a future engine needs
   * the grant's canonical target fields, not just the lineage flag. */
  readonly delegable?: {
    readonly fields: readonly string[];
    readonly optionalFields?: readonly string[];
    /** Exactly one of these optional fields must appear in a valid grant. */
    readonly requiredOneOf?: readonly string[];
    readonly reputational_class: 'A' | 'B';
  };
  /** Declaration-level lineage marker (Dogwood `when temporal` analogue):
   * charter-delegable operations require a claim lineage on the delegated
   * path. True iff the declaration carries a DelegationSpec. */
  readonly requires_lineage: boolean;
  readonly approval_domain?: string;
  readonly protected_paths?: readonly (readonly string[])[];
  readonly detail?: AuthorizationDetail;
  readonly provenance: {
    readonly source: AuthorizationSource;
    readonly layer_rank: 0 | 1 | 2;
    readonly overlay_index: number;
    readonly declared: boolean;
  };
}

export interface AuthorizationPolicyDocument {
  readonly version: 1;
  /** Per-axis fail-safe policies — the undeclared posture is explicit data,
   * not implicit evaluator behavior. */
  readonly defaults: Readonly<Record<SubjectAxis, SerializedAuthorizationPolicy>>;
  readonly policies: readonly SerializedAuthorizationPolicy[];
}

// ─── authority → conditions/decision mapping ─────────────────────────────────

const ASSURANCE_RANK: Readonly<Record<AssuranceClass, number>> = { A1: 1, A2: 2, A3: 3 };

function isDegradingCredential(detail: AuthorizationDetail | undefined): boolean {
  return detail?.kind === 'credential-requirement' && detail.requirement === 'degrading';
}

/** Map an authority requirement to the granted conditions + the decision when
 * they are unmet. `declared` gates approvalDomain derivation — an undeclared
 * fail-safe must never supply a routing domain (the admission-unify lesson). */
export function authorityPolicyShape(
  entry: SubjectAxisEntry,
  opts: { declared: boolean }
): { granted_when: GrantedWhen; unmet_decision: AuthorizationDecision } {
  const authority: AuthorityRequirement = entry.authority;
  switch (authority.kind) {
    case 'free':
      return { granted_when: {}, unmet_decision: { kind: 'permit' } };
    case 'approval':
      return {
        granted_when: {
          approved: { assurance: authority.assurance, dualKey: authority.dualKey },
        },
        unmet_decision: {
          kind: 'require_approval',
          ...(authority.assurance ? { assurance: authority.assurance } : {}),
          ...(authority.dualKey ? { dualKey: true } : {}),
          ...(opts.declared && entry.approvalDomain
            ? { approvalDomain: entry.approvalDomain }
            : {}),
        },
      };
    case 'admission':
      return {
        granted_when: { admitted: authority.boundary },
        unmet_decision: {
          kind: 'require_approval',
          ...(opts.declared && entry.approvalDomain
            ? { approvalDomain: entry.approvalDomain }
            : {}),
        },
      };
    case 'binding':
      return {
        granted_when: { binding_scope: authority.scope },
        unmet_decision: isDegradingCredential(entry.detail)
          ? { kind: 'permit', degraded: true }
          : { kind: 'forbid', reason: `credential binding required at ${authority.scope} scope` },
      };
  }
}

// ─── Serialization ───────────────────────────────────────────────────────────

function policyId(axis: SubjectAxis, subject: string, match: 'exact' | 'prefix'): string {
  if (axis === 'operation') return match === 'prefix' ? `op-prefix:${subject}` : `op:${subject}`;
  // Non-operation subjects already carry the axis prefix (`intent:<key>`).
  return subject;
}

function serializeDeclaration(d: DeclaredAuthorization): SerializedAuthorizationPolicy {
  const { granted_when, unmet_decision } = authorityPolicyShape(d.entry, { declared: true });
  return {
    id: policyId(d.axis, d.subject, d.match),
    subject_axis: d.axis,
    subject: d.subject,
    match: d.match,
    effect_class: d.entry.effectClass,
    granted_when,
    unmet_decision,
    ...(d.entry.actionClass ? { action_class: d.entry.actionClass } : {}),
    ...(d.entry.delegable ? { delegable: d.entry.delegable } : {}),
    requires_lineage: d.entry.delegable !== undefined,
    ...(d.entry.approvalDomain ? { approval_domain: d.entry.approvalDomain } : {}),
    ...(d.entry.protectedPaths ? { protected_paths: d.entry.protectedPaths } : {}),
    ...(d.entry.detail ? { detail: d.entry.detail } : {}),
    provenance: {
      source: d.source,
      layer_rank: d.layerRank,
      overlay_index: d.overlayIndex,
      declared: true,
    },
  };
}

function serializeFailSafe(axis: SubjectAxis): SerializedAuthorizationPolicy {
  const entry = subjectAxisFailSafe(axis);
  const { granted_when, unmet_decision } = authorityPolicyShape(entry, { declared: false });
  return {
    id: `default:${axis}`,
    subject_axis: axis,
    subject: '*',
    match: 'prefix',
    effect_class: entry.effectClass,
    granted_when,
    unmet_decision,
    requires_lineage: entry.delegable !== undefined,
    ...(entry.detail ? { detail: entry.detail } : {}),
    provenance: { source: 'code', layer_rank: 0, overlay_index: 0, declared: false },
  };
}

const SUBJECT_AXES: readonly SubjectAxis[] = ['operation', 'intent', 'capability', 'verb'];

/** Serialize every declaration across all axes and layers into the canonical
 * document. Deterministic: enumeration order is fixed by the registry. */
export function serializeRegistryDocument(): AuthorizationPolicyDocument {
  return {
    version: 1,
    defaults: {
      operation: serializeFailSafe('operation'),
      intent: serializeFailSafe('intent'),
      capability: serializeFailSafe('capability'),
      verb: serializeFailSafe('verb'),
    },
    policies: declaredAuthorizationEntries().map(serializeDeclaration),
  };
}

// ─── Document evaluation ─────────────────────────────────────────────────────

const SUBJECT_AXIS_PREFIXES: Readonly<Record<string, SubjectAxis>> = {
  'intent:': 'intent',
  'capability:': 'capability',
  'verb:': 'verb',
};

function parseRequestSubject(subject: string): { axis: SubjectAxis; id: string } {
  for (const [prefix, axis] of Object.entries(SUBJECT_AXIS_PREFIXES)) {
    if (subject.startsWith(prefix)) return { axis, id: subject.slice(prefix.length) };
  }
  return { axis: 'operation', id: subject };
}

function policyMatches(
  policy: SerializedAuthorizationPolicy,
  axis: SubjectAxis,
  id: string,
  subject: string
): boolean {
  if (policy.subject_axis !== axis) return false;
  // Operation policies carry the bare id; other axes carry the axis-prefixed
  // subject, so the match target differs per axis.
  const target = axis === 'operation' ? id : subject;
  return policy.match === 'prefix' ? target.startsWith(policy.subject) : policy.subject === target;
}

/** Reproduce registry precedence. `lookupOverlay` treats the whole data
 * plane as ONE flat layer: any data exact beats every data prefix, the
 * longest prefix wins, provider order (overlay_index) breaks ties — there is
 * no overlay-vs-plugin tier inside data, only code-vs-data. The rank is
 * therefore [code?0:1, exact?0:1, -len(subject), overlay_index]. */
function pickWinningPolicy(
  candidates: readonly SerializedAuthorizationPolicy[]
): SerializedAuthorizationPolicy | undefined {
  let best: SerializedAuthorizationPolicy | undefined;
  let bestRank: readonly [number, number, number, number] | undefined;
  for (const policy of candidates) {
    const rank: readonly [number, number, number, number] = [
      policy.provenance.layer_rank === 0 ? 0 : 1,
      policy.match === 'exact' ? 0 : 1,
      -policy.subject.length,
      policy.provenance.overlay_index,
    ];
    if (
      !bestRank ||
      rank[0] < bestRank[0] ||
      (rank[0] === bestRank[0] &&
        (rank[1] < bestRank[1] ||
          (rank[1] === bestRank[1] &&
            (rank[2] < bestRank[2] || (rank[2] === bestRank[2] && rank[3] < bestRank[3])))))
    ) {
      best = policy;
      bestRank = rank;
    }
  }
  return best;
}

function conditionsMet(
  granted: GrantedWhen,
  context: NormalizedAuthorizationRequest['context']
): boolean {
  if (granted.approved) {
    if (!context.approved) return false;
    const required = granted.approved;
    if (
      required.assurance &&
      (!context.assurance || ASSURANCE_RANK[context.assurance] < ASSURANCE_RANK[required.assurance])
    )
      return false;
    if (required.dualKey && !context.dualKey) return false;
  }
  if (granted.admitted && context.admissionGranted !== granted.admitted) return false;
  if (granted.binding_scope) {
    const held = context.bindingScope;
    if (
      granted.binding_scope === 'tenant' ? held !== 'tenant' : held !== 'task' && held !== 'tenant'
    )
      return false;
  }
  return true;
}

/** Evaluate one registry entry against a request context — the reference
 * path tests compare against document evaluation: same mapping function, but
 * this one reads the live registry resolution instead of serialized data. */
export function evaluateEntry(
  entry: SubjectAxisEntry,
  opts: { declared: boolean },
  context: NormalizedAuthorizationRequest['context']
): AuthorizationDecision {
  const { granted_when, unmet_decision } = authorityPolicyShape(entry, opts);
  if (Object.keys(granted_when).length === 0 || conditionsMet(granted_when, context))
    return { kind: 'permit' };
  return unmet_decision;
}

/** Reference evaluator over the serialized document alone — the
 * meaning-preservation gate compares this against decisions derived from live
 * registry resolution. */
export function evaluatePolicyDocument(
  doc: AuthorizationPolicyDocument,
  request: NormalizedAuthorizationRequest
): AuthorizationDecision {
  const { axis, id } = parseRequestSubject(request.action.subject);
  // An empty axis-local id is never a declared subject (registry semantics):
  // it must not match any declaration, even a malformed empty-key one.
  const candidates = id
    ? doc.policies.filter((p) => policyMatches(p, axis, id, request.action.subject))
    : [];
  const winner = pickWinningPolicy(candidates) ?? doc.defaults?.[axis];
  if (!winner) return { kind: 'forbid', reason: `no policy or default declared for axis ${axis}` };
  if (
    Object.keys(winner.granted_when).length === 0 ||
    conditionsMet(winner.granted_when, request.context)
  )
    return { kind: 'permit' };
  return winner.unmet_decision;
}

// ─── Cedar-style rendering ───────────────────────────────────────────────────
// Emit VALID Cedar, not Cedar-flavored pseudocode:
// - `>=` is long-only → assurance renders as context.assurance_level (A1=1…A3=3)
// - `in` is entity-hierarchy membership → the task-scope pair uses `||`
// - Action::"x" has no glob → prefix matches bind the request subject string
//   as context.action_subject and use `like` (Cedar string pattern matching)
// - `!`, `==`, `&&`, `||`, `like`, and unconstrained `action` are all valid.

function cedarEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Split a policy's when-conditions into the subject-match clause and the
 * granted conditions — kept separate because negating the CONJUNCTION would
 * be wrong: a forbid-unless over `subject-match && conds` would deny every
 * request outside the prefix, and a fail-safe unless over `declared==false
 * && conds` would deny every declared request. */
function cedarConditionParts(policy: SerializedAuthorizationPolicy): {
  readonly subjectClauses: readonly string[];
  readonly grantedClauses: readonly string[];
} {
  const granted = policy.granted_when;
  const subjectClauses: string[] = [];
  // Cedar evaluates every statement independently — there is no "only when
  // nothing else matched". Fail-safe defaults therefore gate on
  // context.declared == false so they cannot deny requests a declared policy
  // already adjudicated.
  if (policy.id.startsWith('default:')) {
    subjectClauses.push('context.declared == false');
  }
  if (policy.match === 'prefix' && policy.subject !== '*') {
    subjectClauses.push(`context.action_subject like "${cedarEscape(policy.subject)}*"`);
  }
  const grantedClauses: string[] = [];
  if (granted.approved) {
    const required = granted.approved;
    grantedClauses.push(
      `context.approved == true${required.assurance ? ` && context.assurance_level >= ${ASSURANCE_RANK[required.assurance]}` : ''}${required.dualKey ? ' && context.dual_key == true' : ''}`
    );
  }
  if (granted.admitted) grantedClauses.push(`context.admitted == "${granted.admitted}"`);
  if (granted.binding_scope) {
    grantedClauses.push(
      granted.binding_scope === 'task'
        ? `(context.binding_scope == "task" || context.binding_scope == "tenant")`
        : `context.binding_scope == "tenant"`
    );
  }
  return { subjectClauses, grantedClauses };
}

function joinClauses(...parts: readonly (readonly string[])[]): string {
  return parts.flat().join(' && ');
}

function negate(joined: string): string {
  return `!(${joined})`;
}

function cedarAnnotations(policy: SerializedAuthorizationPolicy): string[] {
  const annotations = [
    `  @id("${cedarEscape(policy.id)}")`,
    `  @effect_class("${policy.effect_class}")`,
  ];
  if (policy.requires_lineage) annotations.push('  @requires_lineage');
  if (policy.approval_domain)
    annotations.push(`  @approval_domain("${cedarEscape(policy.approval_domain)}")`);
  if (policy.action_class)
    annotations.push(`  @action_class("${cedarEscape(policy.action_class)}")`);
  annotations.push(`  @source("${policy.provenance.source}")`);
  if (!policy.provenance.declared) annotations.push('  @fail_safe');
  return annotations;
}

/** Render one policy as Cedar statements. Unmet `require_approval`/`forbid`
 * paths render as `forbid when { subject-match && !conditions }` (or
 * `unless` for exact subjects, where the action slot already constrains the
 * match) carrying a @decision annotation with the terms; degraded permits
 * render a second annotated permit statement for the unmet path. */
export function cedarPolicyText(policy: SerializedAuthorizationPolicy): string {
  const scope =
    policy.match === 'exact'
      ? `principal, action == Action::"${cedarEscape(policy.subject)}", resource`
      : 'principal, action, resource';
  const { subjectClauses, grantedClauses } = cedarConditionParts(policy);
  const permitWhen = joinClauses(subjectClauses, grantedClauses);
  const annotations = cedarAnnotations(policy);
  const decisionTag = (d: AuthorizationDecision): string => {
    if (d.kind === 'permit') return d.degraded ? 'permit_degraded' : 'permit';
    if (d.kind === 'forbid') return 'forbid';
    const terms = [d.assurance, d.dualKey ? 'dual_key' : undefined, d.approvalDomain]
      .filter(Boolean)
      .map((t) => cedarEscape(String(t)))
      .join(',');
    return terms ? `require_approval(${terms})` : 'require_approval';
  };
  const lines: string[] = [...annotations];
  lines.push(permitWhen ? `permit(${scope}) when { ${permitWhen} };` : `permit(${scope});`);
  if (policy.unmet_decision.kind !== 'permit') {
    lines.push(`  @decision("${decisionTag(policy.unmet_decision)}")`);
    if (policy.match === 'exact' && grantedClauses.length > 0) {
      // Exact subjects: the action slot constrains the match, so `unless`
      // negates only the granted conditions.
      lines.push(`forbid(${scope}) unless { ${joinClauses(grantedClauses)} };`);
    } else {
      const unmet = grantedClauses.length
        ? joinClauses(subjectClauses, [negate(joinClauses(grantedClauses))])
        : joinClauses(subjectClauses);
      lines.push(unmet ? `forbid(${scope}) when { ${unmet} };` : `forbid(${scope});`);
    }
  } else if (policy.unmet_decision.degraded && grantedClauses.length > 0) {
    const degradedWhen = joinClauses(subjectClauses, [negate(joinClauses(grantedClauses))]);
    lines.push(
      `  @decision("${decisionTag(policy.unmet_decision)}")`,
      `permit(${scope}) when { ${degradedWhen} };`
    );
  }
  return lines.join('\n');
}

/** Render the whole document: defaults first (fail-safe posture visible at
 * the top), then every declaration. */
export function cedarDocumentText(doc: AuthorizationPolicyDocument): string {
  const parts: string[] = [
    '// Kyberion authorization policy document — Cedar-compatible form (P4).',
    '// require_approval is not a Cedar effect: it renders as forbid-unless',
    '// with a @decision annotation carrying the approval terms.',
    '// context bindings: action_subject := request.action.subject;',
    '// declared := the request subject matched a declaration;',
    '// assurance_level := A1→1, A2→2, A3→3 (Cedar >= is long-only).',
  ];
  for (const axis of SUBJECT_AXES) {
    parts.push(cedarPolicyText(doc.defaults[axis]));
  }
  for (const policy of doc.policies) {
    parts.push(cedarPolicyText(policy));
  }
  return parts.join('\n\n') + '\n';
}
