import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import { loadAuthorityRoleIndex as loadGovernedAuthorityRoleIndex } from '@agent/core/mission-team-index';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

type AuthorityRoleRecord = {
  description: string;
  default_persona?: string;
  write_scopes: string[];
  scope_classes: string[];
  allowed_actuators: string[];
  tier_access: string[];
};

type AuthorityRoleFile = AuthorityRoleRecord & { role: string };

const DIRECTORY = pathResolver.knowledge('product/governance/authority-roles');
const SNAPSHOT = pathResolver.knowledge('product/governance/authority-role-index.json');

function loadSnapshotRoles(): Record<string, AuthorityRoleRecord> {
  return loadGovernedAuthorityRoleIndex();
}

function loadDirectoryRoles(): Record<string, AuthorityRoleRecord> | null {
  if (!safeExistsSync(DIRECTORY)) {
    return null;
  }

  const files = safeReaddir(DIRECTORY)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    return null;
  }

  return loadGovernedAuthorityRoleIndex();
}

async function renderDirectoryRoles(
  roles: Record<string, AuthorityRoleRecord>,
  prettierConfig: Record<string, unknown>
): Promise<GeneratedFile[]> {
  const entries = Object.entries(roles).sort(([left], [right]) => left.localeCompare(right));
  return Promise.all(
    entries.map(async ([role, record]) => {
      const filePath = path.join(DIRECTORY, `${role}.json`);
      const payload: AuthorityRoleFile = {
        role,
        ...record,
      };
      return {
        path: filePath,
        content: await prettierFormat(JSON.stringify(payload, null, 2), {
          ...prettierConfig,
          parser: 'json',
        }),
      };
    })
  );
}

async function renderSnapshot(
  roles: Record<string, AuthorityRoleRecord>,
  prettierConfig: Record<string, unknown>
): Promise<GeneratedFile> {
  const authority_roles: Record<string, AuthorityRoleRecord> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    authority_roles[role] = record;
  }

  const payload = {
    $schema: '../schemas/authority-role-index.schema.json',
    version: '1.0.0',
    authority_roles,
  };
  return {
    path: SNAPSHOT,
    content: await prettierFormat(JSON.stringify(payload, null, 2), {
      ...prettierConfig,
      parser: 'json',
    }),
  };
}

function loadRoles(): Record<string, AuthorityRoleRecord> {
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

export const runSyncAuthorityRoles = defineGenerator({
  id: 'authority-roles',
  outputs: outputPaths,
  normalize: (content) =>
    JSON.stringify(parseSafeJsonObjectInput(content, 'authority-role generated output')),
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_authority_roles.ts') ||
  isDirectScript(import.meta.url, 'sync_authority_roles.js')
)
  void runSyncAuthorityRoles();
