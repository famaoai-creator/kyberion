#!/usr/bin/env node
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertApprovalUsable, loadApprovalRequest } from '@agent/core/governance/approval-store';
import {
  loadAuthorityRoleIndex as loadGovernedAuthorityRoleIndex,
  loadTeamRoleIndex as loadGovernedTeamRoleIndex,
} from '@agent/core/mission/mission-team-index';
import { safeExistsSync, safeMkdir, safeReaddir, safeWriteFile } from '@agent/core/secure-io';
import { defineCatalog, nowIso, writeJson, type GovernedCatalog } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/governance';
import {
  loadAuthorityRoleCards,
  loadOrgRoleCards,
  ORG_ROLE_CLASSES,
  projectRoleAuthorityMap,
  type AuthorityRoleCard,
  type OrgRoleCard,
  type OrgRoleClass,
} from '@agent/core/organization/authority-role-registry';
import {
  draftRoleFromIntent,
  loadRoleDraftInventory,
  type ActuatorConnectionProbe,
  type RoleDraftDomainDefaults,
  type RoleIntentDraft,
  type RoleIntentDraftResult,
} from '@agent/core/organization/role-intent-draft';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import { parseCliFlags } from './lib/cli-flag-parser.js';

type Print = (value: unknown) => void;

type BaseRole =
  'sovereign' | 'ecosystem_architect' | 'mission_owner' | 'worker' | 'analyst' | 'unknown';
type AutonomyLevel = 'low' | 'medium' | 'high';

type AuthorityRoleRecord = {
  description: string;
  default_persona?: BaseRole;
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
  persona: BaseRole;
  execution_mode?: string;
  authority_role?: string;
};

type SecurityPolicy = {
  version?: string;
  default_allow?: string[];
  tier_restrictions?: Record<string, unknown>;
  authority_role_permissions?: Record<string, { allow_read?: string[]; allow_write?: string[] }>;
  [key: string]: unknown;
};

type RoleAuthorityMap = {
  version?: string;
  description?: string;
  system_roles?: RoleAuthorityEntry[];
  mission_roles?: RoleAuthorityEntry[];
  context_roles?: RoleAuthorityEntry[];
};

const ROLE_AUTHORITY_MAP_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/role-authority-map.schema.json'
);
const SECURITY_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/security-policy.schema.json'
);

const roleAuthorityMapCatalogs = new Map<string, GovernedCatalog<RoleAuthorityMap>>();
const securityPolicyCatalogs = new Map<string, GovernedCatalog<SecurityPolicy>>();

type OrgRoleCreateOptions = {
  name: string;
  domain: string;
  authorityRoleId: string;
  persona: BaseRole;
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
  approvalId?: string;
  /** CLI only: allow an explicit --team-role-id that names an existing role. */
  update?: boolean;
};

type OrgRolePromoteOptions = {
  roleId: string;
  authorityRoleId: string;
  persona: BaseRole;
  description?: string;
  writeScopes: string[];
  scopeClasses: string[];
  allowedActuators: string[];
  tierAccess: string[];
  dryRun: boolean;
  approvalId?: string;
};

type RoleDraftCliOptions = { intent: string; json: boolean; tenantSlug?: string };

/** Injection points for hermetic tests; production uses the defaults. */
export type OrgMainDeps = { probeActuator?: ActuatorConnectionProbe };

type OrgCommand =
  | {
      kind: 'role-create';
      options: Partial<OrgRoleCreateOptions> & { name: string; domain: string };
    }
  | {
      kind: 'role-promote';
      options: Partial<OrgRolePromoteOptions> & { roleId: string; authorityRoleId: string };
    }
  | { kind: 'role-draft'; options: RoleDraftCliOptions }
  | { kind: 'help' };

const DEFAULT_PERSONA: BaseRole = 'analyst';
const DEFAULT_SELECTION_AGENTS = ['nerve-agent'];
const DEFAULT_SELECTION_MODELS = ['auto-gemini-3'];

const DOMAIN_TEMPLATES: Record<
  string,
  {
    persona: BaseRole;
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
    '  pnpm organization role create --name <display-name> --domain <domain> [--authority <authority-role-id>]',
    '  pnpm organization role promote --role <role-id> --authority <authority-role-id>',
    '  pnpm organization role draft --from-intent "<one sentence>" [--tenant <slug>] [--json]',
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
    '  --approval-id <uuid>          Approved human request required for security-policy writes.',
    '  --dry-run                     Print the planned change set without writing.',
    '  --from-intent <sentence>      (draft) Describe the role in one sentence; prints a draft only.',
    '  --tenant <slug>               (draft) Tenant owning the intent; scopes the reasoning egress check.',
    '  --json                        (draft) Print the draft envelope as JSON.',
    '  --team-role-id <id>           (create) ASCII snake_case team-role id; defaults to the normalized --name.',
    '                                Refused when the id already names an existing role, unless --update.',
    '  --update                      (create) Allow --team-role-id to update an existing role on purpose.',
  ].join('\n');
}

function parseArgs(argv: string[]): OrgCommand {
  const args = [...argv];
  if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' };
  }

  if (args[0] === 'role' && args[1] === 'draft') {
    const draft: { intent?: string; tenantSlug?: string; json: boolean; help: boolean } = {
      json: false,
      help: false,
    };
    const valueOf = (flag: string, value: string | undefined): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value, e.g. ${flag} "<sentence>"`);
      }
      return value;
    };
    parseCliFlags(
      args.slice(2),
      draft,
      [
        {
          flags: ['--from-intent'],
          takesValue: 'next',
          apply: (o, v) => {
            o.intent = valueOf('--from-intent', v);
          },
        },
        {
          flags: ['--tenant'],
          takesValue: 'next',
          apply: (o, v) => {
            o.tenantSlug = valueOf('--tenant', v);
          },
        },
        {
          flags: ['--json'],
          apply: (o) => {
            o.json = true;
          },
        },
        {
          flags: ['--help', '-h'],
          apply: (o) => {
            o.help = true;
          },
        },
      ],
      {
        onUnknown: (o, arg) => {
          if (!o.help) throw new Error(`Unknown option: ${arg}`);
        },
      }
    );
    if (draft.help) return { kind: 'help' };
    if (draft.intent === undefined) throw new Error('--from-intent "<sentence>" is required');
    return {
      kind: 'role-draft',
      options: {
        intent: draft.intent,
        json: draft.json,
        ...(draft.tenantSlug ? { tenantSlug: draft.tenantSlug } : {}),
      },
    };
  }

  if (args[0] !== 'role' || args[1] !== 'create') {
    if (args[0] === 'role' && args[1] === 'promote') {
      const options: Record<string, unknown> = {
        writeScopes: [],
        scopeClasses: [],
        allowedActuators: [],
        tierAccess: [],
      };
      const pushTo = (key: string) => (o: Record<string, unknown>, v: string | undefined) =>
        (o[key] as string[]).push(v as string);
      const setTo = (key: string) => (o: Record<string, unknown>, v: string | undefined) => {
        o[key] = v;
      };
      parseCliFlags(
        args.slice(2),
        options,
        [
          { flags: ['--role'], takesValue: 'next', apply: setTo('roleId') },
          {
            flags: ['--authority', '--authority-role'],
            takesValue: 'next',
            apply: setTo('authorityRoleId'),
          },
          { flags: ['--persona'], takesValue: 'next', apply: setTo('persona') },
          { flags: ['--description'], takesValue: 'next', apply: setTo('description') },
          { flags: ['--write-scope'], takesValue: 'next', apply: pushTo('writeScopes') },
          { flags: ['--scope-class'], takesValue: 'next', apply: pushTo('scopeClasses') },
          { flags: ['--actuator'], takesValue: 'next', apply: pushTo('allowedActuators') },
          { flags: ['--tier'], takesValue: 'next', apply: pushTo('tierAccess') },
          { flags: ['--approval-id'], takesValue: 'next', apply: setTo('approvalId') },
          {
            flags: ['--dry-run'],
            apply: (o) => {
              o.dryRun = true;
            },
          },
          {
            flags: ['--help', '-h'],
            apply: (o) => {
              o.help = true;
            },
          },
        ],
        {
          onUnknown: (o, arg) => {
            if (!o.help) throw new Error(`Unknown option: ${arg}`);
          },
        }
      );
      if (options.help) return { kind: 'help' };

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
    throw new Error('Unsupported command. Use: pnpm organization role create ...');
  }

  const options: Record<string, unknown> = {
    requiredCapabilities: [],
    scopeClasses: [],
    writeScopes: [],
    allowedActuators: [],
    tierAccess: [],
    allowedDelegateTeamRoles: [],
  };
  const pushTo = (key: string) => (o: Record<string, unknown>, v: string | undefined) =>
    (o[key] as string[]).push(v as string);
  const setTo = (key: string) => (o: Record<string, unknown>, v: string | undefined) => {
    o[key] = v;
  };
  const setTrue = (key: string) => (o: Record<string, unknown>) => {
    o[key] = true;
  };
  parseCliFlags(
    args.slice(2),
    options,
    [
      { flags: ['--name'], takesValue: 'next', apply: setTo('name') },
      { flags: ['--domain'], takesValue: 'next', apply: setTo('domain') },
      { flags: ['--team-role-id'], takesValue: 'next', apply: setTo('teamRoleId') },
      { flags: ['--update'], apply: setTrue('update') },
      {
        flags: ['--authority', '--authority-role'],
        takesValue: 'next',
        apply: setTo('authorityRoleId'),
      },
      { flags: ['--persona'], takesValue: 'next', apply: setTo('persona') },
      { flags: ['--description'], takesValue: 'next', apply: setTo('description') },
      { flags: ['--ownership-scope'], takesValue: 'next', apply: setTo('ownershipScope') },
      { flags: ['--autonomy'], takesValue: 'next', apply: setTo('autonomyLevel') },
      {
        flags: ['--parent-team-role'],
        takesValue: 'next',
        apply: setTo('escalationParentTeamRole'),
      },
      { flags: ['--capability'], takesValue: 'next', apply: pushTo('requiredCapabilities') },
      { flags: ['--scope-class'], takesValue: 'next', apply: pushTo('scopeClasses') },
      { flags: ['--write-scope'], takesValue: 'next', apply: pushTo('writeScopes') },
      { flags: ['--actuator'], takesValue: 'next', apply: pushTo('allowedActuators') },
      { flags: ['--tier'], takesValue: 'next', apply: pushTo('tierAccess') },
      { flags: ['--approval-id'], takesValue: 'next', apply: setTo('approvalId') },
      { flags: ['--delegate-role'], takesValue: 'next', apply: pushTo('allowedDelegateTeamRoles') },
      { flags: ['--dry-run'], apply: setTrue('dryRun') },
      { flags: ['--help', '-h'], apply: setTrue('help') },
    ],
    {
      onUnknown: (o, arg) => {
        if (!o.help) throw new Error(`Unknown option: ${arg}`);
      },
    }
  );
  if (options.help) return { kind: 'help' };

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

function roleAuthorityMapCatalog(filePath: string): GovernedCatalog<RoleAuthorityMap> {
  const existing = roleAuthorityMapCatalogs.get(filePath);
  if (existing) return existing;
  const catalog = defineCatalog<RoleAuthorityMap>({
    id: 'role-authority-map',
    path: filePath,
    schema: ROLE_AUTHORITY_MAP_SCHEMA_PATH,
    fallback: () => ({
      version: '1.0.0',
      description: 'Maps knowledge roles to execution mode, persona, and authority_role.',
      system_roles: [],
      mission_roles: [],
      context_roles: [],
    }),
  });
  roleAuthorityMapCatalogs.set(filePath, catalog);
  return catalog;
}

function securityPolicyCatalog(filePath: string): GovernedCatalog<SecurityPolicy> {
  const existing = securityPolicyCatalogs.get(filePath);
  if (existing) return existing;
  const catalog = defineCatalog<SecurityPolicy>({
    id: 'security-policy',
    path: filePath,
    schema: SECURITY_POLICY_SCHEMA_PATH,
  });
  securityPolicyCatalogs.set(filePath, catalog);
  return catalog;
}

function resetOrgCatalog(filePath: string): void {
  roleAuthorityMapCatalogs.get(filePath)?.reset();
  securityPolicyCatalogs.get(filePath)?.reset();
}

function resolveDomainTemplate(domain: string) {
  return DOMAIN_TEMPLATES[domain.toLowerCase()] || DOMAIN_TEMPLATES.default;
}

function resolvePersona(inputPersona: string | undefined, fallback: BaseRole): BaseRole {
  if (!inputPersona) return fallback;
  const normalized = inputPersona.trim().toLowerCase().replace(/\s+/g, '_') as BaseRole;
  const allowed: BaseRole[] = [
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
  const existing = loadAuthorityRoleDirectory(rootDir)[authorityRoleId];
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
  persona: BaseRole
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
last_updated: ${nowIso().slice(0, 10)}
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
- **Default BaseRole**: \`${authorityRole.default_persona || DEFAULT_PERSONA}\`
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
last_updated: ${nowIso().slice(0, 10)}
---

# ${toTitleCase(input.name)} Mission Statement

## 1. Purpose
Deliver governed ${input.domain} outcomes with the minimum authority required.

## 2. Authority Boundaries
- Runtime authority role: \`${authorityRoleId}\`
- Role identity: \`${input.teamRoleId}\`
- BaseRole: \`${input.persona}\`

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
  const hasDirectoryEntries =
    safeExistsSync(directory) && safeReaddir(directory).some((entry) => entry.endsWith('.json'));
  if (!hasDirectoryEntries && !safeExistsSync(snapshot)) return {};
  return loadGovernedAuthorityRoleIndex(rootDir);
}

/**
 * Every role id that any store `role create` writes already holds: team and
 * authority roles, the role-authority map (role and authority_role values),
 * security-policy authority permissions and store grants, and role docs.
 * A new role must not take one of these ids — the create would merge into
 * or overwrite that role's records.
 */
export function collectExistingRoleIds(rootDir: string): Set<string> {
  const ids = new Set<string>([
    ...Object.keys(loadTeamRoleDirectory(rootDir)),
    ...Object.keys(loadAuthorityRoleDirectory(rootDir)),
  ]);
  const map = loadRoleAuthorityMap(rootDir);
  for (const bucket of ['system_roles', 'mission_roles', 'context_roles'] as const) {
    for (const entry of map[bucket] || []) {
      if (entry.role) ids.add(entry.role);
      if (entry.authority_role) ids.add(entry.authority_role);
    }
  }
  const policy = loadSecurityPolicy(rootDir);
  for (const role of Object.keys(policy.authority_role_permissions || {})) {
    ids.add(role);
  }
  // S4: a declared store grant's name is never taken by a new role.
  const storeGrants = policy.store_grants;
  if (storeGrants && typeof storeGrants === 'object' && !Array.isArray(storeGrants))
    for (const name of Object.keys(storeGrants)) ids.add(name);
  const docsDir = path.join(rootDir, 'knowledge', 'product', 'roles');
  if (safeExistsSync(docsDir)) {
    for (const entry of safeReaddir(docsDir)) {
      if (!entry.startsWith('.')) ids.add(entry);
    }
  }
  return ids;
}

function existingAuthorityRoleCard(rootDir: string, roleId: string): AuthorityRoleCard | undefined {
  const directory = path.join(rootDir, 'knowledge', 'product', 'governance', 'authority-roles');
  const hasDirectoryEntries =
    safeExistsSync(directory) && safeReaddir(directory).some((entry) => entry.endsWith('.json'));
  return hasDirectoryEntries ? (loadAuthorityRoleCards(rootDir) ?? {})[roleId] : undefined;
}

/**
 * Writes the role's card in the one Authority Role registry (concept model
 * v2 D6). The card's `permissions` are kept: they change only through
 * {@link upsertSecurityPolicy}. Writing a profile makes a process role
 * assignable, as creating its card did before the registries merged; both
 * callers run behind the authenticated human approval.
 */
function writeAuthorityRoleBundle(
  rootDir: string,
  roleId: string,
  record: AuthorityRoleRecord
): void {
  const existing = existingAuthorityRoleCard(rootDir, roleId);
  const directory = path.join(rootDir, 'knowledge', 'product', 'governance', 'authority-roles');
  safeMkdir(directory, { recursive: true });
  writeJson(path.join(directory, `${roleId}.json`), {
    role: roleId,
    ...record,
    ...(existing?.permissions ? { permissions: existing.permissions } : {}),
  });
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
  const hasDirectoryEntries =
    safeExistsSync(directory) && safeReaddir(directory).some((entry) => entry.endsWith('.json'));
  if (!hasDirectoryEntries && !safeExistsSync(snapshot)) return {};
  return loadGovernedTeamRoleIndex(rootDir);
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

function loadRoleAuthorityMap(rootDir: string): RoleAuthorityMap {
  const filePath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'role-authority-map.json'
  );
  return roleAuthorityMapCatalog(filePath).load();
}

function orgRoleCardOf(entry: RoleAuthorityEntry, roleClass: OrgRoleClass): OrgRoleCard {
  return {
    role: entry.role,
    role_class: roleClass,
    default_grant: {
      authority_role: entry.authority_role ?? null,
      base_role: entry.persona,
      execution_mode: entry.execution_mode ?? 'mission',
    },
  };
}

/**
 * Writes the Org Role card's default grant (concept model v2 D6: the card only
 * points at registry entries) and its role-authority-map.json projection
 * together, so the `org-role-grants` drift gate stays green. A role keeps its
 * card's role class (new roles are context roles); map entries without a card
 * (an installation that predates the cards) are kept as they are.
 */
function upsertOrgRoleDefaultGrant(rootDir: string, entry: RoleAuthorityEntry): void {
  const filePath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'role-authority-map.json'
  );
  const map = loadRoleAuthorityMap(rootDir);
  const cards: Record<string, OrgRoleCard> = {};
  const order: Partial<Record<`${OrgRoleClass}_roles`, string[]>> = {};
  for (const roleClass of ORG_ROLE_CLASSES) {
    const entries = map[`${roleClass}_roles`] || [];
    order[`${roleClass}_roles`] = entries.map((existing) => existing.role);
    for (const existing of entries) cards[existing.role] = orgRoleCardOf(existing, roleClass);
  }
  Object.assign(cards, loadOrgRoleCards(rootDir));
  const card = orgRoleCardOf(entry, cards[entry.role]?.role_class ?? 'context');
  cards[entry.role] = card;
  const roleDir = path.join(rootDir, 'knowledge', 'product', 'roles', entry.role);
  safeMkdir(roleDir, { recursive: true });
  writeJson(path.join(roleDir, 'role.json'), {
    $schema: '../../schemas/org-role-card.schema.json',
    ...card,
  });
  writeJson(filePath, { ...map, ...projectRoleAuthorityMap(cards, order) });
  resetOrgCatalog(filePath);
}

function loadSecurityPolicy(rootDir: string): SecurityPolicy {
  const filePath = path.join(rootDir, 'knowledge', 'product', 'governance', 'security-policy.json');
  return securityPolicyCatalog(filePath).load();
}

function assertSecurityPolicyApproval(approvalId?: string): void {
  if (!approvalId) {
    throw new Error(
      '[POLICY_VIOLATION] Direct security-policy writes require --approval-id for an approved human request.'
    );
  }
  const approval = loadApprovalRequest('terminal', approvalId);
  const requestedEffects = approval?.justification?.requestedEffects || [];
  const humanApproval = approval?.workflow?.approvals?.some(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (
    !approval ||
    !['approved', 'applied'].includes(approval.status) ||
    approval.accountability?.finalDecision !== 'human_only' ||
    !humanApproval ||
    !requestedEffects.some((effect) =>
      effect.includes('knowledge/product/governance/security-policy.json')
    )
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Approval '${approvalId}' is not an authenticated human approval bound to security-policy.json.`
    );
  }
  assertApprovalUsable(approval, { consumer: 'org_security_policy_write' });
}

function upsertSecurityPolicy(
  rootDir: string,
  authorityRoleId: string,
  record: AuthorityRoleRecord,
  approvalId?: string
): void {
  assertSecurityPolicyApproval(approvalId);
  const filePath = path.join(rootDir, 'knowledge', 'product', 'governance', 'security-policy.json');
  const policy = loadSecurityPolicy(rootDir);
  const permissions = {
    allow_read: [...record.write_scopes],
    allow_write: [...record.write_scopes],
  };
  // The card is the registry; security-policy.json carries its generated
  // projection. Both are written here so the drift gate stays green.
  const cardPath = path.join(
    rootDir,
    'knowledge',
    'product',
    'governance',
    'authority-roles',
    `${authorityRoleId}.json`
  );
  const card = existingAuthorityRoleCard(rootDir, authorityRoleId) ?? {
    role: authorityRoleId,
    ...record,
  };
  writeJson(cardPath, { ...card, permissions });
  policy.authority_role_permissions = policy.authority_role_permissions || {};
  policy.authority_role_permissions[authorityRoleId] = permissions;
  writeJson(filePath, policy);
  resetOrgCatalog(filePath);
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
    `This file records the explicit advise-to-act promotion applied by \`pnpm organization role promote\`.`,
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
    assertSecurityPolicyApproval(input.approvalId);
    writeAuthorityRoleBundle(rootDir, authorityRoleId, updatedAuthority);
    syncAuthorityRoleSnapshot(rootDir, authorityRoles);
    writeTeamRoleBundle(rootDir, roleId, updatedTeam);
    syncTeamRoleSnapshot(rootDir, teamRoles);
    upsertOrgRoleDefaultGrant(
      rootDir,
      resolvePromotionRoleAuthorityEntry(roleId, authorityRoleId, input.persona)
    );
    upsertSecurityPolicy(rootDir, authorityRoleId, updatedAuthority, input.approvalId);
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
      org_role_card: `knowledge/product/roles/${roleId}/role.json`,
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
    assertSecurityPolicyApproval(normalizedInput.approvalId);
    writeAuthorityRoleBundle(rootDir, authorityRoleId, authorityRole);
    syncAuthorityRoleSnapshot(rootDir, authorityRoles);
    writeTeamRoleBundle(rootDir, teamRoleId, teamRole);
    syncTeamRoleSnapshot(rootDir, teamRoles);
    upsertOrgRoleDefaultGrant(rootDir, resolveRoleAuthorityEntry(normalizedInput, authorityRoleId));
    upsertSecurityPolicy(rootDir, authorityRoleId, authorityRole, normalizedInput.approvalId);
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
      org_role_card: `knowledge/product/roles/${teamRoleId}/role.json`,
      role_authority_map: 'knowledge/product/governance/role-authority-map.json',
      security_policy: 'knowledge/product/governance/security-policy.json',
      procedure: `knowledge/product/roles/${teamRoleId}/PROCEDURE.md`,
      mission: `knowledge/product/roles/${teamRoleId}/mission.md`,
    },
  };
}

function printResult(result: Record<string, unknown>, print: Print): void {
  print(JSON.stringify(result, null, 2));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The governed `role create` argv that commits a draft; the draft itself writes nothing. */
export function roleCreateArgsFromDraft(draft: RoleIntentDraft): string[] {
  // Ids are explicit so a confirm never re-derives them from the display
  // name: the draft reserved this id against every existing team AND
  // authority role, and `role create` would merge into an existing one.
  const args = ['--name', draft.name, '--team-role-id', draft.team_role_id];
  args.push('--authority', draft.team_role_id, '--domain', draft.domain);
  args.push('--persona', draft.persona);
  args.push('--autonomy', draft.autonomy_level, '--description', draft.description);
  if (draft.ownership_scope) args.push('--ownership-scope', draft.ownership_scope);
  for (const value of draft.required_capabilities) args.push('--capability', value);
  for (const value of draft.scope_classes) args.push('--scope-class', value);
  for (const value of draft.allowed_actuators) args.push('--actuator', value);
  for (const value of draft.tier_access) args.push('--tier', value);
  if (draft.escalation_parent_team_role) {
    args.push('--parent-team-role', draft.escalation_parent_team_role);
  }
  for (const value of draft.allowed_delegate_team_roles) args.push('--delegate-role', value);
  return args;
}

function roleDraftNextCommands(draft: RoleIntentDraft): { preview: string; commit: string } {
  const base = ['pnpm', 'organization', 'role', 'create', ...roleCreateArgsFromDraft(draft)]
    .map(shellQuote)
    .join(' ');
  return {
    preview: `${base} --dry-run`,
    commit: `${base} --approval-id <approved-request-id>`,
  };
}

function roleDraftDomainDefaults(): Record<string, RoleDraftDomainDefaults> {
  return Object.fromEntries(
    Object.entries(DOMAIN_TEMPLATES).map(([domain, template]) => [
      domain,
      {
        persona: (['analyst', 'worker', 'mission_owner'].includes(template.persona)
          ? template.persona
          : 'analyst') as RoleDraftDomainDefaults['persona'],
        autonomy_level: template.autonomyLevel,
        escalation_parent_team_role: template.escalationParentTeamRole,
      },
    ])
  );
}

function draftCreateOptions(draft: RoleIntentDraft): OrgRoleCreateOptions {
  return {
    name: draft.name,
    domain: draft.domain,
    authorityRoleId: draft.team_role_id,
    persona: draft.persona,
    description: draft.description,
    ownershipScope: draft.ownership_scope,
    requiredCapabilities: unique(draft.required_capabilities),
    scopeClasses: unique(draft.scope_classes),
    writeScopes: [],
    allowedActuators: unique(draft.allowed_actuators),
    tierAccess: unique(draft.tier_access),
    autonomyLevel: draft.autonomy_level,
    escalationParentTeamRole: draft.escalation_parent_team_role ?? null,
    allowedDelegateTeamRoles: unique(draft.allowed_delegate_team_roles),
    teamRoleId: draft.team_role_id,
    dryRun: true,
  };
}

/**
 * What confirming would actually grant: `role create` unions the domain
 * template into the drafted values, so show the merged records computed by
 * the same resolvers `role create` uses (read-only).
 */
export function effectiveRoleGrantFromDraft(draft: RoleIntentDraft) {
  const options = draftCreateOptions(draft);
  const authority = resolveAuthorityRoleRecord(pathResolver.rootDir(), draft.team_role_id, options);
  const team = resolveTeamRoleRecord(options, draft.team_role_id);
  return {
    team_role_id: draft.team_role_id,
    authority_role_id: draft.team_role_id,
    required_capabilities: team.required_capabilities,
    team_scope_classes: team.required_scope_classes,
    authority_scope_classes: authority.scope_classes,
    allowed_actuators: authority.allowed_actuators,
    tier_access: authority.tier_access,
    write_scopes: authority.write_scopes,
    escalation_parent_team_role: team.escalation_parent_team_role,
    allowed_delegate_team_roles: team.allowed_delegate_team_roles,
  };
}

function renderRoleDraft(result: RoleIntentDraftResult): string {
  if (result.status === 'failed') {
    return [
      `Role draft failed (${result.failure.class}): ${result.failure.message}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
      `next: ${result.failure.next}`,
    ].join('\n');
  }
  const { draft } = result;
  const list = (values: string[]) => (values.length ? values.join(', ') : '(none)');
  const next = roleDraftNextCommands(draft);
  const grant = effectiveRoleGrantFromDraft(draft);
  const lines = [
    `Role draft ${result.draft_id} (not created — draft only)`,
    `  name:          ${draft.name} (team role id: ${draft.team_role_id})`,
    `  domain:        ${draft.domain}`,
    `  persona:       ${draft.persona}`,
    `  autonomy:      ${draft.autonomy_level}`,
    `  description:   ${draft.description}`,
    ...(draft.ownership_scope ? [`  ownership:     ${draft.ownership_scope}`] : []),
    `  capabilities:  ${list(draft.required_capabilities)}`,
    `  scope classes: ${list(draft.scope_classes)}`,
    `  actuators:     ${list(draft.allowed_actuators)}`,
    `  tiers:         ${list(draft.tier_access)}`,
    ...(draft.escalation_parent_team_role
      ? [`  escalates to:  ${draft.escalation_parent_team_role}`]
      : []),
    `  delegates to:  ${list(draft.allowed_delegate_team_roles)}`,
    '',
    `Effective grant on confirm (drafted values + ${draft.domain} domain template defaults):`,
    `  capabilities:  ${list(grant.required_capabilities)}`,
    `  scope classes: ${list(grant.authority_scope_classes)} (team requires: ${list(grant.team_scope_classes)})`,
    `  actuators:     ${list(grant.allowed_actuators)}`,
    `  tiers:         ${list(grant.tier_access)}`,
    `  write scopes:  ${list(grant.write_scopes)}`,
    `  escalates to:  ${grant.escalation_parent_team_role ?? '(none)'}`,
    `  delegates to:  ${list(grant.allowed_delegate_team_roles)}`,
    '',
    `Dropped (not in the governed inventory): ${
      result.dropped.length
        ? result.dropped
            .map((entry) => `${entry.field}=${entry.value} (${entry.reason})`)
            .join('; ')
        : '(none)'
    }`,
    ...(result.fallbacks.length
      ? [
          `Fallbacks: ${result.fallbacks
            .map((entry) => `${entry.field}: ${entry.rejected} -> ${entry.used}`)
            .join('; ')}`,
        ]
      : []),
    `Missing connections: ${
      result.missing_connections.length
        ? result.missing_connections
            .map(
              (entry) =>
                `${entry.actuator}${entry.prerequisites.length ? ` (needs ${entry.prerequisites.join(', ')})` : ''}`
            )
            .join('; ')
        : '(none)'
    }`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
    '',
    'Next — preview, then commit with an approved security-policy request:',
    `  ${next.preview}`,
    `  ${next.commit}`,
  ];
  return lines.join('\n');
}

async function runRoleDraft(
  options: RoleDraftCliOptions,
  print: Print,
  deps: OrgMainDeps
): Promise<void> {
  const inventory = loadRoleDraftInventory({
    domains: roleDraftDomainDefaults(),
    defaultDomain: 'default',
    reservedRoleIds: collectExistingRoleIds(pathResolver.rootDir()),
  });
  const result = await draftRoleFromIntent({
    intent: options.intent,
    inventory,
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
    ...(deps.probeActuator ? { probeActuator: deps.probeActuator } : {}),
  });
  if (options.json) {
    print(
      JSON.stringify(
        result.status === 'drafted'
          ? {
              ...result,
              effective_grant: effectiveRoleGrantFromDraft(result.draft),
              next_commands: roleDraftNextCommands(result.draft),
            }
          : result,
        null,
        2
      )
    );
  } else {
    print(renderRoleDraft(result));
  }
  // Failure is still a printed result; the exit code carries it to shells.
  if (result.status === 'failed') throw new ScriptExitError(1);
}

export async function main(
  argv = currentProcessArgv().slice(2),
  print: Print = () => undefined,
  deps: OrgMainDeps = {}
): Promise<void> {
  const command = parseArgs(argv);
  if (command.kind === 'help') {
    print(helpText());
    return;
  }
  if (command.kind === 'role-draft') {
    await runRoleDraft(command.options, print, deps);
    return;
  }

  const rootDir = pathResolver.rootDir();
  if (command.kind === 'role-create' && command.options.teamRoleId && !command.options.update) {
    const explicitId = normalizeRoleId(String(command.options.teamRoleId));
    if (collectExistingRoleIds(rootDir).has(explicitId)) {
      throw new Error(
        `--team-role-id '${explicitId}' already names an existing role; creating it would merge into or overwrite that role's records — choose a free id, or pass --update to change that role on purpose`
      );
    }
  }
  const result =
    command.kind === 'role-create'
      ? withExecutionContext('ecosystem_architect', () =>
          createRoleBundle(rootDir, {
            name: command.options.name,
            domain: command.options.domain,
            authorityRoleId: normalizeRoleId(
              String(command.options.authorityRoleId || command.options.name)
            ),
            persona: (command.options.persona as BaseRole) || DEFAULT_PERSONA,
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
            teamRoleId: normalizeRoleId(String(command.options.teamRoleId || command.options.name)),
            dryRun: Boolean(command.options.dryRun),
            approvalId: command.options.approvalId as string | undefined,
          })
        )
      : withExecutionContext('ecosystem_architect', () =>
          promoteRoleBundle(rootDir, {
            roleId: command.options.roleId,
            authorityRoleId: command.options.authorityRoleId,
            persona: (command.options.persona as BaseRole) || DEFAULT_PERSONA,
            description: command.options.description,
            writeScopes: (command.options.writeScopes as string[]) || [],
            scopeClasses: (command.options.scopeClasses as string[]) || [],
            allowedActuators: (command.options.allowedActuators as string[]) || [],
            tierAccess: (command.options.tierAccess as string[]) || [],
            dryRun: Boolean(command.options.dryRun),
            approvalId: command.options.approvalId as string | undefined,
          })
        );
  printResult(result, print);
}

export const runOrg = defineScript({
  name: 'organization:org',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (isDirectScript(import.meta.url, 'org.ts') || isDirectScript(import.meta.url, 'org.js'))
  void runOrg();
