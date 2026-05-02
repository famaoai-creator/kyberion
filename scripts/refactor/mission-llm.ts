/**
 * scripts/refactor/mission-llm.ts
 * LLM resolution and invocation layer for mission distillation.
 */

import { z, type ZodType } from 'zod';
import {
  logger,
  pathResolver,
  safeExistsSync,
  safeExec,
  runCodexCliQuery,
  runGeminiCliQuery,
} from '@agent/core';
import { readJsonFile } from './cli-input.js';

export interface LlmProfile {
  description?: string;
  command: string;
  args: string[];
  timeout_ms?: number;
  response_format?: string;
  adapter?: string;
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

export interface LlmResolutionOptions {
  userTools?: UserLlmTools;
  isCommandAvailable?: (command: string) => { available: boolean; reason?: string };
}

export interface LlmResolutionStatus {
  purpose: string;
  selectedProfile: string | null;
  selectedCommand: string | null;
  checkedProfiles: Array<{
    name: string;
    command: string;
    available: boolean;
    reason?: string;
  }>;
}

export const BUILTIN_FALLBACK: LlmProfile = {
  command: 'claude',
  args: ['-p', '{prompt}', '--output-format', 'json'],
  timeout_ms: 120_000,
  response_format: 'json_envelope',
};

/** Profile weight for fallback ordering: heavy → standard → light */
export const PROFILE_FALLBACK_ORDER = ['heavy', 'standard', 'light'];

const commandAvailabilityCache = new Map<string, { available: boolean; reason?: string }>();
const structuredRunners = new Map<string, StructuredRunner>();

export interface StructuredRunner<T = unknown> {
  (params: {
    profile: LlmProfile;
    prompt: string;
    schema: ZodType<T>;
    systemPrompt?: string;
  }): Promise<T>;
}

export function registerStructuredRunner(name: string, runner: StructuredRunner): void {
  structuredRunners.set(name, runner);
}

function ensureStructuredRunner(name: string, runner: StructuredRunner): void {
  if (!structuredRunners.has(name)) {
    structuredRunners.set(name, runner);
  }
}

function inferAdapter(profile: LlmProfile): string {
  return profile.adapter || 'shell-json';
}

function registerDefaultStructuredRunners(): void {
  ensureStructuredRunner('codex-cli', async ({ profile, prompt, schema, systemPrompt }) => {
    return runCodexCliQuery({
      systemPrompt: systemPrompt || 'Return exactly one JSON object that matches the schema.',
      userPrompt: prompt,
      schema,
      options: profile as any,
    });
  });

  ensureStructuredRunner('gemini-cli', async ({ profile, prompt, schema, systemPrompt }) => {
    return runGeminiCliQuery({
      systemPrompt: systemPrompt || 'Return exactly one JSON object that matches the schema.',
      userPrompt: prompt,
      schema,
      options: profile as any,
    });
  });

  ensureStructuredRunner('shell-json', async ({ profile, prompt, schema }) => {
    const raw = invokeShellProfile(prompt, profile);
    const parsed = parseLlmResponse(raw, profile.response_format || 'json_envelope');
    const safe = schema.safeParse(parsed);
    if (!safe.success) {
      throw new Error(`[shell-json] schema validation failed: ${safe.error.message}`);
    }
    return safe.data;
  });

  const shellRunner = structuredRunners.get('shell-json');
  if (shellRunner) {
    ensureStructuredRunner('claude-cli', shellRunner);
    ensureStructuredRunner('shell-claude-cli', shellRunner);
  }
}

export function loadUserLlmTools(): UserLlmTools {
  const identityPath = pathResolver.knowledge('personal/my-identity.json');
  if (!safeExistsSync(identityPath)) return {};
  try {
    const identity = readJsonFile<{ llm_tools?: UserLlmTools }>(identityPath);
    return identity.llm_tools || {};
  } catch (_) {
    return {};
  }
}

export function isToolAvailable(command: string, userTools: UserLlmTools): boolean {
  if (!userTools.available || userTools.available.length === 0) return true;
  return userTools.available.includes(command);
}

export function probeLlmCommandAvailability(command: string): { available: boolean; reason?: string } {
  const cached = commandAvailabilityCache.get(command);
  if (cached) return cached;

  try {
    safeExec(command, ['--version'], { timeoutMs: 5_000, maxOutputMB: 1 });
    const result = { available: true };
    commandAvailabilityCache.set(command, result);
    return result;
  } catch (err: any) {
    const reason = err?.stderr?.toString?.().trim?.() || err?.message || `failed to execute ${command}`;
    const result = { available: false, reason };
    commandAvailabilityCache.set(command, result);
    return result;
  }
}

export function invokeShellProfile(prompt: string, profile: LlmProfile): string {
  const args = profile.args.map((arg) => (arg === '{prompt}' ? prompt : arg));
  const timeoutMs = profile.timeout_ms || 120_000;
  const stdout = safeExec(profile.command, args, { timeoutMs });
  return stdout;
}

function resolveCandidateProfileNames(
  purpose: string,
  policy?: LlmPolicyConfig,
): string[] {
  const purposeMap = policy?.purpose_map || {};
  const defaultName = policy?.default_profile || 'standard';
  const overrideProfile = process.env.KYBERION_WISDOM_LLM_PROFILE?.trim();
  if (overrideProfile === 'stub') return ['stub'];
  const targetName = overrideProfile || purposeMap[purpose] || defaultName;
  const profiles = Object.keys(policy?.profiles || {});

  return Array.from(
    new Set([
      targetName,
      ...PROFILE_FALLBACK_ORDER,
      ...profiles,
      'stub',
    ].filter(Boolean)),
  );
}

export function inspectLlmResolution(
  purpose: string,
  policy?: LlmPolicyConfig,
  options: LlmResolutionOptions = {},
): LlmResolutionStatus {
  const userTools = options.userTools ?? loadUserLlmTools();
  const profiles = policy?.profiles || {};
  const checkedProfiles: LlmResolutionStatus['checkedProfiles'] = [];
  const candidateNames = resolveCandidateProfileNames(purpose, policy);
  const forceStubMode = process.env.KYBERION_WISDOM_LLM_PROFILE?.trim() === 'stub';

  for (const name of candidateNames) {
    if (name === 'stub') {
      checkedProfiles.push({
        name,
        command: BUILTIN_FALLBACK.command,
        available: false,
        reason: 'stub mode requested or no usable profile found',
      });
      continue;
    }

    const profile = profiles[name];
    if (!profile) continue;
    const userOverride = userTools.profile_overrides?.[name];
    const effectiveProfile = userOverride ? ({ ...profile, ...userOverride } as LlmProfile) : profile;
    if (!isToolAvailable(effectiveProfile.command, userTools)) {
      checkedProfiles.push({
        name,
        command: effectiveProfile.command,
        available: false,
        reason: 'command blocked by user tool allowlist',
      });
      continue;
    }
    const availability = options.isCommandAvailable?.(effectiveProfile.command) ?? probeLlmCommandAvailability(effectiveProfile.command);
    checkedProfiles.push({
      name,
      command: effectiveProfile.command,
      available: availability.available,
      reason: availability.reason,
    });
    if (availability.available) {
      return {
        purpose,
        selectedProfile: name,
        selectedCommand: effectiveProfile.command,
        checkedProfiles,
      };
    }
  }

  if (forceStubMode) {
    return {
      purpose,
      selectedProfile: null,
      selectedCommand: null,
      checkedProfiles,
    };
  }

  const fallbackAvailability = options.isCommandAvailable?.(BUILTIN_FALLBACK.command) ?? probeLlmCommandAvailability(BUILTIN_FALLBACK.command);
  checkedProfiles.push({
    name: 'builtin-fallback',
    command: BUILTIN_FALLBACK.command,
    available: fallbackAvailability.available,
    reason: fallbackAvailability.reason,
  });

  return {
    purpose,
    selectedProfile: fallbackAvailability.available ? 'builtin-fallback' : null,
    selectedCommand: fallbackAvailability.available ? BUILTIN_FALLBACK.command : null,
    checkedProfiles,
  };
}

/**
 * Resolves the LLM profile for a given purpose.
 * Resolution order: user override → org profile → builtin fallback
 */
export function resolveLlmConfig(
  purpose: string,
  policy?: LlmPolicyConfig,
  options: LlmResolutionOptions = {},
): LlmProfile {
  const userTools = options.userTools ?? loadUserLlmTools();
  const profiles = policy?.profiles || {};
  const status = inspectLlmResolution(purpose, policy, { ...options, userTools });

  for (const entry of status.checkedProfiles) {
    if (entry.available && entry.name !== 'builtin-fallback') {
      const profile = profiles[entry.name];
      if (!profile) continue;
      const userOverride = userTools.profile_overrides?.[entry.name];
      if (userOverride?.command && isToolAvailable(userOverride.command, userTools)) {
        const merged = { ...profile, ...userOverride } as LlmProfile;
        logger.info(`🤖 LLM resolved: purpose="${purpose}" → profile="${entry.name}" (user override, cmd=${merged.command})`);
        return merged;
      }
      logger.info(`🤖 LLM resolved: purpose="${purpose}" → profile="${entry.name}" (cmd=${entry.command})`);
      return userOverride ? ({ ...profile, ...userOverride } as LlmProfile) : profile;
    }
  }

  if (status.selectedProfile === 'builtin-fallback' && status.selectedCommand) {
    logger.warn(`⚠️ LLM fallback to builtin default for purpose="${purpose}"`);
    return BUILTIN_FALLBACK;
  }

  const details = status.checkedProfiles
    .map((entry) => `${entry.name}:${entry.command}${entry.reason ? ` (${entry.reason})` : ''}`)
    .join('; ');
  throw new Error(
    `No usable LLM tool available for purpose "${purpose}". ` +
    `Set KYBERION_WISDOM_LLM_PROFILE, update wisdom-policy.json, or use stub distillation. ` +
    `Checks: ${details || 'none'}`,
  );
}

export function invokeLlm(prompt: string, purpose: string, policy?: LlmPolicyConfig): string {
  const profile = resolveLlmConfig(purpose, policy);
  logger.info(`🤖 Invoking LLM: ${profile.command} (timeout: ${profile.timeout_ms || 120_000}ms)`);
  return invokeShellProfile(prompt, profile);
}

export async function runStructuredLlmProfile<T>(
  profile: LlmProfile,
  prompt: string,
  schema: ZodType<T>,
  options: { systemPrompt?: string } = {},
): Promise<T> {
  registerDefaultStructuredRunners();
  const adapter = inferAdapter(profile);
  const runner = structuredRunners.get(adapter) || structuredRunners.get('shell-json');
  if (!runner) {
    throw new Error(`No structured runner registered for adapter "${adapter}"`);
  }
  return (await runner({
    profile,
    prompt,
    schema,
    systemPrompt: options.systemPrompt,
  })) as T;
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
