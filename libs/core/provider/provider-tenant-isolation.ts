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
import { resolveReasoningProviderDescriptor } from '../reasoning/reasoning-provider-registry.js';

export interface ProviderTenantIsolationSpec {
  /** `providerEnvironments` key / the provider id seen by buildProviderChildEnv. */
  readonly provider: string;
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
      buildEnvironment: claudeProviderEnvironment,
      applyEnv: applyClaudeTenantIsolationEnv,
      boundSecretValues: boundClaudeCredentialValues,
    }),
    // Generic API-key adapters: isolated HOME redirects the CLI's own
    // config/session directory; the bound key is delivered by env or by a
    // credential file inside the isolated config dir, and every other
    // credential var of the family is dropped. No provider-specific argv
    // closure — see api-key-tenant-isolation.ts. Deliveries verified against
    // the installed CLIs (2026-11):
    codex: apiKeyCliTenantIsolation({
      provider: 'codex',
      credentialEnvKey: 'OPENAI_API_KEY',
      credentialEnvKeys: ['OPENAI_API_KEY'],
      configDirEnv: { key: 'CODEX_HOME', dirName: '.codex' },
      // codex ignores OPENAI_API_KEY env (401 "Missing bearer"); auth.json is
      // its only API-key channel — same shape `codex login --api-key` writes.
      secretDelivery: 'configFile',
      secretFile: {
        name: 'auth.json',
        render: (secret) => `${JSON.stringify({ OPENAI_API_KEY: secret })}\n`,
      },
      // Pin the credential store to auth.json inside the isolated CODEX_HOME;
      // the default "auto" may fall back to the OS keyring, which lives
      // outside the bound HOME and would leak tenant credentials sideways.
      configFiles: [
        {
          relativePath: '.codex/config.toml',
          contents: 'cli_auth_credentials_store = "file"\n',
        },
      ],
    }),
    gemini: apiKeyCliTenantIsolation({
      provider: 'gemini',
      credentialEnvKey: 'GEMINI_API_KEY',
      credentialEnvKeys: ['KYBERION_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      // Headless -p runs refuse untrusted cwds; the bound cwd is the tenant's
      // own scratch, and isolated HOME already keeps operator state out.
      staticEnv: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    }),
    // Antigravity CLI (gemini-cli's successor): API-key auth needs
    // `modelProvider: "gemini"` in ~/.gemini/antigravity-cli/settings.json
    // plus GEMINI_API_KEY; the isolated HOME supplies the private config dir.
    agy: apiKeyCliTenantIsolation({
      provider: 'agy',
      credentialEnvKey: 'GEMINI_API_KEY',
      credentialEnvKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'KYBERION_GEMINI_API_KEY'],
      configFiles: [
        {
          relativePath: '.gemini/antigravity-cli/settings.json',
          contents: '{\n  "modelProvider": "gemini"\n}\n',
        },
      ],
    }),
    // cursor-agent honors CURSOR_API_KEY env (verified: the binary reports it
    // loaded the key from the environment); its session/config dirs live
    // under HOME, so the redirect alone isolates them.
    cursor: apiKeyCliTenantIsolation({
      provider: 'cursor',
      credentialEnvKey: 'CURSOR_API_KEY',
      credentialEnvKeys: ['CURSOR_API_KEY'],
    }),
    // grok-cli is deliberately absent: grok's only auth is `grok login`
    // (OAuth); it ignores XAI_API_KEY env — there is no lendable channel.
    // devin-cli likewise: `devin auth login` writes
    // ~/.local/share/devin/credentials.toml; env keys are not honored
    // (verified on devin 3000.x — DEVIN_API_KEY/WINDSURF_API_KEY are ignored).
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

/** The isolation spec a backend mode resolves to via its descriptor provider, or undefined. */
export function providerTenantIsolationForBackend(
  backend: string
): ProviderTenantIsolationSpec | undefined {
  const descriptor = resolveReasoningProviderDescriptor(backend);
  return descriptor ? PROVIDER_TENANT_ISOLATION[descriptor.provider] : undefined;
}
