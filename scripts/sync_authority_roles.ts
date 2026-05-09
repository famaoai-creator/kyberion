import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

type AuthorityRoleRecord = {
  description: string;
  default_persona?: string;
  write_scopes: string[];
  scope_classes: string[];
  allowed_actuators: string[];
  tier_access: string[];
};

type AuthorityRoleFile = AuthorityRoleRecord & { role: string };

const DIRECTORY = pathResolver.knowledge('public/governance/authority-roles');
const SNAPSHOT = pathResolver.knowledge('public/governance/authority-role-index.json');

function readJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function loadSnapshotRoles(): Record<string, AuthorityRoleRecord> {
  const snapshot = readJson<{ authority_roles?: Record<string, AuthorityRoleRecord> }>(SNAPSHOT);
  return snapshot.authority_roles || {};
}

function loadDirectoryRoles(): Record<string, AuthorityRoleRecord> | null {
  if (!safeExistsSync(DIRECTORY)) {
    return null;
  }

  const files = safeReaddir(DIRECTORY).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    return null;
  }

  const roles: Record<string, AuthorityRoleRecord> = {};
  for (const file of files) {
    const filePath = path.join(DIRECTORY, file);
    const payload = readJson<AuthorityRoleFile>(filePath);
    const role = String(payload.role || '').trim();
    if (!role) {
      throw new Error(`Authority role file ${file} must declare a role id`);
    }
    if (file.replace(/\.json$/i, '') !== role) {
      throw new Error(`Authority role file ${file} must match its role id (${role})`);
    }
    const { role: _role, ...record } = payload;
    roles[role] = record;
  }

  return roles;
}

function writeDirectoryRoles(roles: Record<string, AuthorityRoleRecord>) {
  safeMkdir(DIRECTORY, { recursive: true });
  const entries = Object.entries(roles).sort(([left], [right]) => left.localeCompare(right));
  for (const [role, record] of entries) {
    const filePath = path.join(DIRECTORY, `${role}.json`);
    const payload: AuthorityRoleFile = {
      role,
      ...record,
    };
    safeWriteFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

function writeSnapshot(roles: Record<string, AuthorityRoleRecord>) {
  const authority_roles: Record<string, AuthorityRoleRecord> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) => left.localeCompare(right))) {
    authority_roles[role] = record;
  }

  safeWriteFile(
    SNAPSHOT,
    `${JSON.stringify(
      {
        version: '1.0.0',
        authority_roles,
      },
      null,
      2,
    )}\n`,
  );
}

function main() {
  return withExecutionContext(
    'ecosystem_architect',
    () => {
      const roles = loadDirectoryRoles() || loadSnapshotRoles();
      writeDirectoryRoles(roles);
      writeSnapshot(roles);
      console.log(
        JSON.stringify(
          {
            status: 'ok',
            role_count: Object.keys(roles).length,
            canonical_directory: path.relative(pathResolver.rootDir(), DIRECTORY),
            snapshot_path: path.relative(pathResolver.rootDir(), SNAPSHOT),
          },
          null,
          2,
        ),
      );
    },
  );
}

main();
