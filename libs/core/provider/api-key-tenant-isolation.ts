/**
 * Generic tenant-isolated launch adapter for CLI providers whose bound
 * credential is a single API key and whose session/config state lives under
 * HOME (or one config-dir env).
 *
 * The isolation level is deliberately honest: an isolated HOME on the
 * borrower's private floor redirects the CLI's `~/.<tool>` session, login and
 * config files; the only credential the child sees is the bound key, injected
 * under the provider's own env name; every other credential-shaped var of the
 * provider family is dropped first. Unlike the claude adapter there are no
 * provider-specific argv flags — a CLI that needs settings/MCP/hook closure
 * like `--strict-mcp-config` still needs its own adapter.
 *
 * Registration is data: one `apiKeyCliTenantIsolation({...})` call per
 * provider in PROVIDER_TENANT_ISOLATION (provider-tenant-isolation.ts).
 */
import * as path from 'node:path';
import {
  hasTaskCredentialBinding,
  resolveTaskCredential,
  resolveTaskCredentialKind,
} from '../foundation/credential-binding.js';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import type { ScopeContext } from '../foundation/scope-context-validation.js';
import { providerAuthHomeRelativePath } from './provider-auth-home.js';
import { providerNetworkPassthroughEnv } from './provider-network-passthrough.js';
import type { ProviderTenantIsolationSpec } from './provider-tenant-isolation.js';

export interface ApiKeyCliIsolationInput {
  /** `providerEnvironments` key / the provider id seen by buildProviderChildEnv. */
  readonly provider: string;
  /** The bound credential's binding-secrets key (and default env delivery name). */
  readonly credentialEnvKey: string;
  /** Every credential env var of this provider's family; all but the bound key are dropped. */
  readonly credentialEnvKeys: readonly string[];
  /** Optional config-dir env pinned inside the bound HOME (e.g. CODEX_HOME → `.codex`). */
  readonly configDirEnv?: { readonly key: string; readonly dirName: string };
  /**
   * How the bound secret reaches the child. `env` (default) injects it under
   * `credentialEnvKey`. `configFile` writes it into `secretFile` inside the
   * config dir at spawn time — required by CLIs that ignore env credentials
   * (codex reads `$CODEX_HOME/auth.json`, verified live: env alone yields
   * `401 Missing bearer`). Requires `configDirEnv`.
   */
  readonly secretDelivery?: 'env' | 'configFile';
  readonly secretFile?: {
    readonly name: string;
    readonly render: (secret: string) => string;
  };
  /**
   * Fixed files the CLI needs inside its config dir — e.g. the
   * `{"modelProvider": "gemini"}` that switches agy to API-key auth. Written
   * under the bound HOME at environment-build time; contents are constants,
   * never credential material.
   */
  readonly configFiles?: readonly { readonly relativePath: string; readonly contents: string }[];
  /** Extra non-secret env merged into the isolated env (e.g. a disable-autoupdate flag). */
  readonly staticEnv?: Readonly<Record<string, string>>;
}

export function apiKeyCliTenantIsolation(
  input: ApiKeyCliIsolationInput
): ProviderTenantIsolationSpec {
  if (input.secretDelivery === 'configFile' && (!input.configDirEnv || !input.secretFile))
    throw new Error(
      `[CREDENTIAL_PROVIDER_DENIED] ${input.provider} configFile delivery requires configDirEnv and secretFile`
    );
  const denied = (detail: string): Error =>
    new Error(
      `[CREDENTIAL_PROVIDER_DENIED] ${detail} — the bound ${input.provider} CLI is not started`
    );
  const configDirKey = input.configDirEnv?.key;
  const configDirName = input.configDirEnv?.dirName;

  return Object.freeze({
    provider: input.provider,

    buildEnvironment(
      tier: ScopeContext['tier'],
      tenant: string,
      credentialRef: string
    ): NodeJS.ProcessEnv {
      const home = pathResolver.rootResolve(
        providerAuthHomeRelativePath(tier, tenant, input.provider, credentialRef)
      );
      const env: Record<string, string> = {
        ...providerNetworkPassthroughEnv(),
        HOME: home,
        ...input.staticEnv,
      };
      const configDir = configDirKey && path.join(home, configDirName!);
      if (configDirKey && configDir) env[configDirKey] = configDir;
      try {
        safeMkdir(configDir ?? home, { recursive: true });
        for (const file of input.configFiles ?? []) {
          const filePath = path.join(home, file.relativePath);
          safeMkdir(path.dirname(filePath), { recursive: true });
          safeWriteFile(filePath, file.contents);
        }
      } catch {
        throw new Error(
          `[CREDENTIAL_HOME_REQUIRED] Could not prepare the isolated ${input.provider} HOME for this tenant credential`
        );
      }
      return env;
    },

    applyEnv(
      env: Record<string, string>,
      bound: NodeJS.ProcessEnv,
      operatorPath: string | undefined
    ): void {
      const kind = resolveTaskCredentialKind();
      if (kind !== 'api_key') throw denied('The bound credential kind is missing or not api_key');
      const home = bound.HOME;
      if (!home || !path.isAbsolute(home)) throw denied('The bound provider HOME is missing');
      if (configDirKey) {
        const configDir = bound[configDirKey] || path.join(home, configDirName!);
        const below = path.relative(home, configDir);
        // `below === ''` means the config dir IS the bound home — allowed.
        if (
          !path.isAbsolute(configDir) ||
          below === '..' ||
          below.startsWith('..' + path.sep) ||
          path.isAbsolute(below)
        )
          throw denied(`${configDirKey} must stay inside the bound HOME`);
        env[configDirKey] = configDir;
      }
      for (const key of input.credentialEnvKeys) delete env[key];
      const secret = resolveTaskCredential(input.credentialEnvKey);
      if (typeof secret !== 'string' || !secret)
        throw denied(`The bound ${input.credentialEnvKey} credential is missing`);
      if (input.secretDelivery === 'configFile') {
        const configDir = bound[configDirKey!] || path.join(home, configDirName!);
        try {
          safeWriteFile(
            path.join(configDir, input.secretFile!.name),
            input.secretFile!.render(secret)
          );
        } catch {
          throw denied(`The bound ${input.provider} credential file could not be written`);
        }
      } else {
        env[input.credentialEnvKey] = secret;
      }
      env.HOME = home;
      Object.assign(env, input.staticEnv);
      if (!env.PATH && operatorPath) env.PATH = operatorPath;
    },

    boundSecretValues(): readonly string[] {
      try {
        if (!hasTaskCredentialBinding()) return [];
        const value = resolveTaskCredential(input.credentialEnvKey);
        return typeof value === 'string' && value.length > 8 ? [value] : [];
      } catch {
        return [];
      }
    },
  });
}
