/**
 * scripts/refactor/mission-llm.ts
 * LLM resolution and invocation layer for mission distillation.
 */

import { type ZodType } from 'zod';
import * as customerResolver from '../customer-resolver.js';
import { logger } from '../core.js';
import { formatDiagnostic } from '../logger.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/text.js';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { safeExec, safeMkdir } from '../secure-io.js';
import { resolveStorageFloor, SYSTEM_PARTITION } from '../storage-layout.js';
import { resolveClaudeCliFallbackCandidates } from '../provider/claude-cli-resolution.js';
import { resolveCodexBinary, runCodexCliQuery } from '../provider/codex-cli-query.js';
import {
  checkProviderEgress,
  ProviderEgressDeniedError,
  providerIdForReasoningIdentifier,
} from '../provider/provider-egress-gate.js';
import { resolveProviderCliCommand } from '../provider/provider-managed-env.js';
import type { TierLevel } from '../types.js';
import { runGeminiCliQuery } from '../provider/gemini-cli-backend.js';
import {
  loadOrganizationProfile,
  type OrganizationProfile,
} from '../organization/organization-profile.js';
import { loadPersonalIdentityAtPath } from '../personal-identity-state.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export interface LlmProfile {
  description?: string;
  command: string;
  args: string[];
  timeout_ms?: number;
  response_format?: string;
  adapter?: string;
  /**
   * How the shell-json runner hands over the prompt. `stdin` keeps mission
   * content out of argv (process table, ARG_MAX); `argv` (default) substitutes
   * the `{prompt}` placeholder in `args`.
   */
  prompt_via?: 'argv' | 'stdin';
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
  organizationProfile?: OrganizationProfile | null;
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
  command: 'codex',
  args: [],
  timeout_ms: 120_000,
  response_format: 'json_envelope',
  adapter: 'codex-cli',
};

/** Profile weight for fallback ordering: heavy → standard → light */
export const PROFILE_FALLBACK_ORDER = ['heavy', 'standard', 'light'];

const commandAvailabilityCache = new Map<string, { available: boolean; reason?: string }>();

export interface StructuredRunner<T = unknown> {
  (params: {
    profile: LlmProfile;
    prompt: string;
    schema: ZodType<T>;
    systemPrompt?: string;
  }): Promise<T>;
}

const structuredRunnerSeam = createSeam<StructuredRunner>({
  key: 'structured-runner',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/mission/mission-llm.ts',
});

export function registerStructuredRunner(
  name: string,
  runner: StructuredRunner,
  metadata: SeamProviderMetadata = {
    provenance: 'builtin',
    source: 'libs/core/mission/mission-llm.ts',
  }
): () => void {
  return structuredRunnerSeam.register(name, runner, metadata);
}

function ensureStructuredRunner(name: string, runner: StructuredRunner): void {
  if (!structuredRunnerSeam.getOptional(name)) registerStructuredRunner(name, runner);
}

function inferAdapter(profile: LlmProfile): string {
  return profile.adapter || 'shell-json';
}

/**
 * CLI options a dedicated runner takes from a policy profile. Only these
 * whitelisted fields are forwarded: forwarding the whole profile would let a
 * profile (org / user override) inject `cwd` or permission-widening
 * `extraArgs` past the runner's read-only projection.
 */
export function structuredRunnerCliOptions(profile: LlmProfile): {
  bin?: string;
  model?: string;
  timeoutMs?: number;
} {
  const record = profile as LlmProfile & { bin?: unknown; model?: unknown };
  return {
    ...(typeof record.bin === 'string' && record.bin ? { bin: record.bin } : {}),
    ...(typeof record.model === 'string' && record.model ? { model: record.model } : {}),
    ...(typeof profile.timeout_ms === 'number' && profile.timeout_ms > 0
      ? { timeoutMs: profile.timeout_ms }
      : {}),
  };
}

function registerDefaultStructuredRunners(): void {
  // Runbook §7: the dedicated provider runners answer one-shot structured
  // queries, so they run without write access (read-only / no-write
  // permission projection, never workspace-write or yolo), from an empty
  // scratch cwd instead of the repository root, with the prompt on stdin.
  ensureStructuredRunner('codex-cli', async ({ profile, prompt, schema, systemPrompt }) => {
    return runCodexCliQuery({
      systemPrompt: systemPrompt || 'Return exactly one JSON object that matches the schema.',
      userPrompt: prompt,
      schema,
      mode: 'read-only',
      profile: 'explorer',
      options: { ...structuredRunnerCliOptions(profile), cwd: llmShellScratchCwd() },
    });
  });

  ensureStructuredRunner('gemini-cli', async ({ profile, prompt, schema, systemPrompt }) => {
    return runGeminiCliQuery({
      systemPrompt: systemPrompt || 'Return exactly one JSON object that matches the schema.',
      userPrompt: prompt,
      schema,
      profile: 'explorer',
      promptVia: 'stdin',
      cwd: llmShellScratchCwd(),
      options: structuredRunnerCliOptions(profile),
    });
  });

  ensureStructuredRunner('shell-json', async ({ profile, prompt, schema, systemPrompt }) => {
    const raw = invokeShellProfile(prompt, profile, { systemPrompt });
    const parsed = parseLlmResponse(raw, profile.response_format || 'json_envelope');
    const safe = schema.safeParse(parsed);
    if (!safe.success) {
      throw new Error(`[shell-json] schema validation failed: ${safe.error.message}`);
    }
    return safe.data;
  });

  const shellRunner = structuredRunnerSeam.getOptional('shell-json');
  if (shellRunner) {
    ensureStructuredRunner('claude-cli', shellRunner);
    ensureStructuredRunner('shell-claude-cli', shellRunner);
  }
}

export function loadUserLlmTools(): UserLlmTools {
  const identityPath =
    customerResolver.customerRoot('my-identity.json') ??
    pathResolver.knowledge('personal/my-identity.json');
  const identity = loadPersonalIdentityAtPath(identityPath);
  const llmTools = identity?.llm_tools;
  return llmTools && typeof llmTools === 'object' && !Array.isArray(llmTools)
    ? (llmTools as UserLlmTools)
    : {};
}

export function isToolAvailable(command: string, userTools: UserLlmTools): boolean {
  if (!userTools.available || userTools.available.length === 0) return true;
  return userTools.available.includes(command);
}

function probeExecutableVersion(
  executable: string,
  command: string
): { available: boolean; reason?: string } {
  const cached = commandAvailabilityCache.get(executable);
  if (cached) return cached;

  try {
    safeExec(executable, ['--version'], { timeoutMs: 5_000, maxOutputMB: 1 });
    const result = { available: true };
    commandAvailabilityCache.set(executable, result);
    return result;
  } catch (err: any) {
    const reason =
      err?.stderr?.toString?.().trim?.() || err?.message || `failed to execute ${command}`;
    const result = { available: false, reason };
    commandAvailabilityCache.set(executable, result);
    return result;
  }
}

/**
 * Resolve the claude binary the same way provider discovery does
 * (`checkClaude`): KYBERION_CLAUDE_CLI_BIN / managed env first, then — unless
 * the operator pinned a binary — the real CLIs outside `node_modules/.bin`, so
 * the pnpm placeholder shim does not hide an installed `claude`.
 */
function resolveClaudeExecutable(): {
  executable: string | null;
  availability: { available: boolean; reason?: string };
} {
  const primary = resolveProviderCliCommand('claude');
  const primaryAvailability = probeExecutableVersion(primary, 'claude');
  if (primaryAvailability.available) {
    return { executable: primary, availability: primaryAvailability };
  }
  if (!getRegisteredEnvText('KYBERION_CLAUDE_CLI_BIN')?.trim()) {
    for (const candidate of resolveClaudeCliFallbackCandidates()) {
      if (candidate === primary) continue;
      const fallback = probeExecutableVersion(candidate, 'claude');
      if (fallback.available) return { executable: candidate, availability: fallback };
    }
  }
  return { executable: null, availability: primaryAvailability };
}

export function probeLlmCommandAvailability(command: string): {
  available: boolean;
  reason?: string;
} {
  // The codex-cli adapter refuses project-local shims; probe the binary it would
  // actually run, so a shim on PATH does not make a codex profile look available.
  let executable = command;
  if (command === 'codex') {
    try {
      executable = resolveCodexBinary();
    } catch (err: unknown) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  if (command === 'claude') return resolveClaudeExecutable().availability;
  return probeExecutableVersion(executable, command);
}

/**
 * Empty working directory for stdin LLM profiles, on the system scratch floor:
 * a provider CLI started there cannot pick up repository files (or the
 * repository's agent instructions) from its cwd.
 */
export function llmShellScratchCwd(): string {
  const dir = resolveStorageFloor('scratch', SYSTEM_PARTITION, 'mission-llm', 'cwd');
  safeMkdir(dir, { recursive: true });
  return dir;
}

export function invokeShellProfile(
  prompt: string,
  profile: LlmProfile,
  options: { systemPrompt?: string } = {}
): string {
  const viaStdin = profile.prompt_via === 'stdin';
  if (viaStdin && profile.args.includes('{prompt}')) {
    throw new Error(
      `LLM profile "${profile.command}" sets prompt_via "stdin" but also has a {prompt} argv placeholder — remove the placeholder so the prompt never reaches argv`
    );
  }
  const args = viaStdin
    ? [...profile.args]
    : profile.args.map((arg) => (arg === '{prompt}' ? prompt : arg));
  const timeoutMs = profile.timeout_ms || 120_000;
  // Run the claude binary the probe admitted, not whatever `claude` PATH yields.
  const executable =
    profile.command === 'claude'
      ? (resolveClaudeExecutable().executable ?? profile.command)
      : profile.command;
  if (!viaStdin) return safeExec(executable, args, { timeoutMs });
  // stdin profiles: the system prompt travels with the prompt (never argv),
  // and the CLI runs from an empty scratch cwd.
  const input = options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
  return safeExec(executable, args, { timeoutMs, input, cwd: llmShellScratchCwd() });
}

function resolveCandidateProfileNames(purpose: string, policy?: LlmPolicyConfig): string[] {
  const purposeMap = policy?.purpose_map || {};
  const defaultName = policy?.default_profile || 'standard';
  const overrideProfile = getRegisteredEnvText('KYBERION_WISDOM_LLM_PROFILE')?.trim();
  if (overrideProfile === 'stub') return ['stub'];
  const targetName = overrideProfile || purposeMap[purpose] || defaultName;
  const profiles = Object.keys(policy?.profiles || {});

  return Array.from(
    new Set([targetName, ...PROFILE_FALLBACK_ORDER, ...profiles, 'stub'].filter(Boolean))
  );
}

export function inspectLlmResolution(
  purpose: string,
  policy?: LlmPolicyConfig,
  options: LlmResolutionOptions = {}
): LlmResolutionStatus {
  const userTools = options.userTools ?? loadUserLlmTools();
  const organizationProfile = options.organizationProfile ?? loadOrganizationProfile();
  const profiles = policy?.profiles || {};
  const checkedProfiles: LlmResolutionStatus['checkedProfiles'] = [];
  const candidateNames = resolveCandidateProfileNames(purpose, policy);
  const forceStubMode = getRegisteredEnvText('KYBERION_WISDOM_LLM_PROFILE')?.trim() === 'stub';

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
    const orgOverride = organizationProfile?.llm?.profile_overrides?.[name];
    const userOverride = userTools.profile_overrides?.[name];
    const effectiveProfile = {
      ...profile,
      ...(orgOverride || {}),
      ...(userOverride || {}),
    } as LlmProfile;
    if (!isToolAvailable(effectiveProfile.command, userTools)) {
      checkedProfiles.push({
        name,
        command: effectiveProfile.command,
        available: false,
        reason: 'command blocked by user tool allowlist',
      });
      continue;
    }
    const availability =
      options.isCommandAvailable?.(effectiveProfile.command) ??
      probeLlmCommandAvailability(effectiveProfile.command);
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

  const fallbackAvailability =
    options.isCommandAvailable?.(BUILTIN_FALLBACK.command) ??
    probeLlmCommandAvailability(BUILTIN_FALLBACK.command);
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
  options: LlmResolutionOptions = {}
): LlmProfile {
  const userTools = options.userTools ?? loadUserLlmTools();
  const organizationProfile = options.organizationProfile ?? loadOrganizationProfile();
  const profiles = policy?.profiles || {};
  const status = inspectLlmResolution(purpose, policy, {
    ...options,
    userTools,
    organizationProfile,
  });

  for (const entry of status.checkedProfiles) {
    if (entry.available && entry.name !== 'builtin-fallback') {
      const profile = profiles[entry.name];
      if (!profile) continue;
      const orgOverride = organizationProfile?.llm?.profile_overrides?.[entry.name];
      const userOverride = userTools.profile_overrides?.[entry.name];
      const merged = { ...profile, ...(orgOverride || {}), ...(userOverride || {}) } as LlmProfile;
      if (userOverride?.command && isToolAvailable(userOverride.command, userTools)) {
        logger.info(
          `🤖 LLM resolved: purpose="${purpose}" → profile="${entry.name}" (user override, cmd=${merged.command})`
        );
        return merged;
      }
      logger.info(
        `🤖 LLM resolved: purpose="${purpose}" → profile="${entry.name}" (cmd=${merged.command})`
      );
      return merged;
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
      `Checks: ${details || 'none'}`
  );
}

export function invokeLlm(
  prompt: string,
  purpose: string,
  policy?: LlmPolicyConfig,
  options: { egress?: LlmEgressScope } = {}
): string {
  const profile = resolveLlmConfig(purpose, policy);
  assertLlmProfileEgress(profile, purpose, options.egress);
  logger.info(`🤖 Invoking LLM: ${profile.command} (timeout: ${profile.timeout_ms || 120_000}ms)`);
  return invokeShellProfile(prompt, profile);
}

export async function runStructuredLlmProfile<T>(
  profile: LlmProfile,
  prompt: string,
  schema: ZodType<T>,
  options: { systemPrompt?: string; egress?: LlmEgressScope } = {}
): Promise<T> {
  assertLlmProfileEgress(profile, 'structured', options.egress);
  return runStructuredLlmProfileUngated(profile, prompt, schema, options);
}

async function runStructuredLlmProfileUngated<T>(
  profile: LlmProfile,
  prompt: string,
  schema: ZodType<T>,
  options: { systemPrompt?: string } = {}
): Promise<T> {
  registerDefaultStructuredRunners();

  // Custom adapter takes absolute precedence if registered
  const adapter = inferAdapter(profile);
  const runner = structuredRunnerSeam.getOptional(adapter);
  if (runner) {
    return (await runner({
      profile,
      prompt,
      schema,
      systemPrompt: options.systemPrompt,
    })) as T;
  }

  // Fallback to shell invocation only if using standard adapter
  if (adapter === 'shell-json') {
    const shellRunner = structuredRunnerSeam.getOptional('shell-json');
    if (shellRunner) {
      return (await shellRunner({
        profile,
        prompt,
        schema,
        systemPrompt: options.systemPrompt,
      })) as T;
    }
  }

  throw new Error(`No structured runner registered for adapter "${adapter}"`);
}

/**
 * Parses the raw LLM output into a structured object.
 * Supported formats: "json_envelope", "raw_json", "text"
 */
export function parseLlmResponse(raw: string, responseFormat?: string): unknown {
  const format = responseFormat || 'json_envelope';

  let content: string;
  if (format === 'json_envelope') {
    const parsedEnvelope = parseSafeJsonInput(raw, 'mission LLM envelope');
    if (!isRecord(parsedEnvelope) || !Object.hasOwn(parsedEnvelope, 'result')) {
      throw new Error('mission LLM envelope must be a JSON object with a result field');
    }
    const result = parsedEnvelope.result;
    content = typeof result === 'string' ? result : JSON.stringify(result) || '';
  } else {
    content = raw;
  }

  try {
    return parseSafeJsonInput(content, 'mission LLM response');
  } catch (err) {
    logger.warn(`[mission-llm] suppressed error in parseLlmResponse: ${err}`);
  }

  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    return parseSafeJsonInput(jsonMatch[1].trim(), 'mission LLM fenced response');
  }

  return parseSafeJsonInput(content.trim(), 'mission LLM response');
}

function isQuotaError(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const cause = isRecord(err.cause) ? err.cause : undefined;
  return (
    cause?.code === 429 ||
    (typeof err.message === 'string' && err.message.includes('QUOTA_EXHAUSTED'))
  );
}

export interface LlmEgressScope {
  /** Most sensitive tier represented in the prompt. */
  dataTier: TierLevel;
  /** Tenant the material belongs to, when above public. */
  tenantSlug?: string;
  /** Alternate repository root for the tenant registry (hermetic tests). */
  tenantRegistryRootDir?: string;
}

/** Applied when a caller does not declare the payload tier: fail closed. */
export const DEFAULT_LLM_EGRESS_SCOPE: LlmEgressScope = Object.freeze({
  dataTier: 'confidential',
});

/** Runners that execute `profile.command` themselves (see registerDefaultStructuredRunners). */
const SHELL_RUNNER_ADAPTERS = new Set(['shell-json', 'claude-cli', 'shell-claude-cli']);

/**
 * Egress-policy provider id for a profile — the provider that actually
 * receives the prompt. Shell runners execute `profile.command`, so the id
 * comes from the command; an adapter naming a different provider than the
 * command is a mismatch and resolves to undefined. Dedicated runners
 * (`codex-cli`, `gemini-cli`) resolve their own binary, so the adapter
 * decides. Undefined means unknown, which the gate denies above public.
 */
export function llmProfileProviderId(profile: LlmProfile): string | undefined {
  const adapter = inferAdapter(profile);
  const fromAdapter = providerIdForReasoningIdentifier(adapter);
  const fromCommand = providerIdForReasoningIdentifier(path.basename(profile.command || ''));
  if (SHELL_RUNNER_ADAPTERS.has(adapter)) {
    if (fromAdapter && fromCommand !== fromAdapter) return undefined;
    return fromCommand;
  }
  return fromAdapter ?? fromCommand;
}

/** Tier egress verdict for one profile; denials are logged in diagnostic form. */
function checkLlmProfileEgress(
  profile: LlmProfile,
  label: string,
  purpose: string,
  egress: LlmEgressScope = DEFAULT_LLM_EGRESS_SCOPE
): { allowed: boolean; reason?: string } {
  if (egress.dataTier === 'public') return { allowed: true };
  const provider = llmProfileProviderId(profile);
  const decision = checkProviderEgress({
    provider: provider ?? '',
    dataTier: egress.dataTier,
    ...(egress.tenantSlug ? { tenant_slug: egress.tenantSlug } : {}),
    ...(egress.tenantRegistryRootDir
      ? { tenant_registry_root_dir: egress.tenantRegistryRootDir }
      : {}),
  });
  if (decision.allowed) return decision;
  const reason =
    decision.reason ||
    `provider '${provider ?? '(unknown)'}' (adapter ${inferAdapter(profile)}, command ${profile.command}) egress denied`;
  logger.warn(
    formatDiagnostic({
      component: 'mission-llm',
      what: `skipped LLM profile "${label}" for ${egress.dataTier} ${purpose} payload`,
      why: reason,
      next: "declare the payload tier (egress.dataTier), attest the provider's training_use 'none' for the tenant (pnpm onboarding llm attest --request-approval, then a human approves it), or use a local-only provider",
      evidence: 'knowledge/product/governance/provider-egress-policy.json',
    })
  );
  return { allowed: false, reason };
}

function assertLlmProfileEgress(
  profile: LlmProfile,
  purpose: string,
  egress: LlmEgressScope | undefined
): void {
  const decision = checkLlmProfileEgress(profile, profile.command, purpose, egress);
  if (!decision.allowed) {
    throw new ProviderEgressDeniedError(
      decision.reason || `LLM profile "${profile.command}" egress denied`
    );
  }
}

/**
 * Runs a structured LLM query with automatic model fallback on quota exhaustion.
 */
export async function runAdaptiveStructuredLlmProfile<T>(
  purpose: string,
  prompt: string,
  schema: ZodType<T>,
  options: {
    systemPrompt?: string;
    policy?: LlmPolicyConfig;
    isCommandAvailable?: (command: string) => { available: boolean; reason?: string };
    /**
     * Highest data tier in `prompt` (and its tenant). Above `public`, each
     * candidate's provider must pass `checkProviderEgress` before it runs;
     * denied profiles are skipped. Omitted means confidential (fail closed).
     */
    egress?: LlmEgressScope;
  } = {}
): Promise<T> {
  const { policy, systemPrompt, isCommandAvailable, egress } = options;
  const candidateNames = resolveCandidateProfileNames(purpose, policy);
  const profiles = policy?.profiles || {};

  logger.info(`🤖 Adaptive LLM loop: candidates=${candidateNames.length}`);

  for (const name of candidateNames) {
    if (name === 'stub') {
      logger.info(`  [Skip] ${name}: stub backend`);
      continue;
    }

    const profile = profiles[name];
    if (!profile) {
      logger.info(`  [Skip] ${name}: not configured`);
      continue;
    }

    if (!checkLlmProfileEgress(profile, name, purpose, egress).allowed) continue;

    const availability =
      isCommandAvailable?.(profile.command) ?? probeLlmCommandAvailability(profile.command);
    if (!availability.available) {
      logger.info(`  [Skip] ${name}: ${availability.reason || 'unavailable'}`);
      continue;
    }

    logger.info(`  [Try] ${name}: executing`);
    try {
      return await runStructuredLlmProfileUngated(profile, prompt, schema, { systemPrompt });
    } catch (err: unknown) {
      if (isQuotaError(err)) {
        logger.warn(`⚠️ Model "${name}" exhausted, trying next...`);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`❌ Model "${name}" failed with non-quota error: ${message}`);
      throw err;
    }
  }
  throw new Error(`All LLM models exhausted for purpose "${purpose}"`);
}
