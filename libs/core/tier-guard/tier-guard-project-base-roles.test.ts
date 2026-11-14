import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// S4 (concept-model-v2 D5): security-policy.json `project_permissions.<project>.allowed_personas`
// is renamed `allowed_base_roles`. An installation catalog that predates the rename is read
// for one release: it must decide exactly as the renamed catalog does, and a catalog that
// declares both uses the new list only.

const state = { mode: 'current' as 'current' | 'legacy' | 'both' };

vi.mock('./fs-primitives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-primitives.js')>();
  return {
    ...actual,
    rawReadTextFile: (p: string, ...rest: unknown[]) => {
      const text = (actual.rawReadTextFile as (p: string, ...r: unknown[]) => string)(p, ...rest);
      if (!p.endsWith(path.join('governance', 'security-policy.json'))) return text;
      const policy = JSON.parse(text) as {
        project_permissions: Record<string, Record<string, unknown>>;
      };
      // A list that reaches the gate: the shipped policy's ecosystem_architect is
      // admitted earlier by its base role grant, so list base roles that are not.
      const listed = ['worker', 'mission_owner'];
      const entry = policy.project_permissions['canton-node']!;
      delete entry.allowed_base_roles;
      delete entry.allowed_personas;
      if (state.mode === 'legacy') entry.allowed_personas = listed;
      else entry.allowed_base_roles = listed;
      // the legacy list would admit other base roles too; the new one must win
      if (state.mode === 'both') entry.allowed_personas = ['analyst', 'unknown', ...listed];
      return JSON.stringify(policy);
    },
  };
});

const BASE_ROLES: readonly string[] = [
  'sovereign',
  'ecosystem_architect',
  'mission_owner',
  'worker',
  'analyst',
  'unknown',
];
const PATHS = [
  'knowledge/confidential/canton-node/node.md',
  'knowledge/confidential/canton-node/deep/x.json',
];

async function decisions(): Promise<string[]> {
  vi.resetModules();
  const { validateReadPermission, validateWritePermission } = await import('./tier-guard.js');
  const { pathResolver } = await import('./path-resolver.js');
  const root = pathResolver.rootDir();
  const out: string[] = [];
  for (const baseRole of BASE_ROLES) {
    for (const sudo of [false, true]) {
      // the policy-layer identity resolver reads the base role and sudo from the env
      vi.stubEnv('KYBERION_BASE_ROLE', baseRole === 'unknown' ? '' : baseRole);
      vi.stubEnv('KYBERION_SUDO', sudo ? 'true' : '');
      for (const relative of PATHS) {
        const read = validateReadPermission(path.join(root, relative), 'read');
        const write = validateWritePermission(path.join(root, relative), 'write');
        out.push(
          `${baseRole}:${sudo ? 'sudo' : '-'}:${relative}:${read.allowed ? 'A' : read.reason}|${write.allowed ? 'A' : write.reason}`
        );
      }
    }
  }
  return out;
}

describe('project_permissions allowed_base_roles (S4)', () => {
  beforeEach(() => {
    vi.stubEnv('SYSTEM_ROLE', undefined);
    vi.stubEnv('MISSION_ROLE', undefined);
    vi.stubEnv('KYBERION_SUDO', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    state.mode = 'current';
  });

  it('decides a pre-rename catalog (allowed_personas) exactly as the renamed one', async () => {
    state.mode = 'current';
    const current = await decisions();
    state.mode = 'legacy';
    const legacy = await decisions();
    expect(legacy).toEqual(current);
    // the gate is live: it refuses some base roles and admits the listed one
    expect(current.some((row) => row.includes('is not authorized for project'))).toBe(true);
    expect(current.filter((row) => row.startsWith('worker:-:')).join('\n')).not.toContain(
      'is not authorized for project'
    );
  });

  it('reads only allowed_base_roles when a catalog declares both', async () => {
    state.mode = 'current';
    const current = await decisions();
    state.mode = 'both';
    expect(await decisions()).toEqual(current);
  });
});
