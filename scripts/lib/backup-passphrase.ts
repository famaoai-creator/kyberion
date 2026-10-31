/**
 * Backup passphrase resolution.
 *
 * Order: an explicit `--passphrase-env <NAME>` → the KYBERION_BACKUP_PASSPHRASE
 * env override → the governed secret identity `kyberion-backup` / `PASSPHRASE`
 * (env name KYBERION_BACKUP_PASSPHRASE, keychain service `kyberion-backup`,
 * account `passphrase`, per libs/core/secret/secret-identity.ts).
 *
 * The secret must live outside the repository — an external secret resolver
 * or the OS keychain — because `vault/` and `knowledge/personal/` ride inside
 * the archive the passphrase protects. A copy held only in an in-repo store is
 * refused with [BACKUP_PASSPHRASE_IN_BACKUP_SCOPE]; the connection document
 * `secret introduce` dual-writes is excluded from every archive
 * (BACKUP_PASSPHRASE_CONNECTION_FILES).
 *
 * The value is never logged, audited or returned by the availability probe.
 */
import { getRegisteredEnvText } from '@agent/core/foundation';
import { BACKUP_PASSPHRASE_CONNECTION_FILES } from './backup-file-selection.js';
import { logger } from '@agent/core/core';
import { resolveExecutionPersona } from '@agent/core/authority';
import { auditChain } from '@agent/core/governance/audit-chain';
import { fetchOsKeychainSecretSync } from '@agent/core/secret/secret-bridge';
import { getSecretForIdentity, loadConnectionDocument } from '@agent/core/secret/secret-guard';
import { resolveSecretIdentity, type SecretIdentity } from '@agent/core/secret/secret-identity';
import { getSecretResolver, resolveSecretSync } from '@agent/core/secret/secret-resolver';

export { BACKUP_PASSPHRASE_CONNECTION_FILES };

export const BACKUP_PASSPHRASE_ENV = 'KYBERION_BACKUP_PASSPHRASE';
export const BACKUP_PASSPHRASE_SERVICE_ID = 'kyberion-backup';
export const BACKUP_PASSPHRASE_SECRET_KEY = 'PASSPHRASE';
export const BACKUP_PASSPHRASE_INTRODUCE_COMMAND = `pnpm kyberion secret introduce ${BACKUP_PASSPHRASE_SERVICE_ID} ${BACKUP_PASSPHRASE_SECRET_KEY}`;

export function backupPassphraseIdentity(): SecretIdentity {
  return resolveSecretIdentity(BACKUP_PASSPHRASE_SERVICE_ID, BACKUP_PASSPHRASE_SECRET_KEY);
}

/** Secret stores the passphrase may be read from, and in-repo ones it may not. */
export interface BackupPassphraseSecretBackend {
  /** Out-of-repo stores only (external resolver, OS keychain); `backend` names the store. */
  lookupOutsideBackupScope(identity: SecretIdentity): { value: string; backend: string } | null;
  /** Names (never values) of in-repo stores holding the identity — they are archived. */
  inBackupScopeStores(identity: SecretIdentity): string[];
}

export type BackupPassphraseSource = 'env' | `secret:${string}`;

export interface BackupPassphraseAuditRecord {
  action: 'backup.passphrase_resolved';
  operation: string;
  source: BackupPassphraseSource;
  envName: string;
}

export interface BackupPassphraseDeps {
  readEnv?: (name: string) => string | undefined;
  backend?: BackupPassphraseSecretBackend;
  audit?: (record: BackupPassphraseAuditRecord) => void;
}

export interface ResolvedBackupPassphrase {
  value: string;
  source: BackupPassphraseSource;
  /** Env name the openssl child reads the value from (`-pass env:<envName>`). */
  envName: string;
}

export const governedBackupPassphraseBackend: BackupPassphraseSecretBackend = {
  lookupOutsideBackupScope(identity) {
    if (getSecretResolver()) {
      const upstream = resolveSecretSync({ key: identity.envName, operation: 'backup' });
      if (upstream) return { value: upstream, backend: 'external_resolver' };
    }
    const keychain = fetchOsKeychainSecretSync(identity.keychainService, identity.keychainAccount);
    if (keychain) return { value: keychain, backend: 'os_keychain' };
    return null;
  },
  inBackupScopeStores(identity) {
    const stores: string[] = [];
    try {
      const doc = loadConnectionDocument(identity.serviceId);
      const field = doc?.[identity.connectionField];
      if (typeof field === 'string' && field) stores.push(BACKUP_PASSPHRASE_CONNECTION_FILES[0]);
    } catch {
      /* tenant execution or an undecryptable document: not provably present */
    }
    try {
      // Reached only after the env and keychain/resolver missed, so a hit here
      // comes from secret-guard's local stores (vault/secrets/*.json).
      if (getSecretForIdentity(identity, 'backup-passphrase-scope-probe')) {
        stores.push('vault/secrets (secret-guard local store)');
      }
    } catch {
      /* a denied or failing probe is not evidence of an in-repo copy */
    }
    return stores;
  },
};

function defaultAudit(record: BackupPassphraseAuditRecord): void {
  try {
    auditChain.record({
      agentId: resolveExecutionPersona() || 'backup-operator',
      action: record.action,
      operation: record.operation,
      result: 'completed',
      metadata: { source: record.source, env_name: record.envName },
    });
  } catch {
    logger.warn(
      `[backup] passphrase source audit unavailable — the audit chain refused the record | next: run pnpm doctor to check the audit chain | evidence: source=${record.source}`
    );
  }
}

export function missingPassphraseMessage(envName: string, explicit: boolean): string {
  if (explicit) {
    return `[BACKUP_PASSPHRASE_MISSING] Missing ${envName} — --passphrase-env names that variable explicitly, so neither ${BACKUP_PASSPHRASE_ENV} nor the secret store is consulted | next: export ${envName} in the process environment, or drop --passphrase-env to use the passphrase stored with ${BACKUP_PASSPHRASE_INTRODUCE_COMMAND} | evidence: ${envName} is unset or empty`;
  }
  return `[BACKUP_PASSPHRASE_MISSING] No backup passphrase — encrypted backups and restores read it from ${envName} or the OS keychain / external secret resolver (identity ${BACKUP_PASSPHRASE_SERVICE_ID}/${BACKUP_PASSPHRASE_SECRET_KEY}), and neither holds it | next: store it once with ${BACKUP_PASSPHRASE_INTRODUCE_COMMAND} (hidden prompt; a launchd agent in your GUI session reads the login keychain) and keep an offline copy in your password manager; for a one-off override export ${envName}=... or name another variable with --passphrase-env; never put it in a plist, the env registry, the archive or a repo file | evidence: ${envName} is unset or empty and keychain service ${BACKUP_PASSPHRASE_SERVICE_ID} account passphrase was not found`;
}

export function inBackupScopeMessage(stores: string[]): string {
  return `[BACKUP_PASSPHRASE_IN_BACKUP_SCOPE] The backup passphrase was found only in an in-repository store — those paths are archived, so the key would travel inside the archive it protects; refusing to use it | next: store it in the OS keychain with ${BACKUP_PASSPHRASE_INTRODUCE_COMMAND} (or configure KYBERION_SECRET_RESOLVER_COMMAND for an external manager), or export ${BACKUP_PASSPHRASE_ENV} for this run, then remove the in-repo copy | evidence: ${stores.join(', ')}`;
}

type Resolution =
  | { kind: 'resolved'; value: string; source: BackupPassphraseSource }
  | { kind: 'missing'; explicit: boolean }
  | { kind: 'in_scope'; stores: string[] };

function resolve(envName: string, deps: BackupPassphraseDeps): Resolution {
  const readEnv = deps.readEnv ?? getRegisteredEnvText;
  const explicit = envName !== BACKUP_PASSPHRASE_ENV;
  const fromEnv = readEnv(envName);
  if (fromEnv) return { kind: 'resolved', value: fromEnv, source: 'env' };
  if (explicit) return { kind: 'missing', explicit: true };
  const backend = deps.backend ?? governedBackupPassphraseBackend;
  const identity = backupPassphraseIdentity();
  const found = backend.lookupOutsideBackupScope(identity);
  if (found?.value)
    return { kind: 'resolved', value: found.value, source: `secret:${found.backend}` };
  const stores = backend.inBackupScopeStores(identity);
  if (stores.length > 0) return { kind: 'in_scope', stores };
  return { kind: 'missing', explicit: false };
}

/** Resolve the passphrase or throw a diagnostic; audits the source, never the value. */
export function resolveBackupPassphrase(
  envName: string,
  operation: string,
  deps: BackupPassphraseDeps = {}
): ResolvedBackupPassphrase {
  const result = resolve(envName, deps);
  if (result.kind === 'missing')
    throw new Error(missingPassphraseMessage(envName, result.explicit));
  if (result.kind === 'in_scope') throw new Error(inBackupScopeMessage(result.stores));
  (deps.audit ?? defaultAudit)({
    action: 'backup.passphrase_resolved',
    operation,
    source: result.source,
    envName,
  });
  return { value: result.value, source: result.source, envName };
}

export interface BackupPassphraseAvailability {
  available: boolean;
  source: 'env' | 'secret' | null;
  /** Store name when source is 'secret' (os_keychain | external_resolver). */
  backend?: string;
  /** Diagnostic when unavailable ([BACKUP_PASSPHRASE_MISSING] / [..._IN_BACKUP_SCOPE] ...). */
  reason?: string;
}

/**
 * Non-sensitive availability probe for ops-health / doctor: same resolution
 * as a backup run, but the value is dropped and nothing is audited.
 */
export function describeBackupPassphraseAvailability(
  options: { passphraseEnv?: string } & BackupPassphraseDeps = {}
): BackupPassphraseAvailability {
  const envName = options.passphraseEnv ?? BACKUP_PASSPHRASE_ENV;
  let result: Resolution;
  try {
    result = resolve(envName, options);
  } catch (error) {
    return {
      available: false,
      source: null,
      reason: `[BACKUP_PASSPHRASE_PROBE_FAILED] ${error instanceof Error ? error.name : 'error'}`,
    };
  }
  if (result.kind === 'resolved') {
    if (result.source === 'env') return { available: true, source: 'env' };
    return { available: true, source: 'secret', backend: result.source.slice('secret:'.length) };
  }
  if (result.kind === 'in_scope') {
    return { available: false, source: null, reason: inBackupScopeMessage(result.stores) };
  }
  return {
    available: false,
    source: null,
    reason: missingPassphraseMessage(envName, result.explicit),
  };
}
