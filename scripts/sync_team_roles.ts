import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { loadTeamRoleDirectory, loadTeamRoleSnapshot } from '@agent/core/mission-team-index';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

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

const DIRECTORY = pathResolver.knowledge('product/orchestration/team-roles');
const SNAPSHOT = pathResolver.knowledge('product/orchestration/team-role-index.json');

function loadSnapshotRoles(): Record<string, TeamRoleRecord> {
  return loadTeamRoleSnapshot();
}

function loadDirectoryRoles(): Record<string, TeamRoleRecord> | null {
  if (!safeExistsSync(DIRECTORY)) {
    return null;
  }

  const files = safeReaddir(DIRECTORY)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    return null;
  }

  return loadTeamRoleDirectory();
}

async function renderDirectoryRoles(
  roles: Record<string, TeamRoleRecord>,
  prettierConfig: Record<string, unknown>
): Promise<GeneratedFile[]> {
  const entries = Object.entries(roles).sort(([left], [right]) => left.localeCompare(right));
  return Promise.all(
    entries.map(async ([role, record]) => {
      const payload: TeamRoleFile = {
        role,
        ...record,
      };
      return {
        path: path.join(DIRECTORY, `${role}.json`),
        content: await prettierFormat(JSON.stringify(payload, null, 2), {
          ...prettierConfig,
          parser: 'json',
        }),
      };
    })
  );
}

async function renderSnapshot(
  roles: Record<string, TeamRoleRecord>,
  prettierConfig: Record<string, unknown>
): Promise<GeneratedFile> {
  const team_roles: Record<string, TeamRoleRecord> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    team_roles[role] = record;
  }

  const payload = {
    version: '1.0.0',
    team_roles,
  };
  return {
    path: SNAPSHOT,
    content: await prettierFormat(JSON.stringify(payload, null, 2), {
      ...prettierConfig,
      parser: 'json',
    }),
  };
}

function loadRoles(): Record<string, TeamRoleRecord> {
  return loadDirectoryRoles() || loadSnapshotRoles();
}

async function render(): Promise<GeneratedFile[]> {
  const roles = loadRoles();
  const prettierConfig = (await resolvePrettierConfig(SNAPSHOT)) ?? {};
  return [
    ...(await renderDirectoryRoles(roles, prettierConfig)),
    await renderSnapshot(roles, prettierConfig),
  ];
}

const outputPaths = [
  ...Object.keys(loadRoles()).map((role) => path.join(DIRECTORY, `${role}.json`)),
  SNAPSHOT,
];

export const runSyncTeamRoles = defineGenerator({
  id: 'team-roles',
  outputs: outputPaths,
  normalize: (content) => JSON.stringify(JSON.parse(content)),
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_team_roles.ts') ||
  isDirectScript(import.meta.url, 'sync_team_roles.js')
)
  void runSyncTeamRoles();
