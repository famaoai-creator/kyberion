/**
 * scripts/refactor/mission-llm.ts
 * LLM resolution and invocation layer for mission distillation.
 */

import { logger, pathResolver, safeExistsSync, safeExec, safeReadFile } from '@agent/core';

export interface LlmProfile {
  description?: string;
  command: string;
  args: string[];
  timeout_ms?: number;
  response_format?: string;
}

export interface LlmPolicyConfig {
  profiles?: Record<string, LlmProfile>;
  purpose_map?: Record<string, string>;
  default_profile?: string;
}

export interface UserLlmTools {
  available?: string[];
  profile_overrides?: Record<string, Partial<LlmProfile>>;
}

export const BUILTIN_FALLBACK: LlmProfile = {
  command: 'claude',
  args: ['-p', '{prompt}', '--output-format', 'json'],
  timeout_ms: 120_000,
  response_format: 'json_envelope',
};

/** Profile weight for fallback ordering: heavy → standard → light */
export const PROFILE_FALLBACK_ORDER = ['heavy', 'standard', 'light'];

export function loadUserLlmTools(): UserLlmTools {
  const identityPath = pathResolver.knowledge('personal/my-identity.json');
  if (!safeExistsSync(identityPath)) return {};
  try {
    const identity = JSON.parse(safeReadFile(identityPath, { encoding: 'utf8' }) as string);
    return identity.llm_tools || {};
  } catch (_) {
    return {};
  }
}

export function isToolAvailable(command: string, userTools: UserLlmTools): boolean {
  if (!userTools.available || userTools.available.length === 0) return true;
  return userTools.available.includes(command);
}

/**
 * Resolves the LLM profile for a given purpose.
 * Resolution order: user override → org profile → builtin fallback
 */
export function resolveLlmConfig(purpose: string, policy?: LlmPolicyConfig): LlmProfile {
  const userTools = loadUserLlmTools();
  const profiles = policy?.profiles || {};
  const purposeMap = policy?.purpose_map || {};
  const defaultName = policy?.default_profile || 'standard';

  const targetName = purposeMap[purpose] || defaultName;
  const candidates = [targetName, ...PROFILE_FALLBACK_ORDER.filter(p => p !== targetName)];

  for (const name of candidates) {
    const userOverride = userTools.profile_overrides?.[name];
    if (userOverride?.command && isToolAvailable(userOverride.command, userTools)) {
      const base = profiles[name] || BUILTIN_FALLBACK;
      const merged = { ...base, ...userOverride } as LlmProfile;
      logger.info(`🤖 LLM resolved: purpose="${purpose}" → profile="${name}" (user override, cmd=${merged.command})`);
      return merged;
    }

    const orgProfile = profiles[name];
    if (orgProfile && isToolAvailable(orgProfile.command, userTools)) {
      logger.info(`🤖 LLM resolved: purpose="${purpose}" → profile="${name}" (cmd=${orgProfile.command})`);
      return orgProfile;
    }
  }

  if (isToolAvailable(BUILTIN_FALLBACK.command, userTools)) {
    logger.warn(`⚠️ LLM fallback to builtin default for purpose="${purpose}"`);
    return BUILTIN_FALLBACK;
  }

  throw new Error(
    `No LLM tool available for purpose "${purpose}". ` +
    `User tools: [${userTools.available?.join(', ') || 'none declared'}]`
  );
}

export function invokeLlm(prompt: string, purpose: string, policy?: LlmPolicyConfig): string {
  const profile = resolveLlmConfig(purpose, policy);
  const args = profile.args.map(a => a === '{prompt}' ? prompt : a);
  const timeoutMs = profile.timeout_ms || 120_000;

  logger.info(`🤖 Invoking LLM: ${profile.command} (timeout: ${timeoutMs}ms)`);
  return safeExec(profile.command, args, { timeoutMs });
}

/**
 * Parses the raw LLM output into a structured object.
 * Supported formats: "json_envelope", "raw_json", "text"
 */
export function parseLlmResponse(raw: string, responseFormat?: string): any {
  const format = responseFormat || 'json_envelope';

  let content: string;
  if (format === 'json_envelope') {
    const envelope = JSON.parse(raw);
    content = typeof envelope.result === 'string'
      ? envelope.result
      : JSON.stringify(envelope.result);
  } else {
    content = raw;
  }

  try {
    return JSON.parse(content);
  } catch (_) {}

  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1].trim());
  }

  return JSON.parse(content.trim());
}
