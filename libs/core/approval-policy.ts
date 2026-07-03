import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export interface ApprovalPolicyRule {
  id: string;
  intent_ids?: string[];
  when?: {
    payload_field?: string;
    any_of?: string[];
  };
  requires_approval: boolean;
  missing_requirements?: string[];
}

interface ApprovalPolicyFile {
  rules?: ApprovalPolicyRule[];
  defaults?: {
    requires_approval?: boolean;
  };
}

export interface ApprovalPolicyResolution {
  requiresApproval: boolean;
  missingRequirements: string[];
  matchedRuleId?: string;
}

let approvalPolicyCache: ApprovalPolicyFile | null = null;

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
  if (approvalPolicyCache) return approvalPolicyCache;
  const customerPolicyPath = customerResolver.customerRoot('policy/approval-policy.json');
  const filePath =
    customerPolicyPath && safeExistsSync(customerPolicyPath)
      ? customerPolicyPath
      : pathResolver.knowledge('product/governance/approval-policy.json');
  try {
    approvalPolicyCache = JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as ApprovalPolicyFile;
  } catch {
    approvalPolicyCache = { rules: [], defaults: { requires_approval: false } };
  }
  return approvalPolicyCache;
}

export function resolveApprovalPolicy(input: {
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
