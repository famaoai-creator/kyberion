#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

type Persona =
  | 'sovereign'
  | 'ecosystem_architect'
  | 'mission_owner'
  | 'worker'
  | 'analyst'
  | 'unknown';
type AutonomyLevel = 'low' | 'medium' | 'high';

type AuthorityRoleRecord = {
  description: string;
  default_persona?: Persona;
  write_scopes: string[];
  scope_classes: string[];
  allowed_actuators: string[];
  tier_access: string[];
};

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
  autonomy_level: AutonomyLevel;
};

type RoleAuthorityEntry = {
  role: string;
  persona: Persona;
  execution_mode?: string;
  authority_role?: string;
};

type SecurityPolicy = {
  version?: string;
  default_allow?: string[];
  tier_restrictions?: Record<string, unknown>;
  persona_permissions?: Record<string, { allow_read?: string[]; allow_write?: string[] }>;
  authority_role_permissions?: Record<string, { allow_read?: string[]; allow_write?: string[] }>;
  [key: string]: unknown;
};

type RoleWriteAccess = {
  version?: string;
  default_allow?: string[];
  roles?: Record<string, { allow?: string[] }>;
};

type OrgRoleCreateOptions = {
  name: string;
  domain: string;
  authorityRoleId: string;
  persona: Persona;
  description?: string;
  ownershipScope?: string;
  requiredCapabilities: string[];
  scopeClasses: string[];
  writeScopes: string[];
  allowedActuators: string[];
  tierAccess: string[];
  autonomyLevel: AutonomyLevel;
  escalationParentTeamRole: string | null;
  allowedDelegateTeamRoles: string[];
  teamRoleId: string;
  dryRun: boolean;
};

type OrgRolePromoteOptions = {
  roleId: string;
  authorityRoleId: string;
  persona: Persona;
  description?: string;
  writeScopes: string[];
  scopeClasses: string[];
  allowedActuators: string[];
  tierAccess: string[];
  dryRun: boolean;
};

type OrgCommand =
  | {
      kind: 'role-create';
      options: Partial<OrgRoleCreateOptions> & { name: string; domain: string };
    }
  | {
      kind: 'role-promote';
      options: Partial<OrgRolePromoteOptions> & { roleId: string; authorityRoleId: string };
    }
  | { kind: 'help' };

const DEFAULT_PERSONA: Persona = 'analyst';
const DEFAULT_SELECTION_AGENTS = ['nerve-agent'];
const DEFAULT_SELECTION_MODELS = ['auto-gemini-3'];

const DOMAIN_TEMPLATES: Record<
  string,
  {
    persona: Persona;
    requiredCapabilities: string[];
    scopeClasses: string[];
    allowedActuators: string[];
    tierAccess: string[];
    autonomyLevel: AutonomyLevel;
    escalationParentTeamRole: string | null;
    allowedDelegateTeamRoles: string[];
    ownershipScope: string;
    defaultWriteScopes: string[];
  }
> = {
  leadership: {
    persona: 'analyst',
    requiredCapabilities: ['analysis', 'coordination', 'decision_making'],
    scopeClasses: ['knowledge_core', 'coordination_runtime'],
    allowedActuators: ['artifact-actuator'],
    tierAccess: ['public', 'confidential'],
    autonomyLevel: 'medium',
    escalationParentTeamRole: 'owner',
    allowedDelegateTeamRoles: ['planner', 'reviewer', 'scribe'],
    ownershipScope: 'Owns leadership decisions, governance, and planning artifacts.',
    defaultWriteScopes: [
      'knowledge/product/roles/${role_id}/',
      'knowledge/product/governance/authority-roles/${authority_role_id}.json',
      'knowledge/product/governance/role-authority-map.json',
      'knowledge/product/governance/security-policy.json',
      'knowledge/product/orchestration/team-roles/${team_role_id}.json',
    ],
  },
  finance: {
    persona: 'analyst',
    requiredCapabilities: ['analysis', 'financial_reasoning', 'coordination'],
    scopeClasses: ['knowledge_core', 'project_delivery'],
    allowedActuators: ['artifact-actuator'],
    tierAccess: ['public', 'confidential'],
    autonomyLevel: 'medium',
    escalationParentTeamRole: 'owner',
    allowedDelegateTeamRoles: ['planner', 'reviewer'],
    ownershipScope: 'Owns financial governance, budgeting, and reporting artifacts.',
    defaultWriteScopes: [
      'knowledge/product/roles/${role_id}/',
      'knowledge/product/governance/authority-roles/${authority_role_id}.json',
      'knowledge/product/governance/role-authority-map.json',
      'knowledge/product/governance/security-policy.json',
      'knowledge/product/orchestration/team-roles/${team_role_id}.json',
    ],
  },
  default: {
    persona: DEFAULT_PERSONA,
    requiredCapabilities: ['coordination', 'reasoning'],
    scopeClasses: ['knowledge_core'],
    allowedActuators: ['artifact-actuator'],
    tierAccess: ['public', 'confidential'],
    autonomyLevel: 'medium',
    escalationParentTeamRole: 'owner',
    allowedDelegateTeamRoles: ['reviewer'],
    ownershipScope: 'Owns governed artifacts inside the assigned scope.',
    defaultWriteScopes: [
      'knowledge/product/roles/${role_id}/',
      'knowledge/product/governance/authority-roles/${authority_role_id}.json',
      'knowledge/product/governance/role-authority-map.json',
      'knowledge/product/governance/security-policy.json',
      'knowledge/product/orchestration/team-roles/${team_role_id}.json',
    ],
  },
};

function helpText(): string {
  return [
    'Usage:',
    '  pnpm org role create --name <display-name> --domain <domain> [--authority <authority-role-id>]',
    '  pnpm org role promote --role <role-id> --authority <authority-role-id>',
    '',
    'Options:',
    '  --name <name>                 Display name for the new role.',
    '  --domain <domain>             Role domain used for defaults.',
    '  --role <role-id>              Existing role id to promote.',
    '  --authority <id>              Authority role id to create or update.',
    '  --authority-role <id>         Alias for --authority.',
    '  --persona <persona>           Default persona (analyst, worker, sovereign, ecosystem_architect, mission_owner).',
    '  --capability <value>          Repeatable team-role capability.',
    '  --scope-class <value>         Repeatable authority/team scope class.',
    '  --write-scope <prefix>        Repeatable authority write scope prefix.',
    '  --actuator <name>             Repeatable allowed actuator.',
    '  --tier <tier>                 Repeatable allowed tier (public/confidential/personal).',
    '  --ownership-scope <text>      Team-role ownership scope.',
    '  --description <text>          Custom role description.',
    '  --autonomy <level>            low | medium | high.',
    '  --parent-team-role <role>     Escalation parent team role.',
    '  --delegate-role <role>        Repeatable allowed delegate team role.',
    '  --dry-run                     Print the planned change set without writing.',
  ].join('\n');
}

function parseArgs(argv: string[]): OrgCommand {
  const args = [...argv];
  if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' };
  }

  if (args[0] !== 'role' || args[1] !== 'create') {
    if (args[0] === 'role' && args[1] === 'promote') {
      const options: Record<string, unknown> = {
        writeScopes: [],
        scopeClasses: [],
        allowedActuators: [],
        tierAccess: [],
      };
      for (let i = 2; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--role') options.roleId = args[++i];
        else if (arg === '--authority' || arg === '--authority-role')
          options.authorityRoleId = args[++i];
        else if (arg === '--persona') options.persona = args[++i];
        else if (arg === '--description') options.description = args[++i];
        else if (arg === '--write-scope') (options.writeScopes as string[]).push(args[++i]);
        else if (arg === '--scope-class') (options.scopeClasses as string[]).push(args[++i]);
        else if (arg === '--actuator') (options.allowedActuators as string[]).push(args[++i]);
        else if (arg === '--tier') (options.tierAccess as string[]).push(args[++i]);
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--help' || arg === '-h') return { kind: 'help' };
        else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
      }

      if (!options.roleId || !options.authorityRoleId) {
        throw new Error('Both --role and --authority are required');
      }

      return {
        kind: 'role-promote',
        options: options as Partial<OrgRolePromoteOptions> & {
          roleId: string;
          authorityRoleId: string;
        },
      };
    }
    throw new Error('Unsupported command. Use: pnpm org role create ...');
  }

  const options: Record<string, unknown> = {
    requiredCapabilities: [],
    scopeClasses: [],
    writeScopes: [],
    allowedActuators: [],
    tierAccess: [],
    allowedDelegateTeamRoles: [],
  };
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name') options.name = args[++i];
    else if (arg === '--domain') options.domain = args[++i];
    else if (arg === '--authority' || arg === '--authority-role')
      options.authorityRoleId = args[++i];
    else if (arg === '--persona') options.persona = args[++i];
    else if (arg === '--description') options.description = args[++i];
    else if (arg === '--ownership-scope') options.ownershipScope = args[++i];
    else if (arg === '--autonomy') options.autonomyLevel = args[++i];
    else if (arg === '--parent-team-role') options.escalationParentTeamRole = args[++i];
    else if (arg === '--capability') (options.requiredCapabilities as string[]).push(args[++i]);
    else if (arg === '--scope-class') (options.scopeClasses as string[]).push(args[++i]);
    else if (arg === '--write-scope') (options.writeScopes as string[]).push(args[++i]);
    else if (arg === '--actuator') (options.allowedActuators as string[]).push(args[++i]);
    else if (arg === '--tier') (options.tierAccess as string[]).push(args[++i]);
    else if (arg === '--delegate-role')
      (options.allowedDelegateTeamRoles as string[]).push(args[++i]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') return { kind: 'help' };
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.name || !options.domain) {
    throw new Error('Both --name and --domain are required');
  }

  return {
    kind: 'role-create',
    options: options as Partial<OrgRoleCreateOptions> & { name: string; domain: string },
  };
}

function normalizeRoleId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function toTitleCase(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((word) =>
      word.toUpperCase() === word
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function readJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function readJsonIfExists<T>(filePath: string): T | null {
  return safeExistsSync(filePath) ? readJson<T>(filePath) : null;
}

function writeJson(filePath: string, payload: unknown): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function resolveDomainTemplate(domain: string) {
  return DOMAIN_TEMPLATES[domain.toLowerCase()] || DOMAIN_TEMPLATES.default;
}

function resolvePersona(inputPersona: string | undefined, fallback: Persona): Persona {
  if (!inputPersona) return fallback;
  const normalized = inputPersona.trim().toLowerCase().replace(/\s+/g, '_') as Persona;
  const allowed: Persona[] = [
    'sovereign',
    'ecosystem_architect',
    'mission_owner',
    'worker',
    'analyst',
    'unknown',
  ];
  if (!allowed.includes(normalized)) {
    throw new Error(`Unsupported persona: ${inputPersona}`);
  }
  if (normalized === 'unknown') {
    throw new Error('persona cannot be unknown for a created role');
  }
  return normalized;
}

function resolveAuthorityRoleRecord(
  rootDir: string,
  authorityRoleId: string,
  input: OrgRoleCreateOptions
): AuthorityRoleRecord {
  const authorityDir = path.join(rootDir, 'knowledge', 'product', 'governance', 'authority-roles');
  const existing = readJsonIfExists<AuthorityRoleRecord>(
    path.join(authorityDir, `${authorityRoleId}.json`)
  );
  const template = resolveDomainTemplate(input.domain);

  const writeScopes = unique([
    ...(existing?.write_scopes || []),
    ...input.writeScopes,
    ...template.defaultWriteScopes.map((scope) =>
      scope
        .replace('${role_id}', input.teamRoleId)
        .replace('${authority_role_id}', authorityRoleId)
        .replace('${team_role_id}', input.teamRoleId)
    ),
  ]);

  const scopeClasses = unique([
    ...(existing?.scope_classes || []),
    ...input.scopeClasses,
    ...template.scopeClasses,
  ]);
  const allowedActuators = unique([
    ...(existing?.allowed_actuators || []),
    ...input.allowedActuators,
    ...template.allowedActuators,
  ]);
  const tierAccess = unique([
    ...(existing?.tier_access || []),
    ...input.tierAccess,
    ...template.tierAccess,
  ]);

  return {
    description:
      input.description ||
      existing?.description ||
      `${toTitleCase(input.name)} authority for ${input.domain} responsibilities.`,
    default_persona: input.persona || existing?.default_persona || template.persona,
    write_scopes: writeScopes,
    scope_classes: scopeClasses,
    allowed_actuators: allowedActuators,
    tier_access: tierAccess,
  };
}

function resolveTeamRoleRecord(
  input: OrgRoleCreateOptions,
  authorityRoleId: string
): TeamRoleRecord {
  const template = resolveDomainTemplate(input.domain);
  const requiredCapabilities = unique([
    ...(input.requiredCapabilities.length
      ? input.requiredCapabilities
      : template.requiredCapabilities),
    ...template.requiredCapabilities,
  ]);
  const requiredScopeClasses = unique([
    ...(input.scopeClasses.length ? input.scopeClasses : template.scopeClasses),
  ]);
  const allowedDelegateTeamRoles = unique([
    ...(input.allowedDelegateTeamRoles.length
      ? input.allowedDelegateTeamRoles
      : template.allowedDelegateTeamRoles),
  ]);

  return {
    description:
      input.description || `${toTitleCase(input.name)} role for ${input.domain} responsibilities.`,
    required_capabilities: requiredCapabilities,
    compatible_authority_roles: [authorityRoleId],
    allowed_delegate_team_roles: allowedDelegateTeamRoles,
    escalation_parent_team_role:
      input.escalationParentTeamRole ?? template.escalationParentTeamRole,
    required_scope_classes: requiredScopeClasses.length
      ? requiredScopeClasses
      : template.scopeClasses,
    ownership_scope: input.ownershipScope || template.ownershipScope,
    selection_hints: {
      preferred_agents: DEFAULT_SELECTION_AGENTS,
      preferred_models: DEFAULT_SELECTION_MODELS,
    },
    autonomy_level: (input.autonomyLevel || template.autonomyLevel) as AutonomyLevel,
  };
}

function resolveRoleAuthorityEntry(
  input: OrgRoleCreateOptions,
  authorityRoleId: string
): RoleAuthorityEntry {
  return {
    role: input.teamRoleId,
    persona: input.persona,
    execution_mode: 'mission',
    authority_role: authorityRoleId,
  };
}

function resolvePromotionRoleAuthorityEntry(
  roleId: string,
  authorityRoleId: string,
  persona: Persona
): RoleAuthorityEntry {
  return {
    role: roleId,
    persona,
    execution_mode: 'mission',
    authority_role: authorityRoleId,
  };
}

function defaultProcedureMarkdown(
  input: OrgRoleCreateOptions,
  authorityRoleId: string,
  teamRole: TeamRoleRecord,
  authorityRole: AuthorityRoleRecord
): string {
  const capabilityList = teamRole.required_capabilities
    .map((capability) => `- ${capability}`)
    .join('\n');
  const writeScopeList = authorityRole.write_scopes.map((scope) => `- \`${scope}\``).join('\n');

  return `---
title: Role Procedure: ${toTitleCase(input.name)}
tags: [role, ${input.teamRoleId}, governance]
importance: 8
author: Ecosystem Architect
last_updated: ${new Date().toISOString().slice(0, 10)}
kind: role
scope: global
authority: advisory
phase: [alignment, execution, review]
role_affinity: [${input.teamRoleId}]
applies_to: [${input.domain}]
owner: ${input.teamRoleId}
status: active
---

# Role Procedure: ${toTitleCase(input.name)}

## 1. Identity & Scope
You are the governed role for ${toTitleCase(input.name)} work in the ${input.domain} domain.

- **Authority Role**: \`${authorityRoleId}\`
- **Default Persona**: \`${authorityRole.default_persona || DEFAULT_PERSONA}\`
- **Team Role**: \`${input.teamRoleId}\`
- **Primary Write Scopes**:
${writeScopeList || '- (none configured)'}
- **Core Capabilities**:
${capabilityList}

## 2. Standard Procedures
### A. Intake
- Confirm the target domain and the minimum authority required before editing any governed artifact.
- Keep changes narrow. Add new scopes explicitly instead of broadening existing ones implicitly.

### B. Execution
- Use the authority role permissions as the runtime boundary.
- Prefer updates that are idempotent and reviewable.

### C. Validation
- Regenerate the authority-role and team-role snapshots after any file change.
- Check the security policy entry before relying on the role in a live mission.
`;
}

function defaultMissionMarkdown(input: OrgRoleCreateOptions, authorityRoleId: string): string {
  return `---
title: ${toTitleCase(input.name)} Mission Statement
category: Roles
tags: [roles, ${input.teamRoleId}, mission]
importance: 7
author: Ecosystem Architect
last_updated: ${new Date().toISOString().slice(0, 10)}
---

# ${toTitleCase(input.name)} Mission Statement

## 1. Purpose
Deliver governed ${input.domain} outcomes with the minimum authority required.

## 2. Authority Boundaries
- Runtime authority role: \`${authorityRoleId}\`
- Role identity: \`${input.teamRoleId}\`
- Persona: \`${input.persona}\`

## 3. Core Capabilities
${input.requiredCapabilities.map((capability) => `- ${capability}`).join('\n')}
`;
}

function loadAuthorityRoleDirectory(rootDir: string): Record<string, AuthorityRoleRecord> {
  const directory = path.join(rootDir, 'knowledge', 'product', 'governance', 'authority-roles');
  const snapshot = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'authority-role-index.json'
  );
  if (safeExistsSync(directory)) {
    const files = safeReaddir(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    if (files.length) {
      const roles: Record<string, AuthorityRoleRecord> = {};
      for (const file of files) {
        const payload = readJson<AuthorityRoleRecord & { role: string }>(
          path.join(directory, file)
        );
        roles[payload.role] = (() => {
          const { role: _role, ...record } = payload;
          return record;
        })();
      }
      return roles;
    }
  }
  const snapshotPayload = readJsonIfExists<{
    authority_roles?: Record<string, AuthorityRoleRecord>;
  }>(snapshot);
  return snapshotPayload?.authority_roles ? { ...snapshotPayload.authority_roles } : {};
}

function writeAuthorityRoleBundle(
  rootDir: string,
  roleId: string,
  record: AuthorityRoleRecord
): void {
  const directory = path.join(rootDir, 'knowledge', 'product', 'governance', 'authority-roles');
  safeMkdir(directory, { recursive: true });
  writeJson(path.join(directory, `${roleId}.json`), { role: roleId, ...record });
}

function syncAuthorityRoleSnapshot(
  rootDir: string,
  roles: Record<string, AuthorityRoleRecord>
): void {
  const snapshot = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'authority-role-index.json'
  );
  const authority_roles: Record<string, AuthorityRoleRecord> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    authority_roles[role] = record;
  }
  writeJson(snapshot, { version: '1.0.0', authority_roles });
}

function loadTeamRoleDirectory(rootDir: string): Record<string, TeamRoleRecord> {
  const directory = path.join(rootDir, 'knowledge', 'product', 'orchestration', 'team-roles');
  const snapshot = path.join(
    rootDir,
    'knowledge',
    'product',
    'orchestration',
    'team-role-index.json'
  );
  if (safeExistsSync(directory)) {
    const files = safeReaddir(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    if (files.length) {
      const roles: Record<string, TeamRoleRecord> = {};
      for (const file of files) {
        const payload = readJson<TeamRoleRecord & { role: string }>(path.join(directory, file));
        roles[payload.role] = (() => {
          const { role: _role, ...record } = payload;
          return record;
        })();
      }
      return roles;
    }
  }
  const snapshotPayload = readJsonIfExists<{ team_roles?: Record<string, TeamRoleRecord> }>(
    snapshot
  );
  return snapshotPayload?.team_roles ? { ...snapshotPayload.team_roles } : {};
}

function writeTeamRoleBundle(rootDir: string, roleId: string, record: TeamRoleRecord): void {
  const directory = path.join(rootDir, 'knowledge', 'product', 'orchestration', 'team-roles');
  safeMkdir(directory, { recursive: true });
  writeJson(path.join(directory, `${roleId}.json`), { role: roleId, ...record });
}

function syncTeamRoleSnapshot(rootDir: string, roles: Record<string, TeamRoleRecord>): void {
  const snapshot = path.join(
    rootDir,
    'knowledge',
    'product',
    'orchestration',
    'team-role-index.json'
  );
  const team_roles: Record<string, TeamRoleRecord> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    team_roles[role] = record;
  }
  writeJson(snapshot, { version: '1.0.0', team_roles });
}

function loadRoleAuthorityMap(rootDir: string): {
  version?: string;
  description?: string;
  system_roles?: RoleAuthorityEntry[];
  mission_roles?: RoleAuthorityEntry[];
  context_roles?: RoleAuthorityEntry[];
} {
  const filePath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'role-authority-map.json'
  );
  return (
    readJsonIfExists(filePath) ?? {
      version: '1.0.0',
      description: 'Maps knowledge roles to execution mode, persona, and authority_role.',
      system_roles: [],
      mission_roles: [],
      context_roles: [],
    }
  );
}

function upsertRoleAuthorityMap(rootDir: string, entry: RoleAuthorityEntry): void {
  const filePath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'role-authority-map.json'
  );
  const map = loadRoleAuthorityMap(rootDir);
  const buckets = ['system_roles', 'mission_roles', 'context_roles'] as const;
  for (const bucket of buckets) {
    const existing = Array.isArray(map[bucket]) ? map[bucket]! : [];
    map[bucket] = existing.filter((item) => item.role !== entry.role);
  }
  map.context_roles = [...(map.context_roles || []), entry].sort((left, right) =>
    left.role.localeCompare(right.role)
  );
  writeJson(filePath, map);
}

function loadSecurityPolicy(rootDir: string): SecurityPolicy {
  const filePath = path.join(rootDir, 'knowledge', 'product', 'governance', 'security-policy.json');
  return (
    readJsonIfExists<SecurityPolicy>(filePath) ?? {
      version: '1.0.0',
      default_allow: [],
      tier_restrictions: {},
      persona_permissions: {},
      authority_role_permissions: {},
    }
  );
}

function loadRoleWriteAccess(rootDir: string): RoleWriteAccess {
  const filePath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'role-write-access.json'
  );
  return (
    readJsonIfExists<RoleWriteAccess>(filePath) ?? {
      version: '1.0.0',
      default_allow: [],
      roles: {},
    }
  );
}

function upsertRoleWriteAccess(rootDir: string, roleId: string, scopes: string[]): void {
  const filePath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'role-write-access.json'
  );
  const access = loadRoleWriteAccess(rootDir);
  access.roles = access.roles || {};
  access.roles[roleId] = { allow: unique(scopes) };
  writeJson(filePath, access);
}

function upsertSecurityPolicy(
  rootDir: string,
  authorityRoleId: string,
  record: AuthorityRoleRecord
): void {
  const filePath = path.join(rootDir, 'knowledge', 'product', 'governance', 'security-policy.json');
  const policy = loadSecurityPolicy(rootDir);
  policy.authority_role_permissions = policy.authority_role_permissions || {};
  policy.authority_role_permissions[authorityRoleId] = {
    allow_read: [...record.write_scopes],
    allow_write: [...record.write_scopes],
  };
  writeJson(filePath, policy);
}

function writeRoleDocs(
  rootDir: string,
  input: OrgRoleCreateOptions,
  authorityRoleId: string,
  teamRole: TeamRoleRecord,
  authorityRole: AuthorityRoleRecord
): void {
  const roleDir = path.join(rootDir, 'knowledge', 'product', 'roles', input.teamRoleId);
  safeMkdir(roleDir, { recursive: true });
  safeWriteFile(
    path.join(roleDir, 'PROCEDURE.md'),
    `${defaultProcedureMarkdown(input, authorityRoleId, teamRole, authorityRole)}\n`
  );
  safeWriteFile(
    path.join(roleDir, 'mission.md'),
    `${defaultMissionMarkdown(input, authorityRoleId)}\n`
  );
}

function writePromotionNotes(
  rootDir: string,
  roleId: string,
  authorityRoleId: string,
  updatedAuthority: AuthorityRoleRecord,
  updatedTeam: TeamRoleRecord
): void {
  const roleDir = path.join(rootDir, 'knowledge', 'product', 'roles', roleId);
  safeMkdir(roleDir, { recursive: true });
  const promotionNotes = [
    `---`,
    `title: Promotion Notes: ${toTitleCase(roleId.replace(/_/g, ' '))}`,
    `kind: role-promotion`,
    `status: active`,
    `authority_role: ${authorityRoleId}`,
    `---`,
    ``,
    `# Promotion Notes: ${toTitleCase(roleId.replace(/_/g, ' '))}`,
    ``,
    `- Authority role: \`${authorityRoleId}\``,
    `- Write scopes:`,
    ...updatedAuthority.write_scopes.map((scope) => `  - \`${scope}\``),
    `- Team role compatible authority roles: ${updatedTeam.compatible_authority_roles.join(', ')}`,
    `- Allowed actuators: ${updatedAuthority.allowed_actuators.join(', ') || '(none)'}`,
    `- Tier access: ${updatedAuthority.tier_access.join(', ') || '(none)'}`,
    ``,
    `This file records the explicit advise-to-act promotion applied by \`pnpm org role promote\`.`,
  ].join('\n');
  safeWriteFile(path.join(roleDir, 'PROMOTION.md'), `${promotionNotes}\n`);
}

function promoteRoleBundle(rootDir: string, input: OrgRolePromoteOptions): Record<string, unknown> {
  const roleId = normalizeRoleId(input.roleId);
  const authorityRoleId = normalizeRoleId(input.authorityRoleId);
  const authorityRoles = loadAuthorityRoleDirectory(rootDir);
  const teamRoles = loadTeamRoleDirectory(rootDir);
  const existingAuthority = authorityRoles[authorityRoleId];
  const existingTeam = teamRoles[roleId];

  if (!existingAuthority) {
    throw new Error(`Authority role not found: ${authorityRoleId}`);
  }
  if (!existingTeam) {
    throw new Error(`Team role not found: ${roleId}`);
  }

  const updatedAuthority: AuthorityRoleRecord = {
    ...existingAuthority,
    description: input.description || existingAuthority.description,
    default_persona: input.persona || existingAuthority.default_persona,
    write_scopes: unique([...(existingAuthority.write_scopes || []), ...input.writeScopes]),
    scope_classes: unique([...(existingAuthority.scope_classes || []), ...input.scopeClasses]),
    allowed_actuators: unique([
      ...(existingAuthority.allowed_actuators || []),
      ...input.allowedActuators,
    ]),
    tier_access: unique([...(existingAuthority.tier_access || []), ...input.tierAccess]),
  };

  const updatedTeam: TeamRoleRecord = {
    ...existingTeam,
    compatible_authority_roles: unique([
      ...(existingTeam.compatible_authority_roles || []),
      authorityRoleId,
    ]),
    selection_hints: existingTeam.selection_hints || {
      preferred_agents: DEFAULT_SELECTION_AGENTS,
      preferred_models: DEFAULT_SELECTION_MODELS,
    },
  };

  authorityRoles[authorityRoleId] = updatedAuthority;
  teamRoles[roleId] = updatedTeam;

  if (!input.dryRun) {
    writeAuthorityRoleBundle(rootDir, authorityRoleId, updatedAuthority);
    syncAuthorityRoleSnapshot(rootDir, authorityRoles);
    writeTeamRoleBundle(rootDir, roleId, updatedTeam);
    syncTeamRoleSnapshot(rootDir, teamRoles);
    upsertRoleAuthorityMap(
      rootDir,
      resolvePromotionRoleAuthorityEntry(roleId, authorityRoleId, input.persona)
    );
    upsertSecurityPolicy(rootDir, authorityRoleId, updatedAuthority);
    upsertRoleWriteAccess(rootDir, authorityRoleId, updatedAuthority.write_scopes);
    writePromotionNotes(rootDir, roleId, authorityRoleId, updatedAuthority, updatedTeam);
  }

  return {
    status: input.dryRun ? 'dry-run' : 'ok',
    root_dir: rootDir,
    role_id: roleId,
    authority_role_id: authorityRoleId,
    persona: input.persona,
    files: {
      authority_role: `knowledge/product/governance/authority-roles/${authorityRoleId}.json`,
      authority_role_index: 'knowledge/product/governance/authority-role-index.json',
      team_role: `knowledge/product/orchestration/team-roles/${roleId}.json`,
      team_role_index: 'knowledge/product/orchestration/team-role-index.json',
      role_authority_map: 'knowledge/product/governance/role-authority-map.json',
      security_policy: 'knowledge/product/governance/security-policy.json',
      promotion_notes: `knowledge/product/roles/${roleId}/PROMOTION.md`,
    },
  };
}

export function createRoleBundle(
  rootDir: string,
  input: OrgRoleCreateOptions
): Record<string, unknown> {
  const teamRoleId = input.teamRoleId || normalizeRoleId(input.name);
  const authorityRoleId = input.authorityRoleId || normalizeRoleId(input.name);
  const persona = resolvePersona(input.persona, resolveDomainTemplate(input.domain).persona);
  const normalizedInput: OrgRoleCreateOptions = {
    ...input,
    teamRoleId,
    authorityRoleId,
    persona,
    requiredCapabilities: unique(input.requiredCapabilities),
    scopeClasses: unique(input.scopeClasses),
    writeScopes: unique(input.writeScopes),
    allowedActuators: unique(input.allowedActuators),
    tierAccess: unique(input.tierAccess),
    allowedDelegateTeamRoles: unique(input.allowedDelegateTeamRoles),
    autonomyLevel: input.autonomyLevel,
    escalationParentTeamRole: input.escalationParentTeamRole ?? null,
  };

  const authorityRole = resolveAuthorityRoleRecord(rootDir, authorityRoleId, normalizedInput);
  const teamRole = resolveTeamRoleRecord(normalizedInput, authorityRoleId);
  const authorityRoles = loadAuthorityRoleDirectory(rootDir);
  const teamRoles = loadTeamRoleDirectory(rootDir);

  authorityRoles[authorityRoleId] = authorityRole;
  teamRoles[teamRoleId] = teamRole;

  if (!normalizedInput.dryRun) {
    writeAuthorityRoleBundle(rootDir, authorityRoleId, authorityRole);
    syncAuthorityRoleSnapshot(rootDir, authorityRoles);
    writeTeamRoleBundle(rootDir, teamRoleId, teamRole);
    syncTeamRoleSnapshot(rootDir, teamRoles);
    upsertRoleAuthorityMap(rootDir, resolveRoleAuthorityEntry(normalizedInput, authorityRoleId));
    upsertSecurityPolicy(rootDir, authorityRoleId, authorityRole);
    upsertRoleWriteAccess(rootDir, authorityRoleId, authorityRole.write_scopes);
    writeRoleDocs(rootDir, normalizedInput, authorityRoleId, teamRole, authorityRole);
  }

  return {
    status: normalizedInput.dryRun ? 'dry-run' : 'ok',
    root_dir: rootDir,
    role_id: teamRoleId,
    authority_role_id: authorityRoleId,
    persona,
    domain: normalizedInput.domain,
    files: {
      authority_role: `knowledge/product/governance/authority-roles/${authorityRoleId}.json`,
      authority_role_index: 'knowledge/product/governance/authority-role-index.json',
      team_role: `knowledge/product/orchestration/team-roles/${teamRoleId}.json`,
      team_role_index: 'knowledge/product/orchestration/team-role-index.json',
      role_authority_map: 'knowledge/product/governance/role-authority-map.json',
      security_policy: 'knowledge/product/governance/security-policy.json',
      procedure: `knowledge/product/roles/${teamRoleId}/PROCEDURE.md`,
      mission: `knowledge/product/roles/${teamRoleId}/mission.md`,
    },
  };
}

function printResult(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = parseArgs(argv);
  if (command.kind === 'help') {
    console.log(helpText());
    return;
  }

  const rootDir = pathResolver.rootDir();
  const result =
    command.kind === 'role-create'
      ? withExecutionContext('ecosystem_architect', () =>
          createRoleBundle(rootDir, {
            name: command.options.name,
            domain: command.options.domain,
            authorityRoleId: normalizeRoleId(
              String(command.options.authorityRoleId || command.options.name)
            ),
            persona: (command.options.persona as Persona) || DEFAULT_PERSONA,
            description: command.options.description,
            ownershipScope: command.options.ownershipScope,
            requiredCapabilities: (command.options.requiredCapabilities as string[]) || [],
            scopeClasses: (command.options.scopeClasses as string[]) || [],
            writeScopes: (command.options.writeScopes as string[]) || [],
            allowedActuators: (command.options.allowedActuators as string[]) || [],
            tierAccess: (command.options.tierAccess as string[]) || [],
            autonomyLevel: (command.options.autonomyLevel as AutonomyLevel) || 'medium',
            escalationParentTeamRole: (command.options.escalationParentTeamRole as string) || null,
            allowedDelegateTeamRoles: (command.options.allowedDelegateTeamRoles as string[]) || [],
            teamRoleId: normalizeRoleId(command.options.name),
            dryRun: Boolean(command.options.dryRun),
          })
        )
      : withExecutionContext('ecosystem_architect', () =>
          promoteRoleBundle(rootDir, {
            roleId: command.options.roleId,
            authorityRoleId: command.options.authorityRoleId,
            persona: (command.options.persona as Persona) || DEFAULT_PERSONA,
            description: command.options.description,
            writeScopes: (command.options.writeScopes as string[]) || [],
            scopeClasses: (command.options.scopeClasses as string[]) || [],
            allowedActuators: (command.options.allowedActuators as string[]) || [],
            tierAccess: (command.options.tierAccess as string[]) || [],
            dryRun: Boolean(command.options.dryRun),
          })
        );
  printResult(result);
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
