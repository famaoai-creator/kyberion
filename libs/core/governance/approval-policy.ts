import * as customerResolver from '../authn/stance-resolver.js';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { isInjectionSuspected } from './injection-signal.js';
import { resolveConfiguredPosture } from './security-screen.js';
import { createLogger } from '../logger.js';
import type { ApprovalAssuranceLevel, ApprovalAssuranceMode } from './approval-assurance.js';
import {
  setSubjectAxisBridge,
  type AssuranceClass,
  type AuthorityRequirement,
  type SubjectAxisEntry,
} from '../foundation/authorization-registry.js';

const logger = createLogger('approval-policy');

export interface ApprovalPolicyRule {
  id: string;
  intent_ids?: string[];
  when?: {
    payload_field?: string;
    any_of?: string[];
  };
  requires_approval: boolean;
  missing_requirements?: string[];
  /**
   * HOTL: whether a signed charter grant may satisfy this rule's approval.
   * Absent = derived (rules requiring `dual_key_confirmation` default to
   * ineligible). Runtime floors (`mandatoryApproval`, posture overrides)
   * stay ineligible regardless of this flag.
   */
  charter_eligible?: boolean;
  /** HA-07: the weakest decider proof a human-only request created by this rule accepts. */
  min_assurance?: ApprovalAssuranceLevel;
}

/**
 * Danger-pattern rule for intentIds that matched no declared rule — the
 * governed-data replacement for what used to be hard-coded regexes. A rule
 * matches when ANY of: `intent_id_pattern` (case-insensitive regex over the
 * intent id), `payload_present_fields` (truthy payload field), or
 * `payload_patterns` (case-insensitive regex over one of the named fields).
 */
interface ApprovalPolicyFallbackRule {
  id: string;
  intent_id_pattern?: string;
  payload_present_fields?: string[];
  payload_patterns?: Array<{ fields: string[]; pattern: string }>;
  missing_requirements?: string[];
  charter_eligible?: boolean;
}

interface ApprovalPolicyFile {
  version?: string;
  /** See {@link resolveSeparationOfDutiesPolicy}. */
  separation_of_duties?: {
    enabled: boolean;
  };
  /** See {@link resolvePolicyApprovalAssuranceMode}. */
  assurance_mode?: ApprovalAssuranceMode;
  /** See {@link resolvePasskeyEnrollmentCooldownHours}. */
  passkey_enrollment_cooldown_hours?: number;
  rules?: ApprovalPolicyRule[];
  /**
   * Governed danger-pattern rules for intentIds that matched no declared
   * rule. When absent (e.g. a customer overlay predating the section) the
   * built-in {@link HARD_CODED_DANGEROUS_RULES} apply — fail-closed.
   */
  fallback_rules?: ApprovalPolicyFallbackRule[];
  defaults?: {
    requires_approval?: boolean;
  };
}

export interface ApprovalPolicyResolution {
  requiresApproval: boolean;
  missingRequirements: string[];
  matchedRuleId?: string;
  /** A runtime security floor that delegated authority or session grants cannot waive. */
  mandatoryApproval?: boolean;
  /**
   * HOTL: whether the matched policy admits charter-grant satisfaction.
   * Derived from the rule's `charter_eligible`, defaulting to
   * `!missingRequirements.includes('dual_key_confirmation')`. Undefined means
   * the resolution carried no policy decision (defaults path) — the caller
   * applies its own floor.
   */
  charterEligible?: boolean;
  /** The matched rule's `min_assurance` (HA-07). */
  minAssurance?: ApprovalAssuranceLevel;
}

const approvalPolicyCatalog = defineCatalog<ApprovalPolicyFile>({
  id: 'approval-policy',
  path: () => {
    const customerPolicyPath = customerResolver.stanceRoot('policy/approval-policy.json');
    const fallbackPath = assertSafeRepositoryPath(
      pathResolver.knowledge('product/governance/approval-policy.json')
    );
    if (!customerPolicyPath) return fallbackPath;
    const safeCustomerPath = assertSafeRepositoryPath(customerPolicyPath, {
      allowMissingLeaf: true,
    });
    return safeExistsSync(safeCustomerPath) ? safeCustomerPath : fallbackPath;
  },
  schema: pathResolver.knowledge('product/schemas/approval-policy.schema.json'),
});

/**
 * Built-in danger-pattern rules — used only when the loaded policy file does
 * not declare `fallback_rules` (e.g. a customer overlay predating the
 * section). They intentionally ship `charter_eligible: false`, matching the
 * governed default in `approval-policy.json`.
 */
const HARD_CODED_DANGEROUS_RULES: ApprovalPolicyFallbackRule[] = [
  {
    id: 'fallback-dangerous-shell',
    intent_id_pattern: 'shell|command|exec|run_shell|bash',
    payload_patterns: [
      {
        fields: ['command', 'cmd', 'script'],
        pattern:
          '(?:rm\\s+-rf|curl\\s+.*\\|\\s*(?:sh|bash|zsh|fish)|wget\\s+.*\\|\\s*(?:sh|bash|zsh|fish)|base64\\s+-(?:d|decode)|eval\\s|\\bexec\\s*\\()',
      },
    ],
    missing_requirements: ['approval_confirmation'],
    charter_eligible: false,
  },
  {
    id: 'fallback-dangerous-egress',
    intent_id_pattern: 'egress|network|http|https|fetch|request',
    payload_present_fields: ['url', 'base_url'],
    missing_requirements: ['approval_confirmation'],
    charter_eligible: false,
  },
  {
    id: 'fallback-dangerous-secret',
    intent_id_pattern: 'secret|vault:write|auth:grant|credential|token|password',
    missing_requirements: ['dual_key_confirmation'],
    charter_eligible: false,
  },
  {
    id: 'fallback-dangerous-deploy',
    intent_id_pattern: 'deploy|release|publish|production|restart|stop|start|delete|destroy|remove',
    payload_patterns: [
      {
        fields: ['operation', 'action'],
        pattern: '(?:restart|stop|start|delete|destroy|remove|wipe|purge)',
      },
    ],
    missing_requirements: ['approval_confirmation'],
    charter_eligible: false,
  },
];

function compileFallbackMatcher(
  rule: ApprovalPolicyFallbackRule
): (input: { intentId?: string; payload?: Record<string, unknown> }) => boolean {
  // A pattern that fails to compile degrades to "always match" — a malformed
  // policy must fail closed (require approval), never silently widen.
  const safeRegex = (source?: string): RegExp | null => {
    if (!source) return null;
    try {
      return new RegExp(source, 'i');
    } catch {
      return /.*/;
    }
  };
  const intentRe = safeRegex(rule.intent_id_pattern);
  const presentFields = rule.payload_present_fields || [];
  const payloadMatchers = (rule.payload_patterns || []).map((pp) => ({
    fields: pp.fields || [],
    re: safeRegex(pp.pattern),
  }));
  return ({ intentId, payload }) => {
    if (intentRe && intentRe.test(intentId || '')) return true;
    if (presentFields.some((field) => Boolean(payload?.[field]))) return true;
    return payloadMatchers.some(
      (matcher) =>
        matcher.re &&
        matcher.fields.some((field) => matcher.re.test(String(payload?.[field] ?? '')))
    );
  };
}

export function loadApprovalPolicy(): ApprovalPolicyFile {
  return approvalPolicyCatalog.load();
}

/**
 * Separation of duties for approval decisions (default off).
 *
 * When enabled, an approving decision whose decider identity equals the
 * request's requester identity is refused — the choke point is
 * `decideApprovalRequest` in `approval-store.ts`. The setting lives in
 * `approval-policy.json` and therefore follows that file's existing scoping:
 * the active stance overlay (`knowledge/personal/stances/{slug}/policy/approval-policy.json`)
 * replaces the product default wholesale. There is no per-tenant or
 * per-organization override.
 */
/** Whether any approval-policy.json exists (customer overlay or product default). */
function approvalPolicyFilePresent(): boolean {
  const customerPolicyPath = customerResolver.stanceRoot('policy/approval-policy.json');
  const candidates = [
    ...(customerPolicyPath ? [customerPolicyPath] : []),
    pathResolver.knowledge('product/governance/approval-policy.json'),
  ];
  return candidates.some((candidate) =>
    safeExistsSync(assertSafeRepositoryPath(candidate, { allowMissingLeaf: true }))
  );
}

let missingPolicyLogged = false;

export function resolveSeparationOfDutiesPolicy(): { enabled: boolean } {
  // No policy file at all (e.g. a scratch root without the knowledge tree):
  // use the shipped default — separation of duties off — which grants
  // nothing beyond today's behaviour. Only a file that is present but
  // unreadable or schema-invalid fails closed below.
  if (!approvalPolicyFilePresent()) {
    if (!missingPolicyLogged) {
      missingPolicyLogged = true;
      logger.debug(
        'approval-policy.json not found — separation_of_duties uses the shipped default (off)'
      );
    }
    return { enabled: false };
  }
  let policy: ApprovalPolicyFile;
  try {
    policy = loadApprovalPolicy();
  } catch (error) {
    // A present but unreadable / schema-invalid policy fails closed, with the
    // reason: the store cannot know whether separation of duties applies.
    let policyPath = 'knowledge/product/governance/approval-policy.json';
    try {
      policyPath = approvalPolicyCatalog.path();
    } catch {
      /* keep the product default path in the message */
    }
    throw new Error(
      `[POLICY_VIOLATION] approval decision blocked — approval-policy.json unreadable | next: fix ${policyPath} (schema: knowledge/product/schemas/approval-policy.schema.json) | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { enabled: policy.separation_of_duties?.enabled === true };
}

/**
 * HA-08: the human-approval assurance rollout mode declared by
 * `approval-policy.json` `assurance_mode` (same customer-overlay scoping as
 * separation of duties). Undefined when no policy file exists or it does not
 * declare one. A present but unreadable policy reads as `enforce`: the store
 * cannot know the operator meant to relax it.
 */
export function resolvePolicyApprovalAssuranceMode(): ApprovalAssuranceMode | undefined {
  if (!approvalPolicyFilePresent()) return undefined;
  try {
    const mode = loadApprovalPolicy().assurance_mode;
    return mode === 'enforce' || mode === 'warn' ? mode : undefined;
  } catch (error) {
    warnUnreadablePolicy('assurance_mode treated as enforce', error);
    return 'enforce';
  }
}

const UNREADABLE_POLICY_WARN_INTERVAL_MS = 10 * 60 * 1000;
const unreadablePolicyWarnedAt = new Map<string, number>();

/** One warning per consequence per interval: the mode is resolved on every decision. */
function warnUnreadablePolicy(consequence: string, error: unknown, now = Date.now()): void {
  const last = unreadablePolicyWarnedAt.get(consequence);
  if (last !== undefined && now - last < UNREADABLE_POLICY_WARN_INTERVAL_MS) return;
  unreadablePolicyWarnedAt.set(consequence, now);
  logger.warn(
    `approval-policy.json unreadable — ${consequence} | next: fix the policy file (schema: knowledge/product/schemas/approval-policy.schema.json) | evidence: ${error instanceof Error ? error.message : String(error)}`
  );
}

export const DEFAULT_PASSKEY_ENROLLMENT_COOLDOWN_HOURS = 24;
/** A cooldown never goes below an hour, whatever an overlay declares. */
export const MIN_PASSKEY_ENROLLMENT_COOLDOWN_HOURS = 1;

/**
 * HA-07: hours before a passkey enrolled without a step-up from an already
 * usable passkey may settle an A3 decision (`passkey_enrollment_cooldown_hours`,
 * same customer-overlay scoping). The default applies when no policy declares
 * it or the policy is unreadable.
 */
export function resolvePasskeyEnrollmentCooldownHours(): number {
  if (!approvalPolicyFilePresent()) return DEFAULT_PASSKEY_ENROLLMENT_COOLDOWN_HOURS;
  try {
    const hours = loadApprovalPolicy().passkey_enrollment_cooldown_hours;
    return typeof hours === 'number' && Number.isFinite(hours)
      ? Math.max(MIN_PASSKEY_ENROLLMENT_COOLDOWN_HOURS, hours)
      : DEFAULT_PASSKEY_ENROLLMENT_COOLDOWN_HOURS;
  } catch (error) {
    warnUnreadablePolicy('passkey enrollment cooldown uses the default', error);
    return DEFAULT_PASSKEY_ENROLLMENT_COOLDOWN_HOURS;
  }
}

/** A0 < A1 < A2 < A3 (approval-assurance.ts imports this module, so no runtime import back). */
const ASSURANCE_ORDER: readonly ApprovalAssuranceLevel[] = ['A0', 'A1', 'A2', 'A3'];

/**
 * HA-08: the assurance floor today's policy puts on an effect, for a pending
 * request created before its rule carried `min_assurance`. The union of the
 * rule the request records (`policy_rule_id`, gate requests since HA-08 —
 * possibly a gate-internal id such as `strict-posture-floor`) and every rule
 * naming its effect binding (the gate's operation id, which is its intent
 * id), including the built-in fallback rules. A request does not record its
 * payload, so a rule's payload condition cannot be evaluated: every rule
 * naming the effect counts (the strongest floor wins — a pending request may
 * need more than it was created with, never less). `dual_key_confirmation`
 * means A3.
 */
export function resolvePolicyAssuranceFloor(input: {
  ruleId?: string;
  effectBinding?: string;
}): ApprovalAssuranceLevel | undefined {
  if (!input.ruleId && !input.effectBinding) return undefined;
  if (!approvalPolicyFilePresent()) return undefined;
  let rules: ApprovalPolicyRule[];
  let fallbackRules: ApprovalPolicyFallbackRule[];
  try {
    const policy = loadApprovalPolicy();
    rules = policy.rules ?? [];
    fallbackRules = Array.isArray(policy.fallback_rules)
      ? policy.fallback_rules
      : HARD_CODED_DANGEROUS_RULES;
  } catch (error) {
    warnUnreadablePolicy('decision-time assurance floor treated as A3', error);
    return 'A3';
  }
  let floor: ApprovalAssuranceLevel | undefined;
  const raise = (level: ApprovalAssuranceLevel): void => {
    if (!floor || ASSURANCE_ORDER.indexOf(level) > ASSURANCE_ORDER.indexOf(floor)) floor = level;
  };
  const consider = (minAssurance: ApprovalAssuranceLevel | undefined, missing?: string[]): void => {
    if (minAssurance) raise(minAssurance);
    if (missing?.includes('dual_key_confirmation')) raise('A3');
  };
  for (const rule of rules) {
    const byId = Boolean(input.ruleId) && rule.id === input.ruleId;
    const byEffect =
      Boolean(input.effectBinding) && rule.intent_ids?.includes(input.effectBinding!);
    if (byId || byEffect) consider(rule.min_assurance, rule.missing_requirements);
  }
  for (const rule of fallbackRules) {
    const byId = Boolean(input.ruleId) && rule.id === input.ruleId;
    const byEffect =
      Boolean(input.effectBinding) &&
      compileFallbackMatcher(rule)({ intentId: input.effectBinding });
    if (byId || byEffect) consider(undefined, rule.missing_requirements);
  }
  return floor;
}

export function resolveApprovalPolicy(input: {
  intentId?: string;
  payload?: Record<string, unknown>;
}): ApprovalPolicyResolution {
  const base = applyInjectionFloor(input, resolveBaseApprovalPolicy(input));
  // QM-04: strict posture = every intent pauses for a human. The floor is a
  // MONOTONE tightening applied on top of the base resolution: a base rule
  // that already requires approval keeps its rule id and its (possibly
  // stronger) requirements — dual_key_confirmation and the
  // injection-suspected-override must survive strict, because downstream
  // (approval-gate session cache) keys its bypass rules on them.
  if (resolveConfiguredPosture() === 'strict') {
    if (base.requiresApproval) {
      return {
        ...base,
        mandatoryApproval: true,
        charterEligible: false,
        missingRequirements: Array.from(
          new Set([...base.missingRequirements, 'approval_confirmation'])
        ),
      };
    }
    return {
      requiresApproval: true,
      missingRequirements: ['approval_confirmation'],
      matchedRuleId: 'strict-posture-floor',
      mandatoryApproval: true,
      charterEligible: false,
    };
  }
  return base;
}

function hasDangerousShellPattern(command: string): boolean {
  if (!command) return false;
  const pipe = command.indexOf('|');
  const pipesIntoShell =
    pipe > 0 && /^(?:sh|bash|zsh|fish)\b/i.test(command.slice(pipe + 1).trimStart());
  const curl = command.indexOf('curl');
  const wget = command.indexOf('wget');
  return (
    /rm\s+-rf/i.test(command) ||
    (pipesIntoShell && ((curl >= 0 && curl < pipe) || (wget >= 0 && wget < pipe))) ||
    /base64\s+-(?:d|decode)/i.test(command) ||
    /eval\s/i.test(command) ||
    /\bexec\s*\(/i.test(command)
  );
}

function applyInjectionFloor(
  input: { intentId?: string; payload?: Record<string, unknown> },
  base: ApprovalPolicyResolution
): ApprovalPolicyResolution {
  if (isInjectionSuspected()) {
    const isEgress =
      /egress|network|http|https|fetch|request/i.test(input.intentId || '') ||
      Boolean(input.payload?.url) ||
      Boolean(input.payload?.base_url);
    const isShell =
      /shell|command|exec|run_shell|bash/i.test(input.intentId || '') ||
      hasDangerousShellPattern(
        String(input.payload?.command ?? input.payload?.cmd ?? input.payload?.script ?? '')
      );
    const isModify =
      /write|edit|update|delete|destroy|remove|deploy|release|publish|restart|stop|start/i.test(
        input.intentId || ''
      ) ||
      /(?:write|edit|update|delete|destroy|remove|deploy|release|publish|restart|stop|start|wipe|purge)/i.test(
        String(input.payload?.operation ?? input.payload?.action ?? '')
      );

    if (isEgress || isShell || isModify) {
      return {
        requiresApproval: true,
        missingRequirements: Array.from(
          new Set([...base.missingRequirements, 'approval_confirmation'])
        ),
        matchedRuleId: 'injection-suspected-override',
        mandatoryApproval: true,
        charterEligible: false,
        ...(base.minAssurance ? { minAssurance: base.minAssurance } : {}),
      };
    }
  }
  return base;
}

function resolveBaseApprovalPolicy(input: {
  intentId?: string;
  payload?: Record<string, unknown>;
}): ApprovalPolicyResolution {
  const policy = loadApprovalPolicy();
  for (const rule of policy.rules || []) {
    if (rule.intent_ids?.length && (!input.intentId || !rule.intent_ids.includes(input.intentId)))
      continue;
    const payloadField = rule.when?.payload_field;
    if (payloadField) {
      const candidate = input.payload?.[payloadField];
      const acceptedValues = rule.when?.any_of || [];
      if (!acceptedValues.some((value) => value === candidate)) continue;
    }
    const missingRequirements = Array.isArray(rule.missing_requirements)
      ? [...rule.missing_requirements]
      : [];
    return {
      requiresApproval: rule.requires_approval,
      missingRequirements,
      matchedRuleId: rule.id,
      charterEligible:
        rule.charter_eligible ?? !missingRequirements.includes('dual_key_confirmation'),
      ...(rule.min_assurance ? { minAssurance: rule.min_assurance } : {}),
    };
  }

  const fallbackRules = Array.isArray(policy.fallback_rules)
    ? policy.fallback_rules
    : HARD_CODED_DANGEROUS_RULES;
  const fallback = fallbackRules.find((rule) => compileFallbackMatcher(rule)(input));
  if (fallback) {
    const missingRequirements = [...(fallback.missing_requirements || [])];
    return {
      requiresApproval: true,
      missingRequirements,
      matchedRuleId: fallback.id,
      charterEligible:
        fallback.charter_eligible ?? !missingRequirements.includes('dual_key_confirmation'),
    };
  }

  return {
    requiresApproval: Boolean(policy.defaults?.requires_approval),
    missingRequirements: [],
  };
}

// ─── Unified authorization surface (intent axis) ─────────────────────────────
// Registers the intent axis of authorization-registry.ts: every `intent_ids`
// entry of an approval-policy.json rule becomes a declared `intent:<id>`
// subject. `requires_approval` maps to approval vs internal admission
// authority; `min_assurance` (A0 is no human floor → omitted) and
// `dual_key_confirmation` carry over. Payload `when` clauses are NOT evaluated
// — the declared authority is the strongest the intent can attract, and
// resolveApprovalPolicy remains the payload-aware decision point.
// Payload-only rules (no intent_ids) and the hardcoded dangerous-pattern
// fallbacks have no subject key by construction.

function intentAxisEntry(rule: ApprovalPolicyRule): SubjectAxisEntry {
  const authority: AuthorityRequirement = rule.requires_approval
    ? {
        kind: 'approval',
        ...(rule.min_assurance && rule.min_assurance !== 'A0'
          ? { assurance: rule.min_assurance as AssuranceClass }
          : {}),
        ...(rule.missing_requirements?.includes('dual_key_confirmation') ? { dualKey: true } : {}),
      }
    : { kind: 'admission', boundary: 'internal' };
  return {
    effectClass: 'internal_decision',
    authority,
    detail: { kind: 'approval-policy-rule', ruleId: rule.id },
  };
}

/** Strongest rule naming an intent wins: an intent listed by several rules
 * (e.g. a payload-conditional approval plus an unconditional pass-through)
 * resolves to the strongest authority any of them can attract — authority
 * kind first, then assurance floor, then dual-key. */
function intentAuthorityScore(authority: AuthorityRequirement): number {
  const kindRank = { free: 0, admission: 1, binding: 2, approval: 3 }[authority.kind];
  if (authority.kind !== 'approval') return kindRank * 100;
  const assuranceRank = { A1: 1, A2: 2, A3: 3 }[authority.assurance ?? 'A1'];
  return kindRank * 100 + (authority.dualKey ? 10 : 0) + assuranceRank;
}

setSubjectAxisBridge('intent', {
  source: 'overlay',
  resolve(id) {
    try {
      const rules = (loadApprovalPolicy().rules ?? []).filter((r) => r.intent_ids?.includes(id));
      if (!rules.length) return undefined;
      return intentAxisEntry(
        rules.reduce((strongest, rule) =>
          intentAuthorityScore(intentAxisEntry(rule).authority) >
          intentAuthorityScore(intentAxisEntry(strongest).authority)
            ? rule
            : strongest
        )
      );
    } catch {
      // An unreadable policy resolves as undeclared → the approval fail-safe.
      return undefined;
    }
  },
  keys() {
    try {
      return (loadApprovalPolicy().rules ?? []).flatMap((r) => r.intent_ids ?? []);
    } catch {
      return [];
    }
  },
});
