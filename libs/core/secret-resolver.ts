/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
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
import { coreSeamCatalog, createSeam } from './seam.js';

export interface ResolveSecretInput {
  key: string;
  scope?: string;
  /** Operation requesting the reference; resolvers may apply per-operation policy. */
  operation?: string;
}

/** A model/tool-safe reference. It carries a name, never a secret value. */
export interface SecretReference {
  env: string;
  scope?: string;
  operation?: string;
}

/** Non-sensitive resolver capability summary. Never add secret values here. */
export interface SecretResolverDescription {
  configured: boolean;
  writable: boolean;
}

export interface SecretResolver {
  name: string;
  resolve(input: ResolveSecretInput): Promise<string | null> | string | null;
  describe?: () => SecretResolverDescription;
}

const secretResolverSeam = createSeam<SecretResolver>({
  key: 'secret-resolver',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});
let registeredDisposer: (() => void) | null = null;

export function registerSecretResolver(resolver: SecretResolver): () => void {
  if (!resolver || typeof resolver.name !== 'string' || !resolver.name.trim()) {
    throw new TypeError('Secret resolver must have a non-empty name');
  }
  registeredDisposer = secretResolverSeam.register(resolver.name, resolver, {
    provenance: 'builtin',
    source: 'secret-resolver',
  });
  return registeredDisposer;
}

export function getSecretResolver(): SecretResolver | null {
  return secretResolverSeam.getOptional() ?? null;
}

export function resetSecretResolver(): void {
  registeredDisposer?.();
  registeredDisposer = null;
}

function assertSecretReference(reference: SecretReference): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference.env.trim())) {
    throw new Error(`[SECRET_REFERENCE_INVALID] env name is invalid: ${reference.env}`);
  }
  if (reference.scope !== undefined && !reference.scope.trim()) {
    throw new Error('[SECRET_REFERENCE_INVALID] scope must not be empty');
  }
  if (reference.operation !== undefined && !reference.operation.trim()) {
    throw new Error('[SECRET_REFERENCE_INVALID] operation must not be empty');
  }
}

/** Describe the active resolver without revealing configuration values. */
export function describeSecretResolver(): SecretResolverDescription {
  const resolver = getSecretResolver();
  if (!resolver) return { configured: false, writable: false };
  try {
    const description = resolver.describe?.() ?? { configured: true, writable: false };
    return {
      configured: description.configured === true,
      writable: description.writable === true,
    };
  } catch {
    return { configured: false, writable: false };
  }
}

/** Resolve an env-name reference synchronously; the reference is not cached. */
export function resolveSecretReferenceSync(reference: SecretReference): string | null {
  assertSecretReference(reference);
  return resolveSecretSync({
    key: reference.env,
    ...(reference.scope ? { scope: reference.scope } : {}),
    ...(reference.operation ? { operation: reference.operation } : {}),
  });
}

/** Resolve an env-name reference asynchronously; each call reaches the resolver. */
export async function resolveSecretReferenceAsync(
  reference: SecretReference
): Promise<string | null> {
  assertSecretReference(reference);
  return resolveSecretAsync({
    key: reference.env,
    ...(reference.scope ? { scope: reference.scope } : {}),
    ...(reference.operation ? { operation: reference.operation } : {}),
  });
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
  const resolver = getSecretResolver();
  if (!resolver) return null;
  try {
    const result = resolver.resolve(input);
    if (result instanceof Promise) {
      // Can't block a sync caller; surface a warning and fall through.
      logger.warn(
        `[secret-resolver] ${resolver.name} is async; sync callers fall back to vault. Use resolveSecretAsync instead.`
      );
      return null;
    }
    return result;
  } catch (err: any) {
    logger.warn(
      `[secret-resolver] ${resolver.name} failed for ${input.key}: ${err?.message ?? err}`
    );
    return null;
  }
}

export async function resolveSecretAsync(input: ResolveSecretInput): Promise<string | null> {
  const resolver = getSecretResolver();
  if (!resolver) return null;
  try {
    const result = await resolver.resolve(input);
    return result ?? null;
  } catch (err: any) {
    logger.warn(
      `[secret-resolver] ${resolver.name} failed for ${input.key}: ${err?.message ?? err}`
    );
    return null;
  }
}

export class ChainSecretResolver implements SecretResolver {
  readonly name: string;
  constructor(
    private readonly resolvers: SecretResolver[],
    name = 'chain'
  ) {
    this.name = `${name}(${resolvers.map((r) => r.name).join('→')})`;
  }
  async resolve(input: ResolveSecretInput): Promise<string | null> {
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver.resolve(input);
        if (result != null) return result;
      } catch (err: any) {
        logger.warn(
          `[secret-resolver:chain] ${resolver.name} threw for ${input.key}: ${err?.message ?? err}`
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

  describe(): SecretResolverDescription {
    return { configured: this.options.command.trim().length > 0, writable: false };
  }

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
export function installSecretResolverIfAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const command = env.KYBERION_SECRET_RESOLVER_COMMAND?.trim();
  if (!command) return false;
  resetSecretResolver();
  registerSecretResolver(
    new ShellSecretResolver({
      command,
      ...(env.KYBERION_SECRET_RESOLVER_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_SECRET_RESOLVER_TIMEOUT_MS, 10) }
        : {}),
    })
  );
  logger.success(
    '[secret-resolver] installed ShellSecretResolver from KYBERION_SECRET_RESOLVER_COMMAND'
  );
  return true;
}
