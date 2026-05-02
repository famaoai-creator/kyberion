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
  private rateLimitCounters: Map<string, { count: number; windowStart: number }> = new Map();

  loadFromFile(filePath?: string): void {
    const root = pathResolver.rootDir();
    const policyPath = filePath || path.join(root, 'knowledge', 'governance', 'agent-policies.yaml');

    if (!safeExistsSync(policyPath)) {
      logger.warn(`[POLICY_ENGINE] Policy file not found: ${policyPath}`);
      return;
    }

    const content = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    const parsed = parseSimpleYaml(content);

    if (parsed.policies && Array.isArray(parsed.policies)) {
      this.policies = parsed.policies;
      logger.info(`[POLICY_ENGINE] Loaded ${this.policies.length} policies`);
    }
  }

  evaluate(context: PolicyContext): PolicyDecision {
    if (this.policies.length === 0) this.loadFromFile();

    const decisions: { policy: string; rule: PolicyRule; result: boolean }[] = [];

    for (const policy of this.policies) {
      if (!Array.isArray(policy.rules)) continue;
      for (const rule of policy.rules) {
        // Check conditional (if present)
        if (rule.condition_field) {
          const condMet = this.evalOperator(
            context[rule.condition_field],
            rule.condition_operator as any || 'eq',
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
      logger.info(`[POLICY_AUDIT] ${winner.policy}: ${winner.rule.message || 'action audited'} (agent: ${context.agentId})`);
    }

    if (!allowed) {
      logger.warn(`[POLICY_DENIED] ${winner.policy}: ${winner.rule.message || 'action denied'} (agent: ${context.agentId}, op: ${context.operation})`);
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
      case 'eq': return fieldValue === ruleValue;
      case 'ne': return fieldValue !== ruleValue;
      case 'gt': return Number(fieldValue) > Number(ruleValue);
      case 'lt': return Number(fieldValue) < Number(ruleValue);
      case 'gte': return Number(fieldValue) >= Number(ruleValue);
      case 'lte': return Number(fieldValue) <= Number(ruleValue);
      case 'in': return Array.isArray(ruleValue) && ruleValue.includes(fieldValue);
      case 'contains': return typeof fieldValue === 'string' && fieldValue.includes(String(ruleValue));
      case 'matches': {
        try {
          const pattern = String(ruleValue);
          // ReDoS protection: reject overly complex patterns
          if (pattern.length > 200 || /(\+\+|\*\*|\{\d{3,}\})/.test(pattern)) {
            logger.warn(`[POLICY_ENGINE] Rejected complex regex: ${pattern.slice(0, 50)}...`);
            return false;
          }
          return new RegExp(pattern).test(String(fieldValue || ''));
        } catch { return false; }
      }
      default: return false;
    }
  }

  private checkRateLimit(agentId: string, rule: PolicyRule): boolean {
    if (!rule.rate_limit) return false;
    const key = `${agentId}:${rule.field}`;
    const now = Date.now();
    const windowMs = rule.rate_limit.window_seconds * 1000;

    let counter = this.rateLimitCounters.get(key);
    if (!counter || (now - counter.windowStart) > windowMs) {
      counter = { count: 0, windowStart: now };
    }
    counter.count++;
    this.rateLimitCounters.set(key, counter);

    return counter.count > rule.rate_limit.max;
  }
}

/** Minimal YAML parser for our policy format */
function parseSimpleYaml(content: string): any {
  const result: any = {};
  const lines = content.split('\n');
  const stack: { indent: number; obj: any; key: string }[] = [{ indent: -1, obj: result, key: '' }];
  let currentArray: any[] | null = null;
  let currentArrayKey = '';
  let currentArrayIndent = 0;
  let currentItem: any = null;

  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Array item
    if (trimmed.startsWith('- ')) {
      const itemContent = trimmed.slice(2).trim();
      const kv = itemContent.match(/^(\w+):\s*(.*)$/);

      if (kv) {
        if (currentItem) {
          if (currentArray) currentArray.push(currentItem);
        }
        currentItem = {};
        currentItem[kv[1]] = parseYamlValue(kv[2]);
      } else {
        if (currentArray) currentArray.push(parseYamlValue(itemContent));
      }
      continue;
    }

    // Key-value
    const kv = trimmed.match(/^(\w[\w_]*):\s*(.*)$/);
    if (kv) {
      const [, key, rawVal] = kv;
      const val = rawVal.trim();

      if (currentItem && indent > currentArrayIndent + 2) {
        currentItem[key] = parseYamlValue(val);
        continue;
      }

      if (currentItem) {
        if (currentArray) currentArray.push(currentItem);
        currentItem = null;
      }

      if (val === '' || val === undefined) {
        // This is a parent key — next lines are children
        if (indent === 0) {
          result[key] = [];
          currentArray = result[key];
          currentArrayKey = key;
          currentArrayIndent = indent;
        }
      } else {
        result[key] = parseYamlValue(val);
      }
    }
  }

  if (currentItem && currentArray) {
    currentArray.push(currentItem);
  }

  return result;
}

function parseYamlValue(raw: string): any {
  if (!raw || raw === '""' || raw === "''") return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (!isNaN(Number(raw)) && raw !== '') return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

const GLOBAL_KEY = Symbol.for('@kyberion/policy-engine');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new PolicyEngineImpl();
}
export const policyEngine: PolicyEngineImpl = (globalThis as any)[GLOBAL_KEY];
