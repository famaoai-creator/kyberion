/**
 * Secret Resolver — pluggable front-door for secret-guard.getSecret().
 *
 * The default flow looks for secrets in vault/secrets/secrets.json and
 * knowledge/personal/connections/. That's fine for local dev but breaks
 * down in organizations that manage secrets through AWS Secrets Manager,
 * GCP Secret Manager, HashiCorp Vault, Azure Key Vault, 1Password, etc.
 *
 * This contract lets callers register an upstream resolver that is
 * consulted first. If it returns a value, secret-guard uses it and
 * short-circuits; if it returns null (or throws), secret-guard falls
 * back to its local vault.
 *
 * Multiple resolvers can chain via ChainSecretResolver (first hit wins).
 *
 * Security boundary: resolvers never log secret values. If a resolver
 * needs to persist a cache, it must use confidential-tier storage and
 * opt-in explicitly.
 */

import { execFileSync } from 'node:child_process';
import { logger } from './core.js';

export interface ResolveSecretInput {
  key: string;
  scope?: string;
}

export interface SecretResolver {
  name: string;
  resolve(input: ResolveSecretInput): Promise<string | null> | string | null;
}

let registered: SecretResolver | null = null;

export function registerSecretResolver(resolver: SecretResolver): void {
  registered = resolver;
}

export function getSecretResolver(): SecretResolver | null {
  return registered;
}

export function resetSecretResolver(): void {
  registered = null;
}

/**
 * Synchronous resolution helper used by secret-guard.getSecret(). Returns
 * null when no resolver is registered or it reports a miss. Async
 * resolvers are unwrapped via deasync pattern: we await only if the
 * resolver returned a Promise AND we're already inside an async path.
 * For the legacy sync getSecret() call site, only sync resolvers are
 * honored; async resolvers should be used through resolveSecretAsync.
 */
export function resolveSecretSync(input: ResolveSecretInput): string | null {
  const resolver = registered;
  if (!resolver) return null;
  try {
    const result = resolver.resolve(input);
    if (result instanceof Promise) {
      // Can't block a sync caller; surface a warning and fall through.
      logger.warn(
        `[secret-resolver] ${resolver.name} is async; sync callers fall back to vault. Use resolveSecretAsync instead.`,
      );
      return null;
    }
    return result;
  } catch (err: any) {
    logger.warn(
      `[secret-resolver] ${resolver.name} failed for ${input.key}: ${err?.message ?? err}`,
    );
    return null;
  }
}

export async function resolveSecretAsync(input: ResolveSecretInput): Promise<string | null> {
  const resolver = registered;
  if (!resolver) return null;
  try {
    const result = await resolver.resolve(input);
    return result ?? null;
  } catch (err: any) {
    logger.warn(
      `[secret-resolver] ${resolver.name} failed for ${input.key}: ${err?.message ?? err}`,
    );
    return null;
  }
}

export class ChainSecretResolver implements SecretResolver {
  readonly name: string;
  constructor(private readonly resolvers: SecretResolver[], name = 'chain') {
    this.name = `${name}(${resolvers.map((r) => r.name).join('→')})`;
  }
  async resolve(input: ResolveSecretInput): Promise<string | null> {
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver.resolve(input);
        if (result != null) return result;
      } catch (err: any) {
        logger.warn(
          `[secret-resolver:chain] ${resolver.name} threw for ${input.key}: ${err?.message ?? err}`,
        );
      }
    }
    return null;
  }
}

export interface ShellSecretResolverOptions {
  /**
   * Shell command. `{{key}}` and `{{scope}}` are substituted. Stdout is
   * taken as the secret value (trailing newline trimmed). A non-zero
   * exit or empty output is treated as a miss.
   *
   * Examples:
   *   `aws secretsmanager get-secret-value --secret-id "{{key}}" --query SecretString --output text`
   *   `vault kv get -field=value secret/kyberion/{{key}}`
   *   `op read "op://Kyberion/{{key}}/credential"`
   */
  command: string;
  shell?: string;
  timeoutMs?: number;
}

export class ShellSecretResolver implements SecretResolver {
  readonly name = 'shell';
  constructor(private readonly options: ShellSecretResolverOptions) {}

  resolve(input: ResolveSecretInput): string | null {
    const cmd = this.options.command
      .replace(/\{\{key\}\}/gu, input.key)
      .replace(/\{\{scope\}\}/gu, input.scope ?? '');
    const shell = this.options.shell ?? process.env.SHELL ?? '/bin/sh';
    try {
      const stdout = execFileSync(shell, ['-c', cmd], {
        encoding: 'utf8',
        timeout: this.options.timeoutMs ?? 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 128 * 1024,
      });
      const trimmed = stdout.replace(/\r?\n$/u, '');
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      // Miss — caller falls back to vault.
      return null;
    }
  }
}

/**
 * Bootstrap — installs ShellSecretResolver when
 * KYBERION_SECRET_RESOLVER_COMMAND is set.
 */
export function installSecretResolverIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = env.KYBERION_SECRET_RESOLVER_COMMAND?.trim();
  if (!command) return false;
  registerSecretResolver(
    new ShellSecretResolver({
      command,
      ...(env.KYBERION_SECRET_RESOLVER_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_SECRET_RESOLVER_TIMEOUT_MS, 10) }
        : {}),
    }),
  );
  logger.success('[secret-resolver] installed ShellSecretResolver from KYBERION_SECRET_RESOLVER_COMMAND');
  return true;
}
