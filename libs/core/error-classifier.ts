/**
 * Kyberion Error Classifier
 *
 * Maps unstructured errors (Error objects, strings, exit codes) into a small
 * set of named categories with a recommended user-facing remediation.
 *
 * Used by:
 * - Pipeline runners to surface "what went wrong + what to do" instead of raw stack.
 * - The distill phase to bucket failures into reusable hints (Phase B-6).
 * - Chronos / status surfaces to badge missions with their failure mode.
 *
 * Design:
 * - Pure functions, no I/O. Easy to test, easy to extend.
 * - Rules are ordered: the first matching rule wins.
 * - "unknown" is the explicit fallback. The Phase A-5 / B-6 goal is to drive
 *   the unknown ratio down by adding rules whenever an unknown is observed.
 */

export type ErrorCategory =
  | 'auth'                     // missing / invalid credentials
  | 'permission_denied'        // tier-guard, path-scope, OS perms
  | 'network'                  // DNS, TCP, TLS, HTTP timeouts
  | 'rate_limit'               // 429, provider quota
  | 'missing_dependency'       // binary or package not installed
  | 'missing_secret'           // expected env var / keychain entry not found
  | 'invalid_input'            // malformed JSON / schema violation / bad ADF
  | 'resource_unavailable'     // port in use, file locked, disk full
  | 'timeout'                  // operation exceeded its window
  | 'governance_block'         // approval required, policy violation
  | 'tier_violation'           // tier-guard refused
  | 'mission_not_found'        // mission id resolution failed
  | 'unknown';                 // fallback

export interface ErrorClassification {
  category: ErrorCategory;
  /** Short human-readable label. */
  label: string;
  /** What the user can do, written in one short imperative sentence. */
  remediation: string;
  /** Original error text (truncated). */
  detail: string;
  /** Which rule matched (for telemetry / debugging). 'fallback' when no rule matched. */
  ruleId: string;
  /** (Optional) A hint for an autonomous agent on how to repair this error. */
  repairAction?: string;
}

interface ClassifierRule {
  id: string;
  category: ErrorCategory;
  label: string;
  remediation: string;
  /** A predicate over the message + optional code. Should be cheap to evaluate. */
  test: (message: string, code?: string | number) => boolean;
  /** (Optional) A hint for an autonomous agent on how to repair this error. */
  repairAction?: string;
}

const RULES: ClassifierRule[] = [
  // --- Service / Media specific suggestions (Priority) ---
  {
    id: 'service.endpoint-missing',
    category: 'resource_unavailable',
    label: 'Service endpoint not configured',
    remediation:
      'The requested service (e.g., Image Generation) has no active endpoints. Start your local Service Engine (e.g., ComfyUI) or configure a cloud API in `knowledge/public/orchestration/service-endpoints`.',
    test: (m) => /Service endpoints directory produced no services|no available services for domain|media-generation/i.test(m),
    repairAction: 'Locate available service endpoints in knowledge/public/orchestration/service-presets/ and suggest a configuration for service-endpoints/.'
  },
  {
    id: 'media.generation-failed',
    category: 'resource_unavailable',
    label: 'Media generation failed',
    remediation:
      'The media generator (ComfyUI/Stable Diffusion) is not responding. Ensure the backend is running and reachable at the configured port (default: 8188).',
    test: (m) => /media-generation.*failed|ComfyUI.*not responding|ECONNREFUSED.*8188/i.test(m),
    repairAction: 'Check if Service Engine process is running. If not, suggest starting it or switching to a cloud provider fallback.'
  },
  // --- Permission / governance ---
  {
    id: 'kyberion.tier-guard',
    category: 'tier_violation',
    label: 'Tier guard refused access',
    remediation:
      'Higher tier required. Set `KYBERION_PERSONA` or `MISSION_ROLE` to a role authorized for this tier.',
    test: (m) => /tier[\s_-]?guard|TIER_VIOLATION|tier policy/i.test(m),
    repairAction: 'Consult organization-profile.md for required roles. Suggest adding `KYBERION_PERSONA=ecosystem_architect` or `MISSION_ROLE=knowledge_steward` to the environment configuration to authorize access.'
  },
  {
    id: 'runtime.property-access',
    category: 'unknown',
    label: 'Internal runtime error',
    remediation: 'Check the actuator implementation for null/undefined property access.',
    test: (m) => /Cannot read properties of undefined|is not a function/i.test(m),
    // No repairAction — actuator runtime crashes cannot be fixed by rewriting the ADF.
    // Allowing repair here causes the 5-minute repair agent to run unnecessarily.
  },
  {
    id: 'kyberion.capture-empty',
    category: 'invalid_input',
    label: 'Capture operation returned no data',
    remediation: 'Check the search query, topic, or path. The target resource might not exist.',
    test: (m) => /returned no data/i.test(m),
    repairAction: 'Analyze the step parameters and the expected input for this actuator. Fix any mismatched key names or invalid paths in the pipeline ADF.'
  },
  {
    id: 'kyberion.path-scope',
    category: 'permission_denied',
    label: 'Path scope policy denied write',
    remediation:
      'The path-scope policy refused this write. Check `KYBERION_PERSONA` / `MISSION_ROLE` env vars match the persona authorized to write this path.',
    test: (m) => /POLICY_VIOLATION.*authorized|path-scope-policy|outside project root/i.test(m),
    repairAction: 'Adjust the target path to be within the allowed mission or shared workspace root.'
  },
  {
    id: 'kyberion.governance-approval',
    category: 'governance_block',
    label: 'Approval required',
    remediation:
      'This action requires explicit approval per `approval-policy.json`. Run `pnpm cli approval` or follow the prompt to grant approval.',
    test: (m) => /approval[\s_-]?required|enforceApprovalGate|approval gate/i.test(m),
  },
  {
    id: 'kyberion.policy-violation',
    category: 'governance_block',
    label: 'Governance policy denied action',
    remediation:
      'Review the policy denial and either change the requested action or obtain the required approval before retrying.',
    test: (m) => /POLICY_VIOLATION|policy (violation|denied|refused)|not allowed by policy|governance policy/i.test(m),
  },
  {
    id: 'pipeline.hook-abort',
    category: 'governance_block',
    label: 'Step blocked by hook',
    remediation:
      'A before/after hook returned abort. Check the hook definition on this step in the pipeline ADF. For command hooks, the script exited with code 2 or threw. For http hooks, the endpoint returned a non-2xx status or { "decision": "abort" }. For approval gates, ensure the required flag or approval is in place before re-running.',
    test: (m) => /aborted by (before|after) hook/i.test(m),
  },
  // --- Auth / secrets ---
  {
    id: 'auth.invalid-key',
    category: 'auth',
    label: 'Invalid or missing API key',
    remediation:
      'Set the required API key in your OS keychain (preferred) or environment. Re-run `pnpm onboard` to validate credentials.',
    test: (m) =>
      /(invalid|missing|unauthorized).*(api[\s_-]?key|token|credential)/i.test(m) ||
      /401\s*unauthorized/i.test(m) ||
      /authentication.*(failed|required)/i.test(m),
  },
  {
    id: 'secret.not-found',
    category: 'missing_secret',
    label: 'Secret not found',
    remediation:
      'Run `pnpm cli secret list` to see what is configured, then add the missing entry to your OS keychain.',
    test: (m) => /secret[\s_-]?(not[\s_-]?found|missing)|keychain.*not[\s_-]?found/i.test(m),
  },
  // --- Network ---
  {
    id: 'provider.timeout',
    category: 'timeout',
    label: 'Provider timed out',
    remediation:
      'The provider did not return before its timeout. Retry with a larger provider timeout or switch to another configured backend.',
    test: (m) => /\b(provider|anthropic|openai|claude|gemini|codex|shell-claude-cli|gemini-cli|codex-cli)\b.*\b(timed out|timeout|deadline exceeded)\b/i.test(m),
  },
  {
    id: 'network.timeout',
    category: 'timeout',
    label: 'Network timeout',
    remediation:
      'The request did not complete in the allotted time. Retry with a larger timeout, or check network reachability.',
    test: (m, code) =>
      /ETIMEDOUT|ESOCKETTIMEDOUT|network[\s_-]?timeout|request[\s_-]?timeout/i.test(m) ||
      code === 'ETIMEDOUT',
  },
  {
    id: 'network.dns',
    category: 'network',
    label: 'DNS / hostname resolution failed',
    remediation:
      'The hostname could not be resolved. Check the URL, your DNS, and whether the host is reachable.',
    test: (m, code) => /ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(m) || code === 'ENOTFOUND',
  },
  {
    id: 'network.refused',
    category: 'network',
    label: 'Connection refused',
    remediation:
      'Nothing is listening on that port/host. Start the service, or check the URL.',
    test: (m, code) =>
      /ECONNREFUSED|ECONNRESET|connection[\s_-]?refused|socket hang up/i.test(m) ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET',
  },
  {
    id: 'rate.limit',
    category: 'rate_limit',
    label: 'Rate limit / quota exceeded',
    remediation:
      'The provider is rate-limiting. Back off and retry, or raise your quota.',
    test: (m) => /rate[\s_-]?limit|429|quota[\s_-]?exceeded|too many requests/i.test(m),
  },
  // --- Dependency / environment ---
  {
    id: 'dep.missing-binary',
    category: 'missing_dependency',
    label: 'Required binary not installed',
    remediation:
      'Install the missing binary. Run `pnpm doctor` to see all dependency gaps with install commands.',
    test: (m) =>
      /command not found|spawn .* ENOENT|playwright.*not[\s_-]?installed|tesseract.*not[\s_-]?found/i.test(
        m,
      ),
  },
  {
    id: 'dep.missing-module',
    category: 'missing_dependency',
    label: 'Node module not installed',
    remediation:
      'A Node package is missing. Run `pnpm install` and rebuild with `pnpm build`.',
    test: (m, code) =>
      /Cannot find module|MODULE_NOT_FOUND/i.test(m) || code === 'MODULE_NOT_FOUND',
  },
  {
    id: 'kyberion.capability-missing',
    category: 'missing_dependency',
    label: 'Kyberion capability missing',
    remediation:
      'Run `pnpm capabilities` or `pnpm doctor` to confirm the missing capability, then install or enable the referenced actuator/runtime.',
    test: (m) => /(capability|actuator|runtime).*(missing|not found|unavailable|not registered)|no capability registered/i.test(m),
  },
  // --- Resources ---
  {
    id: 'resource.eaddrinuse',
    category: 'resource_unavailable',
    label: 'Port already in use',
    remediation:
      'Another process is bound to that port. Stop it, or pick a different port.',
    test: (m, code) => /EADDRINUSE|address already in use/i.test(m) || code === 'EADDRINUSE',
  },
  {
    id: 'resource.no-space',
    category: 'resource_unavailable',
    label: 'Disk full',
    remediation: 'Free up disk space and retry.',
    test: (m, code) => /ENOSPC|no space left/i.test(m) || code === 'ENOSPC',
  },
  {
    id: 'resource.eacces',
    category: 'permission_denied',
    label: 'OS-level permission denied',
    remediation:
      'The OS refused the file/socket op. Check ownership, mode bits, and SELinux/AppArmor if applicable.',
    test: (m, code) => /EACCES|permission denied/i.test(m) || code === 'EACCES',
  },
  // --- Input / schema ---
  {
    id: 'input.schema',
    category: 'invalid_input',
    label: 'Schema validation failed',
    remediation:
      'The input does not match the required schema. Fix the highlighted fields and retry.',
    test: (m) => /schema validation|ajv|zod|invalid (input|payload|adf)|preflight failed|schema violation|must have required property|additional propert(y|ies)|must match schema|should match/i.test(m),
  },
  {
    id: 'input.unsupported-op',
    category: 'invalid_input',
    label: 'Unsupported pipeline operation',
    remediation:
      'Fix the pipeline step name or register the missing actuator for that operation.',
    test: (m) => /Unsupported pipeline op|unknown pipeline op|operation not supported/i.test(m),
  },
  // --- Input / schema ---
  {
    id: 'input.json-parse',
    category: 'invalid_input',
    label: 'Malformed JSON',
    remediation: 'Fix the JSON syntax in the highlighted file.',
    test: (m) => /(SyntaxError|Unexpected token).*JSON|JSON\.parse|Unexpected end of JSON/i.test(m),
  },
  // --- Build / environment ---
  {
    id: 'build.tsc-error',
    category: 'invalid_input',
    label: 'TypeScript compilation error',
    remediation: 'Fix the TypeScript error shown above and run `pnpm build` again. Ensure all imports resolve and type signatures match.',
    test: (m) => /error TS\d+:|\.ts\(\d+,\d+\)|TypeScript.*error|tsc.*failed/i.test(m),
  },
  {
    id: 'build.node-version',
    category: 'missing_dependency',
    label: 'Node.js version incompatible',
    remediation: 'This project requires Node 22+. Run `node --version` to check, then install the required version via `nvm install 22` or the version manager of your choice.',
    test: (m) => /engine.*node|node.*version.*required|requires node.*22|EBADENGINE/i.test(m),
  },
  {
    id: 'build.pnpm-workspace',
    category: 'invalid_input',
    label: 'pnpm workspace resolution error',
    remediation: 'Run `pnpm install` from the repo root to sync workspace packages. If the error persists, delete `node_modules` and retry.',
    test: (m) => /ERR_PNPM_|workspace.*not found|pnpm.*install failed|Cannot find package.*workspace/i.test(m),
  },
  {
    id: 'actuator.contract-mismatch',
    category: 'invalid_input',
    label: 'Actuator contract mismatch',
    remediation: "The action or params do not match the actuator's contract schema. Run `pnpm cli info <actuator-name>` to see the contract schema path and verify the required fields.",
    test: (m) => /contract.*schema|schema.*contract|actuator.*contract|required field.*missing|unexpected.*action.?type/i.test(m),
  },
  {
    id: 'env.missing-var',
    category: 'missing_secret',
    label: 'Required environment variable not set',
    remediation: 'Set the missing environment variable in your shell or `.env` file. See `docs/INITIALIZATION.md` for the full list of required variables.',
    test: (m) => /environment variable.*not set|env.*required.*not set|process\.env\.\w+ is undefined|missing.*env(ironment)? var(iable)?/i.test(m),
  },
  // --- Mission ---
  {
    id: 'mission.not-found',
    category: 'mission_not_found',
    label: 'Mission not found',
    remediation:
      'Run `pnpm mission list` to see available missions. The id is case-insensitive but must exist.',
    test: (m) => /mission .* not found|mission .* path not found/i.test(m),
  },
];

// ─── Authority Diagnostics ────────────────────────────────────────────────────

export type PolicyViolationType =
  | 'project_scope_denied'
  | 'tenant_scope_denied'
  | 'tenant_broker_missing'
  | 'tenant_broker_expired'
  | 'path_scope_denied'
  | 'approval_required'
  | 'tier_access_denied'
  | 'unknown_policy_violation';

export interface PolicyViolationDiagnostic {
  violationType: PolicyViolationType;
  /** Human-readable explanation of what was blocked and why. */
  explanation: string;
  /** The role or persona typically needed to perform this action. */
  requiredRole?: string;
  /** The authority flag (e.g. SECRET_READ, GIT_WRITE) needed. */
  requiredAuthority?: string;
  /** Ordered list of repair steps the operator can take. */
  repairSteps: string[];
}

const POLICY_VIOLATION_PATTERNS: Array<{
  pattern: RegExp;
  violationType: PolicyViolationType;
  explanation: string;
  requiredRole?: string;
  requiredAuthority?: string;
  repairSteps: string[];
}> = [
  {
    pattern: /POLICY_VIOLATION.*not authorized for project|not authorized.*project/i,
    violationType: 'project_scope_denied',
    explanation: 'The current persona is not authorized to access this project.',
    requiredRole: 'mission_controller or project owner persona',
    repairSteps: [
      'Set KYBERION_PERSONA to a persona listed in the project\'s auth-grants.json.',
      'Run `pnpm mission list` to verify the mission ID is correct.',
      'If you need project access, ask the project owner to add your persona to auth-grants.json.',
    ],
  },
  {
    pattern: /POLICY_VIOLATION.*tenant\.broker_expired|broker.*expired/i,
    violationType: 'tenant_broker_expired',
    explanation: 'The cross-tenant brokerage grant has expired.',
    requiredRole: 'ecosystem_architect',
    requiredAuthority: 'CROSS_TENANT_BROKER',
    repairSteps: [
      'Update the brokerage entry in active/shared/cross-tenant-broker.json with a new expires_at.',
      'Ensure approved_by and approved_at are set by an ecosystem_architect persona.',
      'Re-run the operation after the brokerage is refreshed.',
    ],
  },
  {
    pattern: /POLICY_VIOLATION.*tenant\.broker_missing|broker.*missing|cross.?tenant.*broker/i,
    violationType: 'tenant_broker_missing',
    explanation: 'A cross-tenant brokerage grant is required but not present.',
    requiredRole: 'ecosystem_architect',
    requiredAuthority: 'CROSS_TENANT_BROKER',
    repairSteps: [
      'Create a brokerage entry in active/shared/cross-tenant-broker.json.',
      'Fields required: source_tenant, target_tenant, purpose, approved_by, approved_at, expires_at.',
      'The approved_by value must be an ecosystem_architect persona.',
    ],
  },
  {
    pattern: /POLICY_VIOLATION.*tenant\.|tenant.*scope/i,
    violationType: 'tenant_scope_denied',
    explanation: 'The current persona is not authorized for this tenant scope.',
    requiredRole: 'mission_controller with tenant binding',
    repairSteps: [
      'Set KYBERION_CUSTOMER to the correct tenant slug.',
      'Verify the tenant slug is registered in knowledge/confidential/{tenant}/.',
      'Ensure KYBERION_PERSONA is bound to this tenant in the mission state.',
    ],
  },
  {
    pattern: /POLICY_VIOLATION.*path.?scope|path-scope-policy|outside project root/i,
    violationType: 'path_scope_denied',
    explanation: 'The write path is outside the allowed scope for the current persona.',
    requiredRole: 'mission_controller',
    repairSteps: [
      'Confirm the target path is under active/missions/{id}/ or active/shared/.',
      'Set KYBERION_PERSONA and MISSION_ROLE to match the mission owner.',
      'Use tenantMissionDir() instead of a hardcoded path for tenant-scoped writes.',
    ],
  },
  {
    pattern: /approval[\s_-]?required|enforceApprovalGate|approval gate/i,
    violationType: 'approval_required',
    explanation: 'This action requires explicit approval before it can proceed.',
    requiredRole: 'approver persona (governance_lead or ecosystem_architect)',
    repairSteps: [
      'Run `pnpm cli approval` to open the approval flow.',
      'The approver must set the approval flag in the mission state or auth-grants.json.',
      'After approval is recorded, re-run the operation.',
    ],
  },
  {
    pattern: /POLICY_VIOLATION.*tier|tier.*(violation|guard|denied)|knowledge\/confidential/i,
    violationType: 'tier_access_denied',
    explanation: 'The requested operation requires access to a higher knowledge tier.',
    requiredRole: 'knowledge_steward or ecosystem_architect',
    requiredAuthority: 'KNOWLEDGE_WRITE',
    repairSteps: [
      'Set KYBERION_PERSONA to a persona with the required tier access.',
      'Personal tier (knowledge/personal/) requires sovereign or personal persona.',
      'Confidential tier (knowledge/confidential/) requires ecosystem_architect or knowledge_steward.',
    ],
  },
];

/**
 * Produce a structured diagnosis for a POLICY_VIOLATION error string.
 * Returns the violation type, required role/authority, and ordered repair steps.
 * Call this when `classifyError()` returns category 'governance_block' or 'permission_denied'
 * to present actionable guidance to the operator.
 */
export function explainPolicyViolation(errorText: string): PolicyViolationDiagnostic {
  for (const entry of POLICY_VIOLATION_PATTERNS) {
    if (entry.pattern.test(errorText)) {
      return {
        violationType: entry.violationType,
        explanation: entry.explanation,
        requiredRole: entry.requiredRole,
        requiredAuthority: entry.requiredAuthority,
        repairSteps: entry.repairSteps,
      };
    }
  }
  return {
    violationType: 'unknown_policy_violation',
    explanation: 'A policy violation was raised but the specific rule could not be identified.',
    repairSteps: [
      'Check KYBERION_PERSONA and MISSION_ROLE environment variables.',
      'Run `pnpm doctor` to verify environment health.',
      'Review the full error message for a POLICY_VIOLATION prefix with additional detail.',
    ],
  };
}

/**
 * Classify an error. Accepts an Error, string, or { message, code } object.
 * Returns a structured classification with a recommended remediation.
 */
export function classifyError(err: unknown): ErrorClassification {
  let message: string;
  let code: string | number | undefined;

  if (err instanceof Error) {
    message = err.message ?? '';
    code = (err as NodeJS.ErrnoException).code;
  } else if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object') {
    const obj = err as { message?: unknown; code?: unknown };
    message = String(obj.message ?? '');
    code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? obj.code : undefined;
  } else {
    message = String(err);
  }

  const detail = message.length > 500 ? message.slice(0, 500) + '…' : message;

  for (const rule of RULES) {
    try {
      if (rule.test(message, code)) {
        return {
          category: rule.category,
          label: rule.label,
          remediation: rule.remediation,
          detail,
          ruleId: rule.id,
          repairAction: rule.repairAction,
        };
      }
    } catch (_) {
      // A rule's test should never throw; if it does, skip it and continue.
    }
  }

  return {
    category: 'unknown',
    label: 'Unclassified error',
    remediation:
      'No rule matched this error. Check the detail below and consider adding a rule to error-classifier.ts.',
    detail,
    ruleId: 'fallback',
  };
}

/** Format a classification for display in CLI / logs. */
export function formatClassification(c: ErrorClassification): string {
  return `[${c.category}] ${c.label}\n  → ${c.remediation}\n  detail: ${c.detail}`;
}

/** Returns the rule list for testing / documentation. */
export function getRuleIds(): string[] {
  return RULES.map(r => r.id);
}
