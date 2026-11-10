/**
 * S4 slice 4: the four Execution Persona permission bundles
 * (security-policy.json `persona_permissions`) became base Authority Roles in
 * the registry (`authority-roles/base_<persona>.json`). Every principal keeps
 * its exact (principal, path, operation) decisions. The "before" matrix was
 * recorded while the bundles were still `persona_permissions`
 * (tests/fixtures/base-authority-role-equivalence.json); the suite recomputes
 * it from the registry.
 *
 * A principal is a (role, persona, entry) triple: the persona named through
 * KYBERION_BASE_ROLE (with MISSION_ROLE for the role), or the role assumed
 * in-process with an explicit persona (withExecutionContext).
 *
 * Re-record (only when the policy itself changes, never to hide a difference):
 *   KYBERION_RECORD_BASE_ROLE_EQUIVALENCE=1 pnpm exec vitest run libs/core/testing/base-authority-role-equivalence.test.ts
 * then copy active/shared/tmp/base-authority-role-equivalence.json over the fixture.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { resolveIdentityContext, withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeWriteFile } from '../secure-io.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import type { Persona } from '../types.js';

const TENANT = 'acme-corp';
const OTHER_TENANT = 'other-corp';
const MISSION = 'MSN-MATRIX-1';
const OPERATIONS = ['read', 'write', 'mkdir'] as const;
type Operation = (typeof OPERATIONS)[number];
const BASES = ['sovereign', 'ecosystem_architect', 'worker', 'analyst'] as const;
const PERSONAS: readonly (Persona | '')[] = [...BASES, 'mission_owner', ''];
const ROLES = [
  '',
  'mission_controller',
  'ecosystem_architect',
  'knowledge_steward',
  'software_developer',
] as const;
type Entry = 'env' | 'scope';

interface Principal {
  id: string;
  role: string;
  persona: Persona | '';
  entry: Entry;
}

const PRINCIPALS: Principal[] = ROLES.flatMap((role) =>
  PERSONAS.flatMap((persona) =>
    (role ? (['env', 'scope'] as const) : (['env'] as const)).map((entry) => ({
      id: `${entry}:${role || '-'}:${persona || '-'}`,
      role,
      persona,
      entry,
    }))
  )
);

const ROOT = pathResolver.rootDir();
const FIXTURE = 'tests/fixtures/base-authority-role-equivalence.json';

/** Paths that no bundle names, probed for every principal. */
const OUTSIDERS = [
  '.env.local',
  '.git/config',
  'AGENTS.md',
  'README.md',
  'package.json',
  'vault/secret.txt',
  'docs/guide.md',
  'docs/developer/plan.md',
  'tests/x.test.ts',
  'libs/core/index.ts',
  'scripts/run.ts',
  'customer/acme-corp/customer.json',
  'knowledge/personal/my-identity.json',
  'knowledge/personal/connections/github.json',
  `knowledge/confidential/${TENANT}/notes.md`,
  `knowledge/confidential/${OTHER_TENANT}/notes.md`,
  'knowledge/confidential/canton-node/node.md',
  'knowledge/confidential/_default/x.md',
  'knowledge/public/index.md',
  'knowledge/product/governance/security-policy.json',
  'knowledge/product/evolution/log.md',
  'active/audit/x.jsonl',
  'active/shared/logs/x.jsonl',
  'active/shared/runtime/state/x.json',
  'active/shared/tmp/scratch.txt',
  `active/shared/tmp/confidential/${OTHER_TENANT}/x.txt`,
  `active/missions/${MISSION}/mission-state.json`,
  `active/missions/${MISSION}/evidence/x.md`,
  'active/missions/MSN-OTHER/evidence/x.md',
  'active/projects/public/shared/prj-b/x.md',
  'evidence/browser/x.png',
  'tools/adf-replay-extension/x.js',
];

function expand(pattern: string, tenant: string): string {
  return pattern
    .replace(/\$\{KYBERION_TENANT\}/gu, tenant)
    .replace(/\$\{KYBERION_PROJECT_ID\}/gu, 'prj-a')
    .replace(/\$\{MISSION_ID\}/gu, MISSION);
}

function probedPaths(
  bundles: Record<string, { allow_read?: string[]; allow_write?: string[] }>
): string[] {
  const out = new Set<string>(OUTSIDERS);
  for (const rules of Object.values(bundles))
    for (const pattern of [...(rules.allow_read ?? []), ...(rules.allow_write ?? [])])
      for (const tenant of [TENANT, OTHER_TENANT]) {
        const expanded = expand(pattern, tenant);
        if (expanded.endsWith('/')) {
          const dir = expanded.slice(0, -1);
          out.add(dir);
          out.add(`${dir}/child.json`);
          out.add(`${dir}/nested/deep.jsonl`);
        } else {
          out.add(expanded);
        }
        const parent = path.posix.dirname(expanded.replace(/\/$/u, ''));
        if (parent && parent !== '.') out.add(parent);
      }
  return [...out].sort();
}

const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_BASE_ROLE',
  'KYBERION_PROJECT_ID',
  'KYBERION_ORGANIZATION_ID',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'MISSION_ID',
  'KYBERION_DELEGATED_ROLE',
] as const;

function withPrincipalEnv<T>(principal: Principal, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.KYBERION_TENANT = TENANT;
  process.env.KYBERION_PROJECT_ID = 'prj-a';
  process.env.MISSION_ID = MISSION;
  if (principal.entry === 'env') {
    if (principal.persona) process.env.KYBERION_BASE_ROLE = principal.persona;
    if (principal.role) process.env.MISSION_ROLE = principal.role;
  }
  try {
    return principal.entry === 'scope'
      ? withExecutionContext(principal.role, fn, principal.persona || undefined)
      : fn();
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

function decide(relative: string, operation: Operation): string {
  const absolute = path.join(ROOT, relative);
  const decision =
    operation === 'read'
      ? validateReadPermission(absolute, 'read')
      : validateWritePermission(absolute, operation);
  return decision.allowed ? 'A' : `D:${code(decision.reason)}`;
}

interface PrincipalRow {
  persona: string;
  authorities: string[];
  cells: string[];
}

function principalRow(principal: Principal, paths: readonly string[]): PrincipalRow {
  return withPrincipalEnv(principal, () => {
    const identity = resolveIdentityContext();
    return {
      persona: identity.persona,
      authorities: [...identity.authorities].sort(),
      cells: paths.map((relative) => OPERATIONS.map((op) => decide(relative, op)).join('|')),
    };
  });
}

interface EquivalenceFixture {
  bundles: Record<string, { allow_read?: string[]; allow_write?: string[] }>;
  paths: string[];
  principals: Record<string, PrincipalRow>;
}

const recording = process.env.KYBERION_RECORD_BASE_ROLE_EQUIVALENCE === '1';

function loadJson<T>(relative: string): T {
  return JSON.parse(safeReadFile(path.join(ROOT, relative), { encoding: 'utf8' }) as string) as T;
}

describe('Execution Persona bundles → base Authority Roles (S4 slice 4)', () => {
  if (recording) {
    it('records the before matrix', () => {
      const policy = loadJson<{
        persona_permissions: EquivalenceFixture['bundles'];
      }>('knowledge/product/governance/security-policy.json');
      const bundles = Object.fromEntries(
        BASES.map((base) => [base, policy.persona_permissions[base]!])
      );
      const paths = probedPaths(bundles);
      const principals = Object.fromEntries(
        PRINCIPALS.map((principal) => [principal.id, principalRow(principal, paths)])
      );
      safeWriteFile(
        pathResolver.shared('tmp/base-authority-role-equivalence.json'),
        `${JSON.stringify({ bundles, paths, principals }, null, 2)}\n`
      );
    });
    return;
  }

  const fixture = loadJson<EquivalenceFixture>(FIXTURE);

  it('moves each bundle verbatim into its base Authority Role card', () => {
    const policy = loadJson<{
      persona_permissions?: unknown;
      authority_role_permissions: Record<string, unknown>;
    }>('knowledge/product/governance/security-policy.json');
    expect(policy.persona_permissions).toBeUndefined();
    for (const base of BASES) {
      const card = loadJson<{ role: string; assignable: boolean; permissions: unknown }>(
        `knowledge/product/governance/authority-roles/base_${base}.json`
      );
      expect(card).toMatchObject({ role: `base_${base}`, assignable: false });
      expect(card.permissions).toEqual(fixture.bundles[base]);
      expect(policy.authority_role_permissions[`base_${base}`]).toEqual(fixture.bundles[base]);
    }
  });

  it('probes every principal of the recorded matrix', () => {
    expect(PRINCIPALS.map((principal) => principal.id).sort()).toEqual(
      Object.keys(fixture.principals).sort()
    );
  });

  for (const principal of PRINCIPALS) {
    it(`decides identically for ${principal.id}`, () => {
      const before = fixture.principals[principal.id]!;
      const after = principalRow(principal, fixture.paths);
      expect({ persona: after.persona, authorities: after.authorities }).toEqual({
        persona: before.persona,
        authorities: before.authorities,
      });
      const differences = fixture.paths
        .map((relative, index) => ({
          relative,
          before: before.cells[index],
          after: after.cells[index],
        }))
        .filter((cell) => cell.before !== cell.after);
      expect(differences).toEqual([]);
    });
  }
});
