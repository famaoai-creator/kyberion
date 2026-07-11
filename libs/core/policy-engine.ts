import yaml from 'js-yaml';
import { logger } from './core.js';
import { safeReadFile, safeExistsSync } from './secure-io.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';

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
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains' | 'matches';
  value: any;
  condition_field?: string;
  condition_operator?: string;
  condition_value?: any;
  action: 'allow' | 'deny' | 'block' | 'audit';
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
  [key: string]: any;
}

class PolicyEngineImpl {
  private policies: Policy[] = [];
  private declaredPolicyCount = 0;
  private rateLimitCounters: Map<string, { count: number; windowStart: number }> = new Map();

  loadFromFile(filePath?: string): void {
    const root = pathResolver.rootDir();
    const policyPath =
      filePath || path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml');

    if (!safeExistsSync(policyPath)) {
      logger.warn(`[POLICY_ENGINE] Policy file not found: ${policyPath}`);
      return;
    }

    const content = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    // SA-05: a hand-rolled "simple YAML" parser silently produced empty
    // rules arrays for every policy (nested lists were unsupported), so the
    // engine never enforced anything. Parse with js-yaml; a parse failure
    // leaves zero policies loaded, and evaluate() fails closed on that.
    let parsed: any;
    try {
      parsed = yaml.load(content);
    } catch (err: any) {
      logger.error(`[POLICY_ENGINE] Failed to parse ${policyPath}: ${err?.message || err}`);
      return;
    }

    if (parsed?.policies && Array.isArray(parsed.policies)) {
      this.declaredPolicyCount = parsed.policies.length;
      this.policies = parsed.policies.filter(
        (policy: any) =>
          policy &&
          typeof policy === 'object' &&
          Array.isArray(policy.rules) &&
          policy.rules.length > 0
      );
      const dropped = parsed.policies.length - this.policies.length;
      if (dropped > 0) {
        // Task 2.3: never run silently on fewer rules than the file declares.
        logger.warn(
          `[POLICY_ENGINE] ${dropped} policy(ies) dropped (no parseable rules) — check ${policyPath}`
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
            (rule.condition_operator as any) || 'eq',
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

  private evalOperator(fieldValue: any, operator: PolicyRule['operator'], ruleValue: any): boolean {
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
