/**
 * Policy Category — front-of-Grant classification for actuator effects.
 *
 * Absorbed from PiBot's CategorySchema × never/ask/always matrix. This module
 * names the kind of effect an op may attempt and returns allow | ask | deny
 * with a stable reason code. Grant / SoD / dual-key stay downstream.
 *
 * @see knowledge/product/architecture/pibot-absorption-model.md
 */

export const POLICY_CATEGORIES = [
  'run_command',
  'read_file',
  'list_dir',
  'write_file',
  'web',
  'send_out',
  'connector',
  'computer',
  'read_messages',
  'agent_delegation',
  'image_generation',
  'tool_discovery',
  'planning',
  'memory',
  'review',
] as const;

export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const POLICY_LEVELS = ['never', 'ask', 'always'] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export const POLICY_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export type PolicyPlatform = (typeof POLICY_PLATFORMS)[number];

export type PolicyDecision = 'allow' | 'ask' | 'deny';

/** Categories that must never escalate to standing Always (Always → Grant). */
export const POLICY_ALWAYS_FORBIDDEN: ReadonlySet<PolicyCategory> = new Set([
  'send_out',
  'image_generation',
]);

export interface PolicyCategoryFacts {
  category: PolicyCategory;
  level: PolicyLevel;
  platform: PolicyPlatform;
  /** Path leaves the workspace / sandbox boundary. */
  outside_workspace?: boolean;
  /** Path matches a protected / sensitive prefix. */
  protected_path?: boolean;
  /** Isolation / sandbox is available for always-allow run_command. */
  sandboxed?: boolean;
  /** Script / command analysis was incomplete. */
  incomplete_analysis?: boolean;
  /** Category is unavailable on this host (e.g. connector missing). */
  unavailable?: boolean;
}

export interface PolicyCategoryVerdict {
  decision: PolicyDecision;
  reason_code: string;
}

export function isPolicyCategory(value: unknown): value is PolicyCategory {
  return typeof value === 'string' && (POLICY_CATEGORIES as readonly string[]).includes(value);
}

export function isPolicyLevel(value: unknown): value is PolicyLevel {
  return typeof value === 'string' && (POLICY_LEVELS as readonly string[]).includes(value);
}

export function isPolicyPlatform(value: unknown): value is PolicyPlatform {
  return typeof value === 'string' && (POLICY_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Evaluate a Policy Category cell. Hermetic: facts are caller-supplied;
 * never touches the network or the operator home directory.
 */
export function evaluatePolicyCategory(facts: PolicyCategoryFacts): PolicyCategoryVerdict {
  const { category, level, platform } = facts;

  if (facts.unavailable) {
    return { decision: 'deny', reason_code: `${category}_unavailable` };
  }

  if (facts.protected_path) {
    if (category === 'write_file') {
      return { decision: 'deny', reason_code: 'protected_path' };
    }
    return { decision: 'deny', reason_code: 'sensitive_path' };
  }

  // Metadata / planning / memory categories stay allow regardless of never/ask/always
  // (PiBot matrix: planning / tool_discovery / review / memory rows).
  if (category === 'tool_discovery' || category === 'planning' || category === 'review') {
    return {
      decision: 'allow',
      reason_code:
        category === 'tool_discovery'
          ? 'scoped_tool_metadata'
          : category === 'planning'
            ? 'planning_metadata'
            : 'review_note_readonly',
    };
  }

  if (category === 'memory') {
    return { decision: 'allow', reason_code: 'bot_owned_memory' };
  }

  if (level === 'never') {
    return { decision: 'deny', reason_code: 'permission_never' };
  }

  if (category === 'send_out') {
    return { decision: 'ask', reason_code: 'user_send_confirmation' };
  }

  if (category === 'image_generation') {
    return { decision: 'ask', reason_code: 'paid_generation_confirmation' };
  }

  if (category === 'run_command') {
    if (platform === 'win32' && (level === 'ask' || level === 'always')) {
      return { decision: 'ask', reason_code: 'windows_requires_approval' };
    }
    if (level === 'ask') {
      if (facts.incomplete_analysis) {
        return { decision: 'ask', reason_code: 'incomplete_analysis' };
      }
      return { decision: 'allow', reason_code: 'readonly_command' };
    }
    // always
    if (!facts.sandboxed && platform !== 'darwin' && platform !== 'linux') {
      return { decision: 'ask', reason_code: 'windows_requires_approval' };
    }
    if (!facts.sandboxed) {
      return { decision: 'ask', reason_code: 'isolation_required' };
    }
    return { decision: 'allow', reason_code: 'sandboxed_command' };
  }

  if (category === 'computer' && level === 'always') {
    return { decision: 'ask', reason_code: 'computer_app_not_in_always_list' };
  }

  if (facts.outside_workspace) {
    if (category === 'write_file') {
      return { decision: 'ask', reason_code: 'outside_workplace_write' };
    }
    // Outside workspace: always cannot silently widen; ask even at always.
    if (level === 'always') {
      return { decision: 'ask', reason_code: 'permission_ask' };
    }
    return { decision: 'ask', reason_code: 'permission_ask' };
  }

  if (level === 'ask') {
    return { decision: 'ask', reason_code: 'permission_ask' };
  }

  // always
  if (POLICY_ALWAYS_FORBIDDEN.has(category)) {
    return { decision: 'ask', reason_code: 'always_forbidden' };
  }

  return { decision: 'allow', reason_code: 'permission_always' };
}

/** Whether an Always (standing / session) primary action may be offered. */
export function allowsAlwaysPrimaryAction(category: PolicyCategory | undefined): boolean {
  // Fail-closed: Always requires a known non-forbidden category.
  if (!category) return false;
  return !POLICY_ALWAYS_FORBIDDEN.has(category);
}

export function formatPolicyVerdict(verdict: PolicyCategoryVerdict): string {
  return `${verdict.decision}:${verdict.reason_code}`;
}
