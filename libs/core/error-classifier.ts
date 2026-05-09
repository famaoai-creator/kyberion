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
    test: (m) => /tier[\s_-]?guard|TIER_VIOLATION|tier policy|returned no data/i.test(m),
    repairAction: 'Consult organization-profile.md for required roles. Suggest adding `KYBERION_PERSONA=ecosystem_architect` or `MISSION_ROLE=knowledge_steward` to the environment configuration to authorize access.'
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
    test: (m, code) => /ECONNREFUSED|connection[\s_-]?refused/i.test(m) || code === 'ECONNREFUSED',
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
    test: (m) => /schema validation|ajv|invalid (input|payload|adf)|preflight failed/i.test(m),
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
