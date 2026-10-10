import * as customerResolver from '../customer-resolver.js';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { isInjectionSuspected } from '../injection-signal.js';
import { resolveConfiguredPosture } from '../security-screen.js';
import { createLogger } from '../logger.js';
import type { ApprovalAssuranceLevel, ApprovalAssuranceMode } from './approval-assurance.js';

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
  /** HA-07: the weakest decider proof a human-only request created by this rule accepts. */
  min_assurance?: ApprovalAssuranceLevel;
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
  /** The matched rule's `min_assurance` (HA-07). */
  minAssurance?: ApprovalAssuranceLevel;
}

const approvalPolicyCatalog = defineCatalog<ApprovalPolicyFile>({
  id: 'approval-policy',
  path: () => {
    const customerPolicyPath = customerResolver.customerRoot('policy/approval-policy.json');
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

const HARD_CODED_DANGEROUS_RULES: Array<{
  id: string;
  matches: (input: { intentId?: string; payload?: Record<string, unknown> }) => boolean;
  missingRequirements: string[];
}> = [
  {
    id: 'fallback-dangerous-shell',
    matches: ({ intentId, payload }) =>
      /shell|command|exec|run_shell|bash/i.test(intentId || '') ||
      /(?:rm\s+-rf|curl\s+.*\|\s*(?:sh|bash|zsh|fish)|wget\s+.*\|\s*(?:sh|bash|zsh|fish)|base64\s+-(?:d|decode)|eval\s|\bexec\s*\()/i.test(
        String(payload?.command ?? payload?.cmd ?? payload?.script ?? '')
      ),
    missingRequirements: ['approval_confirmation'],
  },
  {
    id: 'fallback-dangerous-egress',
    matches: ({ intentId, payload }) =>
      /egress|network|http|https|fetch|request/i.test(intentId || '') ||
      Boolean(payload?.url) ||
      Boolean(payload?.base_url),
    missingRequirements: ['approval_confirmation'],
  },
  {
    id: 'fallback-dangerous-secret',
    matches: ({ intentId }) =>
      /secret|vault:write|auth:grant|credential|token|password/i.test(intentId || ''),
    missingRequirements: ['dual_key_confirmation'],
  },
  {
    id: 'fallback-dangerous-deploy',
    matches: ({ intentId, payload }) =>
      /deploy|release|publish|production|restart|stop|start|delete|destroy|remove/i.test(
        intentId || ''
      ) ||
      /(?:restart|stop|start|delete|destroy|remove|wipe|purge)/i.test(
        String(payload?.operation ?? payload?.action ?? '')
      ),
    missingRequirements: ['approval_confirmation'],
  },
];

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
 * the active customer overlay (`customer/{slug}/policy/approval-policy.json`)
 * replaces the product default wholesale. There is no per-tenant or
 * per-organization override.
 */
/** Whether any approval-policy.json exists (customer overlay or product default). */
function approvalPolicyFilePresent(): boolean {
  const customerPolicyPath = customerResolver.customerRoot('policy/approval-policy.json');
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
  try {
    rules = loadApprovalPolicy().rules ?? [];
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
  for (const rule of HARD_CODED_DANGEROUS_RULES) {
    const byId = Boolean(input.ruleId) && rule.id === input.ruleId;
    const byEffect =
      Boolean(input.effectBinding) && rule.matches({ intentId: input.effectBinding });
    if (byId || byEffect) consider(undefined, rule.missingRequirements);
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
    return {
      requiresApproval: rule.requires_approval,
      missingRequirements: Array.isArray(rule.missing_requirements)
        ? [...rule.missing_requirements]
        : [],
      matchedRuleId: rule.id,
      ...(rule.min_assurance ? { minAssurance: rule.min_assurance } : {}),
    };
  }

  const fallback = HARD_CODED_DANGEROUS_RULES.find((rule) => rule.matches(input));
  if (fallback) {
    return {
      requiresApproval: true,
      missingRequirements: [...fallback.missingRequirements],
      matchedRuleId: fallback.id,
    };
  }

  return {
    requiresApproval: Boolean(policy.defaults?.requires_approval),
    missingRequirements: [],
  };
}
