import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

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

export function loadApprovalPolicy(): ApprovalPolicyFile {
  if (approvalPolicyCache) return approvalPolicyCache;
  const filePath = pathResolver.knowledge('public/governance/approval-policy.json');
  approvalPolicyCache = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ApprovalPolicyFile;
  return approvalPolicyCache;
}

export function resolveApprovalPolicy(input: {
  intentId?: string;
  payload?: Record<string, unknown>;
}): ApprovalPolicyResolution {
  const policy = loadApprovalPolicy();
  for (const rule of policy.rules || []) {
    if (rule.intent_ids?.length && (!input.intentId || !rule.intent_ids.includes(input.intentId))) continue;
    const payloadField = rule.when?.payload_field;
    if (payloadField) {
      const candidate = input.payload?.[payloadField];
      const acceptedValues = rule.when?.any_of || [];
      if (!acceptedValues.some((value) => value === candidate)) continue;
    }
    return {
      requiresApproval: rule.requires_approval,
      missingRequirements: Array.isArray(rule.missing_requirements) ? [...rule.missing_requirements] : [],
      matchedRuleId: rule.id,
    };
  }

  return {
    requiresApproval: Boolean(policy.defaults?.requires_approval),
    missingRequirements: [],
  };
}
