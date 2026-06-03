import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { recordConfigFallback } from './config-fallback-registry.js';
import { recordUnclassifiedError } from './unclassified-error-registry.js';

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
  test: (message: string, code?: string | number) => boolean;
  repairAction?: string;
}

interface RuleFileEntry {
  id: string;
  category: ErrorCategory;
  label: string;
  remediation: string;
  patterns: string[];
  codes?: string[];
  repairAction?: string;
}

interface PolicyViolationFileEntry {
  pattern: string;
  violation_type: PolicyViolationType;
  explanation: string;
  required_role?: string;
  required_authority?: string;
  repair_steps: string[];
}

interface ErrorClassifierRulesFile {
  rules: RuleFileEntry[];
  policy_violation_patterns: PolicyViolationFileEntry[];
}

function buildTestFn(entry: RuleFileEntry): (m: string, code?: string | number) => boolean {
  const regexps = entry.patterns.map(p => new RegExp(p, 'i'));
  const codes = new Set(entry.codes || []);
  return (m, code) =>
    regexps.some(re => re.test(m)) ||
    (codes.size > 0 && code !== undefined && codes.has(String(code)));
}

let _cachedRules: ClassifierRule[] | null = null;
let _cachedPolicyPatterns: typeof POLICY_VIOLATION_PATTERNS | null = null;

function loadClassifierRules(): ClassifierRule[] {
  if (_cachedRules) return _cachedRules;
  try {
    const filePath = pathResolver.knowledge('product/governance/error-classifier-rules.json');
    const data = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ErrorClassifierRulesFile;
    _cachedRules = data.rules.map(entry => ({
      id: entry.id,
      category: entry.category,
      label: entry.label,
      remediation: entry.remediation,
      test: buildTestFn(entry),
      repairAction: entry.repairAction,
    }));
  } catch (err) {
    recordConfigFallback({ knowledgePath: 'product/governance/error-classifier-rules.json', error: err, defaults: { rules: [], policy_violation_patterns: [] } });
    _cachedRules = [];
  }
  return _cachedRules;
}

function loadPolicyViolationPatterns(): typeof POLICY_VIOLATION_PATTERNS {
  if (_cachedPolicyPatterns) return _cachedPolicyPatterns;
  try {
    const filePath = pathResolver.knowledge('product/governance/error-classifier-rules.json');
    const data = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ErrorClassifierRulesFile;
    _cachedPolicyPatterns = data.policy_violation_patterns.map(entry => ({
      pattern: new RegExp(entry.pattern, 'i'),
      violationType: entry.violation_type,
      explanation: entry.explanation,
      requiredRole: entry.required_role,
      requiredAuthority: entry.required_authority,
      repairSteps: entry.repair_steps,
    }));
  } catch (err) {
    recordConfigFallback({ knowledgePath: 'product/governance/error-classifier-rules.json', error: err, defaults: { rules: [], policy_violation_patterns: [] } });
    _cachedPolicyPatterns = [];
  }
  return _cachedPolicyPatterns;
}

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

type PolicyViolationPattern = {
  pattern: RegExp;
  violationType: PolicyViolationType;
  explanation: string;
  requiredRole?: string;
  requiredAuthority?: string;
  repairSteps: string[];
};

// Alias for loadPolicyViolationPatterns return type (resolved at runtime from JSON)
const POLICY_VIOLATION_PATTERNS: PolicyViolationPattern[] = [];

/**
 * Produce a structured diagnosis for a POLICY_VIOLATION error string.
 * Returns the violation type, required role/authority, and ordered repair steps.
 * Call this when `classifyError()` returns category 'governance_block' or 'permission_denied'
 * to present actionable guidance to the operator.
 */
export function explainPolicyViolation(errorText: string): PolicyViolationDiagnostic {
  for (const entry of loadPolicyViolationPatterns()) {
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

  for (const rule of loadClassifierRules()) {
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

  recordUnclassifiedError(message, code);
  return {
    category: 'unknown',
    label: 'Unclassified error',
    remediation:
      'No rule matched this error. The error has been recorded in the unclassified-error registry for rule proposal.',
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
  return loadClassifierRules().map(r => r.id);
}
