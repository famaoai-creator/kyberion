/**
 * What to do when a pane agent stops and asks.
 *
 * `agent-runtime-readiness.ts` answers "is it waiting for a person?". This
 * answers "then what?", in three rungs:
 *
 * 1. Don't get asked. `launch_args` carries a provider's non-interactive or
 *    permission-mode flags. Empty by default — those flags widen what an
 *    agent may do unasked, so they are an installation's decision.
 * 2. Answer what the installation has said may be answered. `auto_answer`
 *    rules match a prompt by signature and conditions (a trust prompt only
 *    under listed paths, a confirmation only when its text matches). Rules
 *    that could answer anything are ignored, and sign-in, device-code and
 *    terms prompts are never auto-answered whatever a rule says.
 * 3. Otherwise ask a person. The prompt becomes an approval request; the
 *    decision is relayed to the pane as keys (`relay_keys`).
 *
 * Policy: `knowledge/product/governance/agent-prompt-response-policy.json`,
 * overlaid by `knowledge/personal/governance/agent-prompt-response-policy.json`
 * — the product file ships the defaults, the personal file is where an
 * installation customizes the allowlist.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';
import { createLogger } from './logger.js';

const logger = createLogger('agent-prompt-response');

export type AutoAnswerableSignature =
  'workspace_trust' | 'update_available' | 'generic_confirm' | 'agent_blocked';

export interface AutoAnswerRule {
  id: string;
  signature: AutoAnswerableSignature;
  providers?: string[];
  cwd_prefixes?: string[];
  excerpt_pattern?: string;
  keys: string[];
  note?: string;
}

export interface RelayKeys {
  approve: string[];
  reject: string[];
}

export interface AgentPromptResponsePolicy {
  version: string;
  launch_args?: Record<string, string[]>;
  auto_answer?: AutoAnswerRule[];
  relay_keys?: Record<string, RelayKeys>;
  escalation_wait_ms?: number;
}

/**
 * Prompts no rule may answer. Signing in and device codes need a person's
 * credentials, and accepting terms is a person's agreement — a key press
 * sent on their behalf is not either.
 */
export const NEVER_AUTO_ANSWER = new Set(['sign_in', 'device_code', 'terms_or_consent']);

/**
 * Prompts an approval cannot answer: the person has to act in the pane or a
 * browser. Escalating them as approve/reject would relay a key press that
 * does nothing useful.
 */
const NOT_RELAYABLE = new Set(['sign_in', 'device_code']);

const FALLBACK_RELAY_KEYS: RelayKeys = { approve: ['enter'], reject: ['esc'] };
export const DEFAULT_ESCALATION_WAIT_MS = 300_000;

const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/agent-prompt-response-policy.schema.json'
);
const PRODUCT_POLICY_PATH = pathResolver.knowledge(
  'product/governance/agent-prompt-response-policy.json'
);
const PERSONAL_POLICY_PATH = pathResolver.knowledge(
  'personal/governance/agent-prompt-response-policy.json'
);

const productCatalog = defineCatalog<AgentPromptResponsePolicy>({
  id: 'agent-prompt-response-policy.product',
  path: PRODUCT_POLICY_PATH,
  schema: SCHEMA_PATH,
});

const personalCatalog = defineCatalog<AgentPromptResponsePolicy>({
  id: 'agent-prompt-response-policy.personal',
  path: PERSONAL_POLICY_PATH,
  schema: SCHEMA_PATH,
});

/**
 * Overlay one policy on another. Launch args and relay keys are replaced per
 * key; auto-answer rules are added, and a rule with the same id replaces the
 * base rule — so an installation can both extend and override.
 */
export function mergeAgentPromptResponsePolicies(
  base: AgentPromptResponsePolicy,
  overlay: Partial<AgentPromptResponsePolicy>
): AgentPromptResponsePolicy {
  const rules = new Map<string, AutoAnswerRule>();
  for (const rule of base.auto_answer ?? []) rules.set(rule.id, rule);
  for (const rule of overlay.auto_answer ?? []) rules.set(rule.id, rule);
  return {
    version: overlay.version || base.version,
    launch_args: { ...(base.launch_args ?? {}), ...(overlay.launch_args ?? {}) },
    auto_answer: Array.from(rules.values()),
    relay_keys: { ...(base.relay_keys ?? {}), ...(overlay.relay_keys ?? {}) },
    escalation_wait_ms: overlay.escalation_wait_ms ?? base.escalation_wait_ms,
  };
}

/**
 * Load the effective policy. Never throws: an unreadable product file falls
 * back to "answer nothing, escalate everything", and an unreadable personal
 * file is ignored with a warning — neither may turn into answering prompts.
 */
export function loadAgentPromptResponsePolicy(): AgentPromptResponsePolicy {
  let base: AgentPromptResponsePolicy = { version: '0.0.0' };
  try {
    base = productCatalog.load();
  } catch (error: unknown) {
    logger.warn(
      `[agent-prompt-response] product policy unreadable, escalating every prompt: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!safeExistsSync(PERSONAL_POLICY_PATH)) return mergeAgentPromptResponsePolicies(base, {});
  try {
    return mergeAgentPromptResponsePolicies(base, personalCatalog.load());
  } catch (error: unknown) {
    logger.warn(
      `[agent-prompt-response] personal policy ignored: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return mergeAgentPromptResponsePolicies(base, {});
  }
}

/** Launch args for a provider, falling back to its herdr kind. */
export function resolveAgentLaunchArgs(
  policy: AgentPromptResponsePolicy,
  provider: string,
  kind?: string
): string[] {
  const table = policy.launch_args ?? {};
  const args = table[provider] ?? (kind ? table[kind] : undefined) ?? [];
  return [...args];
}

export interface AgentPromptContext {
  /** From classifyAgentReadiness, or `agent_blocked` when only herdr knows. */
  signatureId: string;
  provider: string;
  kind?: string;
  cwd: string;
  excerpt: string;
}

export type AgentPromptDecision =
  | { action: 'auto_answer'; keys: string[]; ruleId: string; reason: string }
  | { action: 'escalate'; relay: RelayKeys; waitMs: number; reason: string }
  | { action: 'human_only'; reason: string };

function expandPrefix(prefix: string): string {
  const root = pathResolver.rootDir();
  return path.resolve(
    prefix.replace('{repo_parent}', path.dirname(root)).replace('{repo_root}', root)
  );
}

function cwdUnder(cwd: string, prefixes: string[]): boolean {
  const resolved = path.resolve(cwd);
  return prefixes.some((prefix) => {
    const base = expandPrefix(prefix);
    return (
      resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
    );
  });
}

/** Why a rule cannot be used at all, or null when it is well-formed. */
export function unusableRuleReason(rule: AutoAnswerRule): string | null {
  if (NEVER_AUTO_ANSWER.has(rule.signature)) {
    return `'${rule.signature}' prompts are never auto-answered`;
  }
  if (rule.signature === 'workspace_trust' && !rule.cwd_prefixes?.length) {
    return 'a workspace_trust rule must name cwd_prefixes — trust is granted per path';
  }
  if (
    (rule.signature === 'generic_confirm' || rule.signature === 'agent_blocked') &&
    !rule.excerpt_pattern
  ) {
    return `a ${rule.signature} rule must declare excerpt_pattern — otherwise it answers any question`;
  }
  if (rule.excerpt_pattern) {
    try {
      new RegExp(rule.excerpt_pattern, 'i');
    } catch {
      return `excerpt_pattern is not a valid regular expression`;
    }
  }
  return null;
}

function ruleMatches(rule: AutoAnswerRule, context: AgentPromptContext): boolean {
  if (rule.signature !== context.signatureId) return false;
  if (
    rule.providers?.length &&
    !rule.providers.includes(context.provider) &&
    !(context.kind && rule.providers.includes(context.kind))
  ) {
    return false;
  }
  if (rule.cwd_prefixes?.length && !cwdUnder(context.cwd, rule.cwd_prefixes)) return false;
  if (rule.excerpt_pattern && !new RegExp(rule.excerpt_pattern, 'i').test(context.excerpt)) {
    return false;
  }
  return true;
}

/** Decide how to respond to one prompt. Pure; the adapter carries it out. */
export function decideAgentPromptResponse(
  policy: AgentPromptResponsePolicy,
  context: AgentPromptContext
): AgentPromptDecision {
  if (NOT_RELAYABLE.has(context.signatureId)) {
    return {
      action: 'human_only',
      reason: `'${context.signatureId}' needs a person to act in the pane; it cannot be approved remotely`,
    };
  }

  if (!NEVER_AUTO_ANSWER.has(context.signatureId)) {
    for (const rule of policy.auto_answer ?? []) {
      const unusable = unusableRuleReason(rule);
      if (unusable) {
        logger.warn(`[agent-prompt-response] rule '${rule.id}' ignored: ${unusable}`);
        continue;
      }
      if (ruleMatches(rule, context)) {
        return {
          action: 'auto_answer',
          keys: [...rule.keys],
          ruleId: rule.id,
          reason: `answered by allowlist rule '${rule.id}'`,
        };
      }
    }
  }

  const relay =
    policy.relay_keys?.[context.signatureId] ?? policy.relay_keys?.default ?? FALLBACK_RELAY_KEYS;
  return {
    action: 'escalate',
    relay: { approve: [...relay.approve], reject: [...relay.reject] },
    waitMs: policy.escalation_wait_ms ?? DEFAULT_ESCALATION_WAIT_MS,
    reason: `no allowlist rule answers '${context.signatureId}'; asking a person`,
  };
}
