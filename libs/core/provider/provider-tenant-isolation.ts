/**
 * Tenant-isolated launch adapters for bound (lent) credential launches,
 * keyed by provider id (the `providerEnvironments` key used by
 * buildProviderChildEnv).
 *
 * The lending/custody model is provider-agnostic: a service's
 * `allowed_backends` decide which providers a credential may feed, and each
 * provider that supports a tenant-isolated launch registers a spec here.
 * A spec names which backend value activates it and supplies the two seams
 * that carry provider-specific knowledge:
 *
 *  - `buildEnvironment` — the isolated provider HOME/config env for one
 *    borrower + credential, attached to the binding as
 *    `providerEnvironments[provider]`.
 *  - `applyEnv` — provider-specific adjustments when the bound child env is
 *    built (config dir inside the bound HOME, auto-update off, credential
 *    kind selection).
 *
 * A provider with no registered spec keeps the generic bound-credential env
 * pass-through only — no config/HOME isolation. Adding a provider never
 * edits shared dispatch code: implement its adapter (convention: one
 * `<provider>-tenant-isolation` module, like claude-cli-tenant-isolation.ts)
 * and add one entry here.
 */
import type { ScopeContext } from '../foundation/scope-context-validation.js';
import {
  applyClaudeTenantIsolationEnv,
  boundClaudeCredentialValues,
  claudeProviderEnvironment,
  CLAUDE_PROVIDER_ENVIRONMENT,
} from './claude-cli-tenant-isolation.js';
import { apiKeyCliTenantIsolation } from './api-key-tenant-isolation.js';

export interface ProviderTenantIsolationSpec {
  /** `providerEnvironments` key / the provider id seen by buildProviderChildEnv. */
  readonly provider: string;
  /** `allowed_backends` values that activate this provider's isolated env. */
  readonly backends: readonly string[];
  /** Isolated provider env for one borrower + credential; never holds the value. */
  readonly buildEnvironment: (
    tier: ScopeContext['tier'],
    tenant: string,
    credentialRef: string
  ) => NodeJS.ProcessEnv;
  /** Provider-specific bound-env adjustments at child-env build; fails closed. */
  readonly applyEnv: (
    env: Record<string, string>,
    bound: NodeJS.ProcessEnv,
    operatorPath: string | undefined
  ) => void;
  /** Bound secret values that must be redacted from child output (may be empty). */
  readonly boundSecretValues: () => readonly string[];
}

export const PROVIDER_TENANT_ISOLATION: Readonly<Record<string, ProviderTenantIsolationSpec>> =
  Object.freeze({
    [CLAUDE_PROVIDER_ENVIRONMENT]: Object.freeze({
      provider: CLAUDE_PROVIDER_ENVIRONMENT,
      backends: Object.freeze(['claude-cli']),
      buildEnvironment: claudeProviderEnvironment,
      applyEnv: applyClaudeTenantIsolationEnv,
      boundSecretValues: boundClaudeCredentialValues,
    }),
    // Generic API-key adapters: isolated HOME redirects the CLI's own
    // config/session directory (~/.codex, ~/.gemini, ~/.grok); the bound key
    // is injected under the provider's env name and every other credential
    // var of the family is dropped. No provider-specific argv closure — see
    // api-key-tenant-isolation.ts.
    codex: apiKeyCliTenantIsolation({
      provider: 'codex',
      backends: ['codex-cli'],
      credentialEnvKey: 'OPENAI_API_KEY',
      credentialEnvKeys: ['OPENAI_API_KEY'],
      configDirEnv: { key: 'CODEX_HOME', dirName: '.codex' },
    }),
    gemini: apiKeyCliTenantIsolation({
      provider: 'gemini',
      backends: ['gemini-cli'],
      credentialEnvKey: 'GEMINI_API_KEY',
      credentialEnvKeys: ['KYBERION_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    }),
    // Antigravity CLI (gemini-cli's successor): API-key auth needs
    // `modelProvider: "gemini"` in ~/.gemini/antigravity-cli/settings.json
    // plus GEMINI_API_KEY; the isolated HOME supplies the private config dir.
    agy: apiKeyCliTenantIsolation({
      provider: 'agy',
      backends: ['agy-cli'],
      credentialEnvKey: 'GEMINI_API_KEY',
      credentialEnvKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'KYBERION_GEMINI_API_KEY'],
      configFiles: [
        {
          relativePath: '.gemini/antigravity-cli/settings.json',
          contents: '{\n  "modelProvider": "gemini"\n}\n',
        },
      ],
    }),
    grok: apiKeyCliTenantIsolation({
      provider: 'grok',
      backends: ['grok-cli'],
      credentialEnvKey: 'XAI_API_KEY',
      credentialEnvKeys: ['XAI_API_KEY', 'KYBERION_GROK_API_KEY'],
    }),
  });

/** Every registered isolation spec. */
export function providerTenantIsolationSpecs(): readonly ProviderTenantIsolationSpec[] {
  return Object.values(PROVIDER_TENANT_ISOLATION);
}

/** The isolation spec for a provider id, or undefined when none exists. */
export function providerTenantIsolationForProvider(
  provider: string
): ProviderTenantIsolationSpec | undefined {
  return PROVIDER_TENANT_ISOLATION[provider];
}

/** The first isolation spec activated by a backend id, or undefined. */
export function providerTenantIsolationForBackend(
  backend: string
): ProviderTenantIsolationSpec | undefined {
  return Object.values(PROVIDER_TENANT_ISOLATION).find((spec) => spec.backends.includes(backend));
}
