import * as yaml from 'js-yaml';
import { createLogger } from './logger.js';
import { getFoundationIo } from './foundation/io.js';
import { isRecord, readTextFile } from './foundation/text.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

const logger = createLogger('policy-engine');

const POLICY_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'lt',
  'gte',
  'lte',
  'in',
  'contains',
  'matches',
] as const;
const POLICY_ACTIONS = ['allow', 'deny', 'block', 'audit'] as const;
type PolicyOperator = (typeof POLICY_OPERATORS)[number];
type PolicyAction = (typeof POLICY_ACTIONS)[number];

/**
 * Declarative Policy Engine v1.0
 *
 * Evaluates YAML-defined governance rules against agent actions.
 * Inspired by Microsoft Agent Governance Toolkit.
 *
 * Operators: eq, ne, gt, lt, gte, lte, in, contains, matches
 * Actions: allow, deny, block, audit
 * Conflict resolution: highest priority wins; if same priority, most restrictive wins
 */

export interface PolicyRule {
  field: string;
  operator: PolicyOperator;
  value: unknown;
  condition_field?: string;
  condition_operator?: PolicyRule['operator'];
  condition_value?: unknown;
  action: PolicyAction;
  priority: number;
  message?: string;
  rate_limit?: { max: number; window_seconds: number; message?: string };
}

export interface Policy {
  name: string;
  description?: string;
  rules: PolicyRule[];
}

export interface PolicyDecision {
  allowed: boolean;
  action: 'allow' | 'deny' | 'block' | 'audit';
  matchedPolicy?: string;
  matchedRule?: PolicyRule;
  message?: string;
  rateLimited?: boolean;
}

export interface PolicyContext {
  agentId: string;
  operation: string;
  message?: string;
  target_tier?: string;
  agent_tier?: string;
  agent_ring?: number;
  delegation_depth?: number;
  has_capability?: boolean;
  [key: string]: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalEnum<const T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeRateLimit(value: unknown): PolicyRule['rate_limit'] | undefined {
  if (!isRecord(value)) return undefined;
  const max = optionalFiniteNumber(value.max);
  const windowSeconds = optionalFiniteNumber(value.window_seconds);
  if (
    max === undefined ||
    windowSeconds === undefined ||
    max < 0 ||
    !Number.isSafeInteger(max) ||
    windowSeconds <= 0
  ) {
    return undefined;
  }
  return {
    max,
    window_seconds: windowSeconds,
    ...(nonEmptyString(value.message) ? { message: value.message } : {}),
  };
}

function normalizePolicyRule(value: unknown): PolicyRule | null {
  if (!isRecord(value)) return null;
  const operator = optionalEnum(value.operator, POLICY_OPERATORS);
  const action = optionalEnum(value.action, POLICY_ACTIONS);
  const priority = optionalFiniteNumber(value.priority);
  if (
    !nonEmptyString(value.field) ||
    operator === undefined ||
    action === undefined ||
    priority === undefined ||
    !Number.isSafeInteger(priority) ||
    !Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return null;
  }
  const conditionField =
    value.condition_field === undefined
      ? undefined
      : nonEmptyString(value.condition_field)
        ? value.condition_field
        : null;
  const conditionOperator =
    value.condition_operator === undefined
      ? undefined
      : optionalEnum(value.condition_operator, POLICY_OPERATORS);
  if (
    conditionField === null ||
    (value.condition_operator !== undefined && conditionOperator === undefined)
  ) {
    return null;
  }
  const rateLimit =
    value.rate_limit === undefined ? undefined : normalizeRateLimit(value.rate_limit);
  if (value.rate_limit !== undefined && rateLimit === undefined) return null;
  return {
    field: value.field,
    operator,
    value: value.value,
    ...(conditionField !== undefined ? { condition_field: conditionField } : {}),
    ...(conditionOperator !== undefined ? { condition_operator: conditionOperator } : {}),
    ...(value.condition_value !== undefined ? { condition_value: value.condition_value } : {}),
    action,
    priority,
    ...(nonEmptyString(value.message) ? { message: value.message } : {}),
    ...(rateLimit !== undefined ? { rate_limit: rateLimit } : {}),
  };
}

function normalizePolicy(value: unknown): Policy | null {
  if (!isRecord(value) || !nonEmptyString(value.name) || !Array.isArray(value.rules)) return null;
  const rules = value.rules
    .map((rule) => normalizePolicyRule(rule))
    .filter((rule): rule is PolicyRule => rule !== null);
  if (rules.length === 0) return null;
  return {
    name: value.name,
    ...(nonEmptyString(value.description) ? { description: value.description } : {}),
    rules,
  };
}

class PolicyEngineImpl {
  private policies: Policy[] = [];
  private declaredPolicyCount = 0;
  private rateLimitCounters: Map<string, { count: number; windowStart: number }> = new Map();

  loadFromFile(filePath?: string): void {
    this.policies = [];
    this.declaredPolicyCount = 0;
    const root = pathResolver.rootDir();
    const policyPath =
      filePath || path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml');

    let safePolicyPath: string;
    try {
      safePolicyPath = assertSafeRepositoryPath(policyPath, { allowMissingLeaf: true });
      if (!getFoundationIo().exists(safePolicyPath)) {
        logger.warn(`[POLICY_ENGINE] Policy file not found: ${safePolicyPath}`);
        return;
      }
      if (!safeLstat(safePolicyPath).isFile()) {
        logger.warn(`[POLICY_ENGINE] Policy path is not a regular file: ${safePolicyPath}`);
        return;
      }
    } catch (error: unknown) {
      logger.warn(
        `[POLICY_ENGINE] Policy path rejected: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const content = readTextFile(safePolicyPath);
    // SA-05: a hand-rolled "simple YAML" parser silently produced empty
    // rules arrays for every policy (nested lists were unsupported), so the
    // engine never enforced anything. Parse with js-yaml; a parse failure
    // leaves zero policies loaded, and evaluate() fails closed on that.
    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (err: unknown) {
      logger.error(
        `[POLICY_ENGINE] Failed to parse ${safePolicyPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const declaredPolicies =
      isRecord(parsed) && Array.isArray(parsed.policies) ? parsed.policies : [];
    this.declaredPolicyCount = declaredPolicies.length;
    this.policies = declaredPolicies
      .map((policy) => normalizePolicy(policy))
      .filter((policy): policy is Policy => policy !== null);
    if (declaredPolicies.length > 0) {
      const dropped = declaredPolicies.length - this.policies.length;
      if (dropped > 0) {
        // Task 2.3: never run silently on fewer rules than the file declares.
        logger.warn(
          `[POLICY_ENGINE] ${dropped} policy(ies) dropped (no parseable rules) — check ${safePolicyPath}`
        );
      }
      logger.info(`[POLICY_ENGINE] Loaded ${this.policies.length} policies`);
    }
  }

  /** SA-05 Task 4: declared vs loaded so silent shrink is visible to doctor. */
  getPolicyCounts(): { loaded: number; declared: number } {
    if (this.policies.length === 0) this.loadFromFile();
    return { loaded: this.policies.length, declared: this.declaredPolicyCount };
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (this.policies.length === 0) this.loadFromFile();
    if (this.policies.length === 0) {
      return {
        allowed: false,
        action: 'deny',
        message: 'Policy engine has no loaded policies; failing closed.',
      };
    }

    const decisions: { policy: string; rule: PolicyRule; result: boolean }[] = [];

    for (const policy of this.policies) {
      if (!Array.isArray(policy.rules)) continue;
      for (const rule of policy.rules) {
        // Check conditional (if present)
        if (rule.condition_field) {
          const condMet = this.evalOperator(
            context[rule.condition_field],
            rule.condition_operator || 'eq',
            rule.condition_value
          );
          if (!condMet) continue;
        }

        const fieldValue = context[rule.field];
        const matched = this.evalOperator(fieldValue, rule.operator, rule.value);

        if (matched) {
          // Check rate limit
          if (rule.rate_limit) {
            const limited = this.checkRateLimit(context.agentId, rule);
            if (limited) {
              return {
                allowed: false,
                action: 'deny',
                matchedPolicy: policy.name,
                matchedRule: rule,
                message: rule.rate_limit.message || 'Rate limit exceeded',
                rateLimited: true,
              };
            }
          }

          decisions.push({ policy: policy.name, rule, result: true });
        }
      }
    }

    if (decisions.length === 0) {
      return { allowed: true, action: 'allow' };
    }

    // Resolve conflicts: highest priority, most restrictive
    decisions.sort((a, b) => {
      if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
      const restrictiveness = { block: 3, deny: 2, audit: 1, allow: 0 };
      return (restrictiveness[b.rule.action] || 0) - (restrictiveness[a.rule.action] || 0);
    });

    const winner = decisions[0];
    const allowed = winner.rule.action === 'allow' || winner.rule.action === 'audit';

    if (winner.rule.action === 'audit') {
      logger.info(
        `[POLICY_AUDIT] ${winner.policy}: ${winner.rule.message || 'action audited'} (agent: ${context.agentId})`
      );
    }

    if (!allowed) {
      logger.warn(
        `[POLICY_DENIED] ${winner.policy}: ${winner.rule.message || 'action denied'} (agent: ${context.agentId}, op: ${context.operation})`
      );
    }

    return {
      allowed,
      action: winner.rule.action,
      matchedPolicy: winner.policy,
      matchedRule: winner.rule,
      message: winner.rule.message,
    };
  }

  private evalOperator(
    fieldValue: unknown,
    operator: PolicyRule['operator'],
    ruleValue: unknown
  ): boolean {
    switch (operator) {
      case 'eq':
        return fieldValue === ruleValue;
      case 'ne':
        return fieldValue !== ruleValue;
      case 'gt':
        return Number(fieldValue) > Number(ruleValue);
      case 'lt':
        return Number(fieldValue) < Number(ruleValue);
      case 'gte':
        return Number(fieldValue) >= Number(ruleValue);
      case 'lte':
        return Number(fieldValue) <= Number(ruleValue);
      case 'in':
        return Array.isArray(ruleValue) && ruleValue.includes(fieldValue);
      case 'contains':
        return typeof fieldValue === 'string' && fieldValue.includes(String(ruleValue));
      case 'matches': {
        try {
          let pattern = String(ruleValue);
          // ReDoS protection: reject overly complex patterns
          if (pattern.length > 200 || /(\+\+|\*\*|\{\d{3,}\})/.test(pattern)) {
            logger.warn(`[POLICY_ENGINE] Rejected complex regex: ${pattern.slice(0, 50)}...`);
            return false;
          }
          // SA-05: the policy file uses PCRE-style '(?i)' which JS RegExp
          // rejects — every 'matches' rule using it silently never fired
          // (the constructor threw into the catch below). Map it to the
          // 'i' flag instead.
          let flags = '';
          if (pattern.startsWith('(?i)')) {
            flags = 'i';
            pattern = pattern.slice(4);
          }
          return new RegExp(pattern, flags).test(String(fieldValue || ''));
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  }

  private checkRateLimit(agentId: string, rule: PolicyRule): boolean {
    if (!rule.rate_limit) return false;
    const key = `${agentId}:${rule.field}`;
    const now = Date.now();
    const windowMs = rule.rate_limit.window_seconds * 1000;

    let counter = this.rateLimitCounters.get(key);
    if (!counter || now - counter.windowStart > windowMs) {
      counter = { count: 0, windowStart: now };
    }
    counter.count++;
    this.rateLimitCounters.set(key, counter);

    return counter.count > rule.rate_limit.max;
  }
}

/** Minimal YAML parser for our policy format */
const GLOBAL_KEY = Symbol.for('@kyberion/policy-engine');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new PolicyEngineImpl();
}
export const policyEngine: PolicyEngineImpl = (globalThis as any)[GLOBAL_KEY];
