/**
 * S4 slice 3: every former store-only Authority Role keeps its exact
 * (principal, path, operation) decisions after it became a declared store
 * grant. The "before" matrix was recorded while each name was still an
 * assumable role (tests/fixtures/store-grant-equivalence.json); a name that is
 * still a role is compared against it too, so the fixture cannot drift.
 */
import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// Disclosure grants record to the audit chain; keep the suite hermetic.
const auditRecord = vi.hoisted(() => vi.fn());
vi.mock('../governance/audit-chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../governance/audit-chain.js')>();
  return {
    ...actual,
    auditChain: {
      ...actual.auditChain,
      record: auditRecord,
      recordDurable: auditRecord,
      recordDeferrable: vi.fn(),
    },
  };
});

import { resolveExecutionPersona, withExecutionContext, withStoreGrant } from '../authority.js';
import {
  DECLARED_STORE_GRANTS,
  isDeclaredStoreGrantName,
} from '../foundation/declared-store-grant.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile } from '../secure-io.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import type { ResourceAccessScope } from '../foundation/resource-access-scope.js';

// ---- the matrix (per role: callers x paths x operations) ----

const MATRIX_TENANT = 'acme-corp';
const MATRIX_OTHER_TENANT = 'other-corp';
const MATRIX_ORG = 'org-a';
const MATRIX_OPERATIONS = ['read', 'metadata', 'write', 'append', 'mkdir'] as const;
type MatrixOperation = (typeof MATRIX_OPERATIONS)[number];

/** How a call site entered the role (the binding the store grant must reproduce). */
interface StoreGrantMatrixSpec {
  name: string;
  /** Tenant the call site binds: the matrix tenant, an explicit system scope (''), or none. */
  bind: 'tenant' | 'system' | 'none';
  /** Explicit persona the call site passed (undefined: inferred from the role). */
  persona?: 'worker';
  organization?: boolean;
  /** Resource ceiling the call site runs the role inside. */
  ceiling?: () => ResourceAccessScope;
}

const archivedState = `active/archive/missions/confidential/${MATRIX_TENANT}/MSN-ARCHIVED-1/mission-state.json`;

const STORE_GRANT_MATRIX_SPECS: readonly StoreGrantMatrixSpec[] = [
  { name: 'ops_alert_store', bind: 'none', persona: 'worker' },
  { name: 'operational_learning_writer', bind: 'tenant', organization: true },
  { name: 'chronos_token_registry_reader', bind: 'none' },
  { name: 'workspace_graph_reader', bind: 'system' },
  { name: 'scope_locale_reader', bind: 'tenant' },
  { name: 'peer_catalog_reader', bind: 'tenant' },
  { name: 'peer_responder_reader', bind: 'tenant' },
  { name: 'peer_task_artifact_writer', bind: 'tenant' },
  { name: 'metrics_cap_reader', bind: 'none' },
  { name: 'nhi_accountability_reader', bind: 'none' },
  { name: 'audit_mirror_writer', bind: 'tenant' },
  { name: 'tenant_ledger_store', bind: 'tenant' },
  { name: 'delegation_record_store', bind: 'tenant' },
  { name: 'tenant_approval_store', bind: 'tenant' },
  { name: 'tenant_approval_partition_index_reader', bind: 'none' },
  { name: 'credential_allocation_reader', bind: 'tenant' },
  {
    name: 'concierge_management_reader',
    bind: 'tenant',
    ceiling: () => ({
      tenantSlug: MATRIX_TENANT,
      readExact: [
        `knowledge/personal/tenants/${MATRIX_TENANT}.json`,
        `active/projects/confidential/${MATRIX_TENANT}/prj-a/project.json`,
      ],
      writeExact: [],
      mkdirExact: [],
    }),
  },
  {
    name: 'concierge_management_writer',
    bind: 'tenant',
    organization: true,
    ceiling: () => ({
      tenantSlug: MATRIX_TENANT,
      organizationId: MATRIX_ORG,
      readExact: [`knowledge/personal/tenants/${MATRIX_TENANT}.json`],
      writeExact: [`active/projects/confidential/${MATRIX_TENANT}/prj-a/project.json`],
      mkdirExact: [`active/projects/confidential/${MATRIX_TENANT}/prj-a`],
    }),
  },
  { name: 'first_job_tenant_status_reader', bind: 'tenant' },
  { name: 'reasoning_settings_writer', bind: 'none' },
  { name: 'customer_decision_deal_note_writer', bind: 'tenant', persona: 'worker' },
  { name: 'notification_preferences_reader', bind: 'none' },
  { name: 'tool_runtime_policy_reader', bind: 'none' },
  { name: 'workspace_tenant_registry_reader', bind: 'tenant', persona: 'worker' },
  { name: 'workspace_tenant_registry_index_reader', bind: 'none' },
  { name: 'deliverable_inbox_writer', bind: 'none' },
  {
    name: 'archived_mission_state_reader',
    bind: 'tenant',
    ceiling: () => ({
      tenantSlug: MATRIX_TENANT,
      readExact: [archivedState],
      writeExact: [],
      mkdirExact: [],
      allowProductKnowledgeRead: true,
    }),
  },
  { name: 'customer_channel_binding_store', bind: 'tenant' },
  { name: 'dot_charter_store', bind: 'tenant', organization: true },
  { name: 'dot_lifecycle_runtime_store', bind: 'tenant' },
];

/** Paths that no store-only role covers, probed for every role. */
const OUTSIDERS = [
  `knowledge/confidential/${MATRIX_TENANT}/notes/handbook.md`,
  `knowledge/confidential/${MATRIX_OTHER_TENANT}/notes/handbook.md`,
  `knowledge/confidential/${MATRIX_TENANT}/connections/peer-network.json`,
  'knowledge/personal/my-identity.json',
  'knowledge/personal/connections/github.json',
  'knowledge/public/index.md',
  'knowledge/product/governance/security-policy.json',
  'libs/core/index.ts',
  'active/shared/runtime/state/other.json',
  'active/shared/tmp/scratch.txt',
  `active/shared/runtime/audit-mirror/confidential/${MATRIX_OTHER_TENANT}/audit.jsonl`,
  'active/missions/MSN-OTHER/mission-state.json',
  '.env.local',
];

function expand(pattern: string, tenant: string, organization: string): string {
  return pattern
    .replace(/\$\{KYBERION_TENANT\}/gu, tenant)
    .replace(/\$\{KYBERION_ORGANIZATION_ID\}/gu, organization)
    .replace(/\$\{KYBERION_PROJECT_ID\}/gu, 'prj-a')
    .replace(/\$\{KYBERION_STANCE\}/gu, 'stance-a')
    .replace(/\$\{MISSION_ID\}/gu, 'MSN-MATRIX-1');
}

/** The probed paths of a role: its own grants (own and other tenant), their ancestors, outsiders. */
function matrixPaths(rules: { allow_read?: string[]; allow_write?: string[] }): string[] {
  const out = new Set<string>();
  const patterns = [...(rules.allow_read ?? []), ...(rules.allow_write ?? [])];
  for (const pattern of patterns) {
    for (const [tenant, organization] of [
      [MATRIX_TENANT, MATRIX_ORG],
      [MATRIX_OTHER_TENANT, 'org-b'],
    ] as const) {
      const expanded = expand(pattern, tenant, organization);
      if (expanded.endsWith('/')) {
        const dir = expanded.slice(0, -1);
        out.add(dir);
        out.add(`${dir}/child.json`);
        out.add(`${dir}/nested/deep.jsonl`);
      } else {
        out.add(expanded);
        out.add(`${expanded}.bak`);
      }
      const parent = path.posix.dirname(expanded.replace(/\/$/u, ''));
      if (parent && parent !== '.') out.add(parent);
    }
  }
  for (const outsider of OUTSIDERS) out.add(outsider);
  return [...out].sort();
}

/** The caller contexts each matrix is probed from. */
const MATRIX_CALLERS = [
  'plain',
  'active-tenant',
  'other-tenant',
  'listed-system-role',
  'unlisted-system-role',
  'env-run',
] as const;
type MatrixCaller = (typeof MATRIX_CALLERS)[number];

const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_BASE_ROLE',
  'KYBERION_ORGANIZATION_ID',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_DELEGATED_ROLE',
] as const;

function withCallerEnv<T>(spec: StoreGrantMatrixSpec, caller: MatrixCaller, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  if (caller === 'active-tenant') process.env.KYBERION_TENANT = MATRIX_TENANT;
  if (caller === 'other-tenant') process.env.KYBERION_TENANT = MATRIX_OTHER_TENANT;
  // chronos_mirror_v2 lists no may_assume role (shared core roles only); a
  // SYSTEM_ROLE without a policy entry may assume nothing but itself.
  if (caller === 'listed-system-role') process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
  if (caller === 'unlisted-system-role') process.env.SYSTEM_ROLE = 'matrix_unlisted_surface';
  if (caller === 'env-run') {
    process.env.MISSION_ROLE = spec.name;
    process.env.KYBERION_TENANT = MATRIX_TENANT;
    if (spec.organization) process.env.KYBERION_ORGANIZATION_ID = MATRIX_ORG;
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function code(reason: string | undefined): string {
  return reason?.match(/\[([A-Z][A-Z0-9_]+)\]/u)?.[1] ?? 'POLICY';
}

function decide(relative: string, operation: MatrixOperation): string {
  const absolute = path.join(pathResolver.rootDir(), relative);
  const decision =
    operation === 'read' || operation === 'metadata'
      ? validateReadPermission(absolute, operation)
      : validateWritePermission(absolute, operation);
  return decision.allowed ? 'A' : `D:${code(decision.reason)}`;
}

/** Opens the role (or the store grant that replaced it) the way its call site does. */
type StoreGrantEntry = (
  spec: StoreGrantMatrixSpec,
  binding: { tenantSlug?: string; organizationId?: string },
  fn: () => string[]
) => string[];

/** One caller's row: per path, the five operation verdicts joined by `|`. */
function matrixRow(
  spec: StoreGrantMatrixSpec,
  caller: MatrixCaller,
  paths: readonly string[],
  enter: StoreGrantEntry
): string[] {
  const evaluate = () =>
    paths.map((relative) => MATRIX_OPERATIONS.map((op) => decide(relative, op)).join('|'));
  return withCallerEnv(spec, caller, () => {
    if (caller === 'env-run') return evaluate();
    const binding = {
      ...(spec.bind === 'tenant' ? { tenantSlug: MATRIX_TENANT } : {}),
      ...(spec.bind === 'system' ? { tenantSlug: '' } : {}),
      ...(spec.organization ? { organizationId: MATRIX_ORG } : {}),
    };
    try {
      const run = () => enter(spec, binding, evaluate);
      return spec.ceiling ? runInResourceAccessScope(spec.ceiling(), run) : run();
    } catch (error) {
      const verdict = `THROW:${code(error instanceof Error ? error.message : String(error))}`;
      return paths.map(() => verdict);
    }
  });
}

// ---- the comparison ----

interface RoleMatrix {
  rules: Record<string, unknown>;
  persona: string | null;
  paths: string[];
  callers: Record<MatrixCaller, string[]>;
  /** Intentional per-role differences: the caller's whole row becomes `verdict`. */
  intentional: { caller: MatrixCaller; verdict: string; why: string }[];
}

const ROOT = pathResolver.rootDir();
const fixture = JSON.parse(
  safeReadFile(path.join(ROOT, 'tests/fixtures/store-grant-equivalence.json'), {
    encoding: 'utf8',
  }) as string
) as { roles: Record<string, RoleMatrix> };
const policy = JSON.parse(
  safeReadFile(path.join(ROOT, 'knowledge/product/governance/security-policy.json'), {
    encoding: 'utf8',
  }) as string
);

/**
 * The one intentional difference every declared store grant has: a process
 * that runs AS the former role name through env (MISSION_ROLE / SYSTEM_ROLE)
 * held the role's permissions; it now holds none (fail closed). The grant
 * exists only inside the scope its facade opens.
 */
const ENV_RUN_VERDICT = 'D:STORE_GRANT_REQUIRED';

/** A whole row of one verdict: five operation verdicts per path, or one THROW per path. */
function uniformRow(matrix: RoleMatrix, verdict: string): string[] {
  const cell = verdict.startsWith('THROW:')
    ? verdict
    : MATRIX_OPERATIONS.map(() => verdict).join('|');
  return matrix.paths.map(() => cell);
}

function expectedRow(name: string, matrix: RoleMatrix, caller: MatrixCaller): string[] {
  const special = matrix.intentional.find((entry) => entry.caller === caller);
  if (special) return uniformRow(matrix, special.verdict);
  if (isDeclaredStoreGrantName(name) && caller === 'env-run')
    return uniformRow(matrix, ENV_RUN_VERDICT);
  return matrix.callers[caller];
}

describe('store-only roles → declared store grants (S4 slice 3)', () => {
  it('covers every former store-only role exactly once', () => {
    expect(STORE_GRANT_MATRIX_SPECS.map((spec) => spec.name).sort()).toEqual(
      Object.keys(fixture.roles).sort()
    );
    for (const name of Object.keys(DECLARED_STORE_GRANTS))
      expect(Object.keys(fixture.roles), name).toContain(name);
  });

  for (const spec of STORE_GRANT_MATRIX_SPECS) {
    const matrix = fixture.roles[spec.name]!;
    const declared = isDeclaredStoreGrantName(spec.name);

    describe(`${spec.name} (${declared ? 'store grant' : 'still a role'})`, () => {
      it('declares the same operations it had as a role', () => {
        if (declared) {
          expect(policy.authority_role_permissions[spec.name]).toBeUndefined();
          const { description, ...rules } = policy.store_grants?.[spec.name] ?? {};
          expect(typeof description).toBe('string');
          expect(rules).toEqual(matrix.rules);
          expect(
            safeExistsSync(
              path.join(ROOT, `knowledge/product/governance/authority-roles/${spec.name}.json`)
            )
          ).toBe(false);
        } else {
          expect(policy.authority_role_permissions[spec.name]).toEqual(matrix.rules);
        }
      });

      for (const caller of MATRIX_CALLERS) {
        it(`decides identically for caller '${caller}'`, () => {
          let persona: string | undefined | null = null;
          const row = matrixRow(spec, caller, matrix.paths, (entered, binding, fn) => {
            const run = () => {
              persona = resolveExecutionPersona();
              return fn();
            };
            return declared
              ? withStoreGrant(entered.name, run, binding)
              : withExecutionContext(
                  entered.name,
                  run,
                  entered.persona,
                  binding.tenantSlug,
                  binding.organizationId
                );
          });
          const expected = expectedRow(spec.name, matrix, caller);
          const differences = matrix.paths
            .map((relative, index) => ({ relative, before: expected[index], after: row[index] }))
            .filter((cell) => cell.before !== cell.after);
          expect(differences).toEqual([]);
          if (persona !== null && caller === 'plain') expect(persona ?? null).toBe(matrix.persona);
        });
      }
    });
  }
});
