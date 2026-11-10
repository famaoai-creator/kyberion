/**
 * Reasoning-backend selection & persistence helpers shared by
 * `reasoning_setup.ts`, `onboarding_wizard.ts`, and `onboarding_apply.ts`
 * (LC-04c / LC-05).
 *
 * Single source of truth for the backend catalog: the reasoning-backend
 * policy (`libs/core/reasoning/reasoning-backend-policy.ts` +
 * `knowledge/product/governance/reasoning-backend-policy.json`,
 * `allowed_modes` / `mode_aliases`). Never hardcode a second list here or in
 * any caller — docs (docs/INITIALIZATION.md, AGENTS.md §2) mirror that policy.
 */
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModePolicy,
  type ReasoningBackendMode,
} from '@agent/core/reasoning/reasoning-backend-policy';
import { getReasoningProviderDescriptor } from '@agent/core/reasoning/reasoning-provider-registry';
import {
  defaultEnvLocalPath,
  persistEnvValue,
  readPersistedEnvValue,
  readReasoningSelectionTextFile,
  upsertEnvVarLine,
} from '@agent/core/foundation/env-dotenv';

export {
  defaultEnvLocalPath,
  persistEnvValue,
  readPersistedEnvValue,
  readReasoningSelectionTextFile,
  upsertEnvVarLine,
};

export const REASONING_BACKEND_ENV_KEY = 'KYBERION_REASONING_BACKEND';
/** The base role an onboarding run persists into `.env.local` (S4: was KYBERION_BASE_ROLE). */
export const PERSONA_ENV_KEY = 'KYBERION_BASE_ROLE';
/** @deprecated retired name, still read from an existing `.env.local` for one release. */
export const LEGACY_PERSONA_ENV_KEY = 'KYBERION_PERSONA';

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

/**
 * Numbered menu lines for interactive selection, derived from the catalog.
 * "Recommended" is the policy's `default_mode` (reasoning-backend-policy.json);
 * "Offline mock" marks an in-process provider (reasoning-providers/*.json).
 */
export function formatReasoningBackendMenu(
  choices: readonly string[],
  recommended: string = loadReasoningBackendPolicy().default_mode
): string[] {
  return choices.map((mode, index) => {
    const suffix =
      mode === recommended
        ? ' (Recommended)'
        : getReasoningProviderDescriptor(mode as ReasoningBackendMode)?.transport === 'in-process'
          ? ' (Offline mock)'
          : '';
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
  return (
    readPersistedEnvValue(PERSONA_ENV_KEY, envLocalPath) ??
    readPersistedEnvValue(LEGACY_PERSONA_ENV_KEY, envLocalPath)
  );
}

export function persistPersona(
  persona: string,
  envLocalPath: string = defaultEnvLocalPath()
): string {
  return persistEnvValue(PERSONA_ENV_KEY, persona, envLocalPath);
}
