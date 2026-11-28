import { isRecord, parseSafeJsonInput } from '@agent/core/foundation';
import {
  parseManifestCredentialReads,
  type ManifestCredentialRead,
} from './backup-file-selection.js';
import { normalizeArchiveMember } from './backup-tenant-partitions.js';

export type BackupScope = 'all' | 'mission' | 'tenant';

export interface RestoredBackupManifest {
  format?: string;
  scope?: BackupScope;
  tenant?: string | null;
  entries?: string[];
  mission_git_repos?: Array<{
    repo_relative_path?: string;
    bundle_path?: string | null;
  }>;
  tenant_runtime_partitions?: Array<{
    key: string;
    path: string;
    append_only: boolean;
    hash_chained: boolean;
  }>;
  chain_key_id?: string;
  credential_reads?: ManifestCredentialRead[];
}

const CHAIN_KEY_ID_PATTERN = /^[0-9a-f]{16}$/u;

function parseTenantRuntimePartitions(
  value: unknown
): RestoredBackupManifest['tenant_runtime_partitions'] {
  if (!Array.isArray(value))
    throw new Error('Backup manifest tenant runtime partitions are invalid.');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      typeof entry.path !== 'string' ||
      typeof entry.append_only !== 'boolean' ||
      typeof entry.hash_chained !== 'boolean'
    ) {
      throw new Error('Backup manifest tenant runtime partition is invalid.');
    }
    return {
      key: entry.key,
      path: normalizeArchiveMember(entry.path),
      append_only: entry.append_only,
      hash_chained: entry.hash_chained,
    };
  });
}

export function parseRestoredBackupManifest(raw: string): RestoredBackupManifest {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw, 'Backup manifest');
  } catch (error) {
    throw new Error(
      `Backup manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) throw new Error('Backup manifest root must be a JSON object.');
  if (parsed.format !== 'kyberion-backup-v1') {
    throw new Error('Unsupported or missing backup manifest format.');
  }
  if (parsed.scope !== 'all' && parsed.scope !== 'mission' && parsed.scope !== 'tenant') {
    throw new Error('Backup manifest has an invalid scope.');
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('Backup manifest entries are missing or invalid.');
  }
  if (parsed.tenant !== undefined && parsed.tenant !== null && typeof parsed.tenant !== 'string') {
    throw new Error('Backup manifest tenant is invalid.');
  }
  let chainKeyId: string | undefined;
  if (parsed.chain_key_id !== undefined) {
    if (
      typeof parsed.chain_key_id !== 'string' ||
      !CHAIN_KEY_ID_PATTERN.test(parsed.chain_key_id)
    ) {
      throw new Error('Backup manifest chain key id is invalid.');
    }
    chainKeyId = parsed.chain_key_id;
  }
  const credentialReads =
    parsed.credential_reads === undefined
      ? undefined
      : parseManifestCredentialReads(parsed.credential_reads, normalizeArchiveMember);
  let missionGitRepos: RestoredBackupManifest['mission_git_repos'];
  if (parsed.mission_git_repos !== undefined) {
    if (!Array.isArray(parsed.mission_git_repos)) {
      throw new Error('Backup manifest mission git metadata is invalid.');
    }
    missionGitRepos = [];
    for (const entry of parsed.mission_git_repos) {
      if (!isRecord(entry) || typeof entry.repo_relative_path !== 'string') {
        throw new Error('Backup manifest mission repository path is invalid.');
      }
      if (
        entry.bundle_path !== undefined &&
        entry.bundle_path !== null &&
        typeof entry.bundle_path !== 'string'
      ) {
        throw new Error('Backup manifest mission bundle path is invalid.');
      }
      missionGitRepos.push({
        repo_relative_path: entry.repo_relative_path,
        ...(entry.bundle_path !== undefined
          ? { bundle_path: entry.bundle_path as string | null }
          : {}),
      });
    }
  }
  return {
    format: parsed.format,
    scope: parsed.scope,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant as string | null } : {}),
    entries: parsed.entries,
    ...(missionGitRepos ? { mission_git_repos: missionGitRepos } : {}),
    ...(parsed.tenant_runtime_partitions !== undefined
      ? {
          tenant_runtime_partitions: parseTenantRuntimePartitions(parsed.tenant_runtime_partitions),
        }
      : {}),
    ...(chainKeyId !== undefined ? { chain_key_id: chainKeyId } : {}),
    ...(credentialReads ? { credential_reads: credentialReads } : {}),
  };
}
