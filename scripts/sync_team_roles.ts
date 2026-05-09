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

type TeamRoleRecord = {
  description: string;
  required_capabilities: string[];
  compatible_authority_roles: string[];
  allowed_delegate_team_roles: string[];
  escalation_parent_team_role: string | null;
  required_scope_classes: string[];
  ownership_scope: string;
  selection_hints?: {
    preferred_agents?: string[];
    preferred_models?: string[];
  };
  autonomy_level: 'low' | 'medium' | 'high';
};

type TeamRoleFile = TeamRoleRecord & { role: string };

const DIRECTORY = pathResolver.knowledge('public/orchestration/team-roles');
const SNAPSHOT = pathResolver.knowledge('public/orchestration/team-role-index.json');

function readJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function loadSnapshotRoles(): Record<string, TeamRoleRecord> {
  const snapshot = readJson<{ team_roles?: Record<string, TeamRoleRecord> }>(SNAPSHOT);
  return snapshot.team_roles || {};
}

function loadDirectoryRoles(): Record<string, TeamRoleRecord> | null {
  if (!safeExistsSync(DIRECTORY)) {
    return null;
  }

  const files = safeReaddir(DIRECTORY).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    return null;
  }

  const roles: Record<string, TeamRoleRecord> = {};
  for (const file of files) {
    const filePath = path.join(DIRECTORY, file);
    const payload = readJson<TeamRoleFile>(filePath);
    const role = String(payload.role || '').trim();
    if (!role) {
      throw new Error(`Team role file ${file} must declare a role id`);
    }
    if (file.replace(/\.json$/i, '') !== role) {
      throw new Error(`Team role file ${file} must match its role id (${role})`);
    }
    const { role: _role, ...record } = payload;
    roles[role] = record;
  }

  return roles;
}

function writeDirectoryRoles(roles: Record<string, TeamRoleRecord>) {
  safeMkdir(DIRECTORY, { recursive: true });
  const entries = Object.entries(roles).sort(([left], [right]) => left.localeCompare(right));
  for (const [role, record] of entries) {
    const payload: TeamRoleFile = {
      role,
      ...record,
    };
    safeWriteFile(path.join(DIRECTORY, `${role}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }
}

function writeSnapshot(roles: Record<string, TeamRoleRecord>) {
  const team_roles: Record<string, TeamRoleRecord> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) => left.localeCompare(right))) {
    team_roles[role] = record;
  }

  safeWriteFile(
    SNAPSHOT,
    `${JSON.stringify(
      {
        version: '1.0.0',
        team_roles,
      },
      null,
      2,
    )}\n`,
  );
}

function main() {
  return withExecutionContext('ecosystem_architect', () => {
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
  });
}

main();
