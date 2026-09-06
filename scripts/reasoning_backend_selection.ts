/**
 * Reasoning-backend selection & persistence helpers shared by
 * `reasoning_setup.ts`, `onboarding_wizard.ts`, and `onboarding_apply.ts`
 * (LC-04c / LC-05).
 *
 * Single source of truth for the backend catalog: the reasoning-backend
 * policy (`libs/core/reasoning-backend-policy.ts` +
 * `knowledge/product/governance/reasoning-backend-policy.json`,
 * `allowed_modes` / `mode_aliases`). Never hardcode a second list here or in
 * any caller — docs (docs/INITIALIZATION.md, AGENTS.md §2) mirror that policy.
 */
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModePolicy,
  type ReasoningBackendMode,
} from '@agent/core/reasoning-backend-policy';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeWriteFile } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';

export const REASONING_BACKEND_ENV_KEY = 'KYBERION_REASONING_BACKEND';
export const PERSONA_ENV_KEY = 'KYBERION_PERSONA';

/** Canonical selectable backends, in policy order. */
export function listReasoningBackendChoices(): ReasoningBackendMode[] {
  return [...loadReasoningBackendPolicy().allowed_modes];
}

/**
 * Normalize a free-form value (mode name or alias like `grok`) to a canonical
 * allowed mode; `null` when it is not in the catalog.
 */
export function normalizeReasoningBackendChoice(value: string): ReasoningBackendMode | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const policy = loadReasoningBackendPolicy();
  const normalized = normalizeReasoningBackendModePolicy(trimmed as ReasoningBackendMode, policy);
  return policy.allowed_modes.includes(normalized) ? normalized : null;
}

/** Numbered menu lines for interactive selection, derived from the catalog. */
export function formatReasoningBackendMenu(choices: readonly string[]): string[] {
  return choices.map((mode, index) => {
    const suffix =
      mode === 'claude-cli' ? ' (Recommended)' : mode === 'stub' ? ' (Offline mock)' : '';
    return `${index + 1}. ${mode}${suffix}`;
  });
}

/**
 * Resolve an interactive answer against the menu: a 1-based number, a mode
 * name, or a known alias. Empty / unknown input resolves to `null` (skip).
 */
export function resolveReasoningBackendMenuSelection(
  answer: string,
  choices: readonly ReasoningBackendMode[]
): ReasoningBackendMode | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return index >= 1 && index <= choices.length ? (choices[index - 1] ?? null) : null;
  }
  const normalized = normalizeReasoningBackendChoice(trimmed);
  return normalized && choices.includes(normalized) ? normalized : null;
}

export function defaultEnvLocalPath(): string {
  return pathResolver.rootResolve('.env.local');
}

export function readReasoningSelectionTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

/** Pure upsert of one `KEY=value` line in dotenv-style content. */
export function upsertEnvVarLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^\\s*${key}=.*$`, 'gm');
  if (matcher.test(content)) {
    return content.replace(matcher, line);
  }
  let next = content;
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  return `${next}${line}\n`;
}

/** Read one persisted dotenv value without loading secrets into process.env. */
export function readPersistedEnvValue(
  key: string,
  envLocalPath: string = defaultEnvLocalPath()
): string | null {
  if (!safeExistsSync(envLocalPath)) return null;
  const content = readReasoningSelectionTextFile(envLocalPath);
  const match = new RegExp(`^\\s*${key}=(.*)$`, 'm').exec(content);
  const value = match?.[1]?.trim();
  return value || null;
}

/** Persist one non-secret operator preference in `.env.local`. */
export function persistEnvValue(
  key: string,
  value: string,
  envLocalPath: string = defaultEnvLocalPath()
): string {
  let content = '';
  if (safeExistsSync(envLocalPath)) {
    content = readReasoningSelectionTextFile(envLocalPath);
  }
  safeWriteFile(envLocalPath, upsertEnvVarLine(content, key, value));
  return envLocalPath;
}

/** The backend currently persisted in `.env.local`, or `null`. */
export function readPersistedReasoningBackend(
  envLocalPath: string = defaultEnvLocalPath()
): string | null {
  return readPersistedEnvValue(REASONING_BACKEND_ENV_KEY, envLocalPath);
}

/** Persist the choice as `KYBERION_REASONING_BACKEND` in `.env.local`. Returns the path written. */
export function persistReasoningBackend(
  backend: string,
  envLocalPath: string = defaultEnvLocalPath()
): string {
  return persistEnvValue(REASONING_BACKEND_ENV_KEY, backend, envLocalPath);
}

export function readPersistedPersona(envLocalPath: string = defaultEnvLocalPath()): string | null {
  return readPersistedEnvValue(PERSONA_ENV_KEY, envLocalPath);
}

export function persistPersona(
  persona: string,
  envLocalPath: string = defaultEnvLocalPath()
): string {
  return persistEnvValue(PERSONA_ENV_KEY, persona, envLocalPath);
}
