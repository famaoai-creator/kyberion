import { afterEach, describe, expect, it, vi } from 'vitest';

// Tier-guard classifies repo-relative paths only, so a fixture root under
// active/shared/tmp never trips it. Emulate its tenant rule for fixture
// charters: a read under knowledge/confidential/<slug>/ is denied unless the
// caller runs in that tenant's bound context (as the real guard does in the
// daemon, whose own role holds no tenant binding).
vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  const { resolveIdentityContext } = await import('../authority.js');
  return {
    ...actual,
    safeReadFile: ((filePath: string, options?: unknown) => {
      const match = String(filePath).match(/knowledge\/confidential\/([^/]+)\/dots\//);
      if (match && resolveIdentityContext().tenantSlug !== match[1]) {
        throw new Error(`[TIER_GUARD] read of ${filePath} outside tenant ${match[1]}`);
      }
      return (actual.safeReadFile as (p: string, o?: unknown) => unknown)(filePath, options);
    }) as typeof actual.safeReadFile,
  };
});

import {
  safeAppendFileSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  DOT_CHARTER_LIFECYCLE_AUDIT_PATH,
  listDotCharterPaths,
  listDotCharterSources,
  dotGoalRefLabel,
  findDotCharter,
  type DotCharterLoadError,
  listDotCharters,
  loadDotCharter,
  validateDotCharter,
  type DotCharter,
} from './dot-charter.js';

const TEST_ROOT = 'active/shared/tmp/dot-charter-tests';

const VALID_CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'repo-guardian',
  version: '1.0.0',
  title: 'Repo guardian',
  purpose: 'Keep the repository healthy: watch CI, escalate breakage, dispatch repairs.',
  status: 'active',
  scope: { tier: 'public' },
  goal: {
    statement: 'Keep CI green and surface actionable failures.',
    budget: { max_turns_per_wake: 4, wall_clock_ms_per_wake: 600000 },
  },
  attention: {
    triggers: [
      { kind: 'cron', cron: '*/15 * * * *', timezone: 'Asia/Tokyo' },
      { kind: 'wake', channels: ['slack', 'inbox'] },
    ],
  },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-repo-guardian' },
};

function writeCharter(root: string, name: string, value: unknown): string {
  const dir = `${root}/dots`;
  safeMkdir(dir, { recursive: true });
  const filePath = `${dir}/${name}`;
  safeWriteFile(filePath, JSON.stringify(value, null, 2) + '\n');
  return filePath;
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

function seedTenant(slug: string): void {
  const dir = `${TEST_ROOT}/knowledge/personal/tenants`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    `${dir}/${slug}.json`,
    JSON.stringify({
      tenant_slug: slug,
      display_name: `Tenant ${slug}`,
      status: 'active',
      assigned_role: 'owner',
    })
  );
}

function writeTenantCharter(slug: string, name: string, value: unknown): string {
  const dir = `${TEST_ROOT}/knowledge/confidential/${slug}/dots`;
  safeMkdir(dir, { recursive: true });
  const filePath = `${dir}/${name}`;
  safeWriteFile(filePath, JSON.stringify(value, null, 2) + '\n');
  return filePath;
}

const tenantCharter = (slug: string, dotId: string, scope?: DotCharter['scope']): DotCharter => ({
  ...VALID_CHARTER,
  dot_id: dotId,
  scope: scope ?? { tier: 'confidential', tenant_slug: slug },
  runtime: { heartbeat_id: `dot-${dotId}` },
});

describe('tenant dot charters', () => {
  it('lists and loads a tenant charter inside its tenant context', () => {
    seedTenant('acme');
    const filePath = writeTenantCharter('acme', 'acme-dot.json', tenantCharter('acme', 'acme-dot'));
    expect(listDotCharterSources(TEST_ROOT)).toEqual([{ path: filePath, tenant_slug: 'acme' }]);
    const errors: DotCharterLoadError[] = [];
    const active = listDotCharters(TEST_ROOT, { status: 'active', errors });
    expect(errors).toEqual([]);
    expect(active.map((entry) => entry.charter.dot_id)).toEqual(['acme-dot']);
    // The emulated guard really denies an unbound read of the same file.
    expect(() => loadDotCharter(filePath)).toThrow(/TIER_GUARD/);
  });

  it('rejects a tenant charter that claims another tenant or a lower tier', () => {
    seedTenant('acme');
    seedTenant('globex');
    writeTenantCharter('acme', 'spoof.json', tenantCharter('globex', 'spoof'));
    writeTenantCharter(
      'acme',
      'public.json',
      tenantCharter('acme', 'public-dot', { tier: 'public', tenant_slug: 'acme' })
    );
    writeTenantCharter(
      'acme',
      'untenanted.json',
      tenantCharter('acme', 'bare', { tier: 'confidential' })
    );
    writeTenantCharter('globex', 'ok.json', tenantCharter('globex', 'globex-dot'));
    const errors: DotCharterLoadError[] = [];
    const loaded = listDotCharters(TEST_ROOT, { errors });
    expect(loaded.map((entry) => entry.charter.dot_id)).toEqual(['globex-dot']);
    expect(errors.map((entry) => entry.path.split('/').pop()).sort()).toEqual([
      'public.json',
      'spoof.json',
      'untenanted.json',
    ]);
    for (const entry of errors) expect(entry.error).toMatch(/not bound to its tenant directory/);
    // Without an error sink the mismatch throws like any invalid charter.
    expect(() => listDotCharters(TEST_ROOT)).toThrow(/not bound to its tenant directory/);
  });

  it('keeps a repo-level charter that declares its tenant (org dots live in dots/)', () => {
    seedTenant('acme');
    writeCharter(TEST_ROOT, 'org.json', tenantCharter('acme', 'org-dot'));
    const errors: DotCharterLoadError[] = [];
    expect(listDotCharters(TEST_ROOT, { errors }).map((e) => e.charter.dot_id)).toEqual([
      'org-dot',
    ]);
    expect(errors).toEqual([]);
  });
});

describe('dot charter identity collisions', () => {
  type Location = { slug?: string; status?: DotCharter['status'] };
  it.each([
    {
      label: 'a repo charter keeps its id over a tenant duplicate',
      locations: [{}, { slug: 'acme', status: 'draft' }] as Location[],
      owner: 0,
    },
    {
      label: 'a repo charter keeps its id over two tenant duplicates',
      locations: [{}, { slug: 'acme' }, { slug: 'globex' }] as Location[],
      owner: 0,
    },
    {
      label: "a tenant draft never unseats another tenant's active dot",
      locations: [{ slug: 'acme' }, { slug: 'globex', status: 'draft' }] as Location[],
      owner: 0,
    },
    {
      label: "a tenant retired duplicate never unseats another tenant's paused dot",
      locations: [
        { slug: 'acme', status: 'retired' },
        { slug: 'globex', status: 'paused' },
      ] as Location[],
      owner: 1,
    },
    {
      label: 'of two established tenant charters the earliest-activated keeps the id',
      locations: [{ slug: 'acme' }, { slug: 'globex', status: 'paused' }] as Location[],
      owner: 0,
    },
    {
      label: 'two repo files have no owner (and outrank tenants)',
      locations: [{}, {}, { slug: 'acme' }] as Location[],
      owner: undefined,
    },
    {
      label: 'two files in one tenant have no owner',
      locations: [{ slug: 'acme' }, { slug: 'acme', status: 'draft' }] as Location[],
      owner: undefined,
    },
    {
      label: 'an ambiguous tenant cannot own the id even as the only active one',
      locations: [
        { slug: 'acme' },
        { slug: 'acme', status: 'draft' },
        { slug: 'globex', status: 'draft' },
      ] as Location[],
      owner: undefined,
    },
  ])('resolves dot_id collisions: $label', ({ locations, owner }) => {
    const paths = locations.map(({ slug, status = 'active' }, index) => {
      if (slug) {
        seedTenant(slug);
        return writeTenantCharter(slug, `${index}.json`, {
          ...tenantCharter(slug, 'collision'),
          status,
        });
      }
      return writeCharter(TEST_ROOT, `${index}.json`, {
        ...VALID_CHARTER,
        dot_id: 'collision',
        status,
      });
    });
    writeCharter(TEST_ROOT, 'unique.json', { ...VALID_CHARTER, dot_id: 'unique-dot' });
    const errors: DotCharterLoadError[] = [];
    const loaded = listDotCharters(TEST_ROOT, { errors });
    const ownerPath = owner === undefined ? undefined : paths[owner];
    expect(loaded.map((entry) => entry.path).sort()).toEqual(
      [`${TEST_ROOT}/dots/unique.json`, ...(ownerPath ? [ownerPath] : [])].sort()
    );
    expect(errors.map((entry) => entry.path).sort()).toEqual(
      paths.filter((filePath) => filePath !== ownerPath).sort()
    );
    for (const entry of errors) {
      expect(entry.dot_id).toBe('collision');
      expect(entry.error).toMatch(/Duplicate dot_id 'collision'/);
      expect(entry.error).toContain(ownerPath ? `${ownerPath} keeps the id` : 'all rejected');
    }
    if (ownerPath) {
      expect(findDotCharter('collision', TEST_ROOT)?.path).toBe(ownerPath);
    } else {
      expect(() => findDotCharter('collision', TEST_ROOT)).toThrow(/Duplicate dot_id/);
    }
    // Strict listing (dot validate) still reports any collision.
    expect(() => listDotCharters(TEST_ROOT)).toThrow(/Duplicate dot_id 'collision'/);
  });

  function auditActivation(dotId: string, filePath: string): void {
    const file = `${TEST_ROOT}/${DOT_CHARTER_LIFECYCLE_AUDIT_PATH}`;
    safeMkdir(file.replace(/\/[^/]+$/, ''), { recursive: true });
    safeAppendFileSync(
      file,
      `${JSON.stringify({ event: 'dot_status_transition', dot_id: dotId, from: 'draft', to: 'active', path: filePath })}\n`
    );
  }

  it('reads the same lifecycle audit the lifecycle writes', async () => {
    const { DOT_LIFECYCLE_AUDIT_PATH } = await import('./dot-lifecycle.js');
    expect(DOT_CHARTER_LIFECYCLE_AUDIT_PATH).toBe(DOT_LIFECYCLE_AUDIT_PATH);
  });

  it('the first-activated tenant keeps the id even when paused or later than a newcomer on disk', () => {
    seedTenant('acme');
    seedTenant('globex');
    const globexPath = writeTenantCharter('globex', 'shared.json', {
      ...tenantCharter('globex', 'shared-dot'),
      status: 'paused',
    });
    auditActivation('shared-dot', globexPath);
    const acmePath = writeTenantCharter('acme', 'shared.json', tenantCharter('acme', 'shared-dot'));
    const errors: DotCharterLoadError[] = [];
    expect(listDotCharters(TEST_ROOT, { errors }).map((entry) => entry.path)).toEqual([globexPath]);
    expect(errors).toEqual([
      expect.objectContaining({
        path: acmePath,
        error: expect.stringContaining("first activated by tenant 'globex'"),
      }),
    ]);
    expect(findDotCharter('shared-dot', TEST_ROOT)?.path).toBe(globexPath);
    // The owner's audit identity is the tenant, not the newcomer's activation order.
    auditActivation('shared-dot', acmePath);
    expect(listDotCharters(TEST_ROOT, { errors: [] }).map((entry) => entry.path)).toEqual([
      globexPath,
    ]);
  });

  it("never hands a removed tenant dot's id to another tenant", () => {
    seedTenant('acme');
    seedTenant('globex');
    auditActivation(
      'moved-dot',
      `${TEST_ROOT}/knowledge/confidential/globex/dots/moved.json` // since removed
    );
    const acmePath = writeTenantCharter('acme', 'moved.json', tenantCharter('acme', 'moved-dot'));
    const errors: DotCharterLoadError[] = [];
    expect(listDotCharters(TEST_ROOT, { errors })).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({
        path: acmePath,
        dot_id: 'moved-dot',
        error: expect.stringMatching(/rejected — first activated by tenant 'globex'.*new dot_id/),
      }),
    ]);
    expect(() => listDotCharters(TEST_ROOT)).toThrow(/never moves between tenants/);
    // The original tenant may bring its own dot back.
    const globexPath = writeTenantCharter('globex', 'moved.json', {
      ...tenantCharter('globex', 'moved-dot'),
      status: 'paused',
    });
    expect(listDotCharters(TEST_ROOT, { errors: [] }).map((entry) => entry.path)).toEqual([
      globexPath,
    ]);
  });

  it.each(['draft', 'paused', 'retired'] as const)(
    'keeps an active repo dot when a %s tenant charter reuses its id',
    (status) => {
      seedTenant('acme');
      const activePath = writeCharter(TEST_ROOT, 'active.json', VALID_CHARTER);
      const inactivePath = writeTenantCharter('acme', 'inactive.json', {
        ...tenantCharter('acme', VALID_CHARTER.dot_id),
        status,
      });
      writeCharter(TEST_ROOT, 'unique-inactive.json', {
        ...VALID_CHARTER,
        dot_id: 'unique-inactive',
        status,
      });
      const errors: DotCharterLoadError[] = [];
      expect(listDotCharters(TEST_ROOT, { status: 'active', errors }).map((e) => e.path)).toEqual([
        activePath,
      ]);
      expect(errors.map((entry) => entry.path)).toEqual([inactivePath]);
      expect(() => listDotCharters(TEST_ROOT, { status: 'active' })).toThrow(
        /Duplicate dot_id 'repo-guardian'/
      );
    }
  );

  it('does not treat an invalid charter as a loaded identity collision', () => {
    writeCharter(TEST_ROOT, 'valid.json', VALID_CHARTER);
    const invalidPath = writeCharter(TEST_ROOT, 'invalid.json', { ...VALID_CHARTER, bogus: true });
    const errors: DotCharterLoadError[] = [];
    expect(listDotCharters(TEST_ROOT, { errors }).map((entry) => entry.charter.dot_id)).toEqual([
      VALID_CHARTER.dot_id,
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(invalidPath);
    expect(errors[0].error).toMatch(/Invalid dot charter/);
  });
});

describe('dot charter', () => {
  it('validates a well-formed charter', () => {
    expect(validateDotCharter(VALID_CHARTER).dot_id).toBe('repo-guardian');
  });

  it('rejects a charter missing required sections', () => {
    expect(() => validateDotCharter({ kind: 'dot-charter', dot_id: 'x' })).toThrow(
      /Invalid dot charter/
    );
  });

  it('rejects unknown top-level properties', () => {
    expect(() => validateDotCharter({ ...VALID_CHARTER, bogus: true })).toThrow(
      /Invalid dot charter/
    );
  });

  describe('operations_cadence', () => {
    const orgCharter = {
      ...VALID_CHARTER,
      scope: { tier: 'confidential' as const, tenant_slug: 'acme', organization_id: 'org-a' },
      authority: { ...VALID_CHARTER.authority, authority_role: 'organization_operator' },
    };
    const cadence = {
      tick_every_minutes: 15,
      standup: { cron: '45 8 * * 1-5', timezone: 'Asia/Tokyo' },
      retro: { cron: '0 17 * * 5' },
    };

    it('accepts an organization-scoped organization_operator charter', () => {
      expect(
        validateDotCharter({ ...orgCharter, operations_cadence: cadence }).operations_cadence
      ).toEqual(cadence);
    });

    it('requires scope.organization_id', () => {
      expect(() =>
        validateDotCharter({
          ...orgCharter,
          scope: { tier: 'confidential', tenant_slug: 'acme' },
          operations_cadence: cadence,
        })
      ).toThrow(/organization_id/);
    });

    it('requires the organization_operator authority role', () => {
      expect(() =>
        validateDotCharter({
          ...orgCharter,
          authority: { ...orgCharter.authority, authority_role: 'infrastructure_sentinel' },
          operations_cadence: cadence,
        })
      ).toThrow(/Invalid dot charter/);
    });

    it.each([
      [{ tick_every_minutes: 4 }],
      [{ standup: { cron: '45 8 * *' } }],
      [{ retro: { cron: '0 17 * * 5', extra: true } }],
      [{ standup: { cron: '45 8 * * 1-5', timezone: 'Mars/Olympus' } }],
    ])('rejects a malformed cadence %j', (patch) => {
      expect(() => validateDotCharter({ ...orgCharter, operations_cadence: patch })).toThrow(
        /Invalid dot charter/
      );
    });
  });

  it('rejects an authority role that is not declared in security-policy when checked', () => {
    // The schema cannot cross-reference security-policy.json; the loader only
    // validates shape. Role existence is enforced where charters are consumed.
    const charter = validateDotCharter({
      ...VALID_CHARTER,
      authority: { authority_role: 'nonexistent_role' },
    });
    expect(charter.authority.authority_role).toBe('nonexistent_role');
  });

  it('lists only regular non-symlink json files and filters by status', () => {
    writeCharter(TEST_ROOT, 'active.json', VALID_CHARTER);
    writeCharter(TEST_ROOT, 'paused.json', {
      ...VALID_CHARTER,
      dot_id: 'paused-dot',
      status: 'paused',
    });
    const externalPath = `${TEST_ROOT}/external.json`;
    const linkPath = `${TEST_ROOT}/dots/link.json`;
    safeWriteFile(externalPath, JSON.stringify(VALID_CHARTER));
    safeSymlinkSync(externalPath, linkPath);

    const all = listDotCharterPaths(TEST_ROOT);
    expect(all.map((p) => p.split('/').pop()).sort()).toEqual(['active.json', 'paused.json']);

    const active = listDotCharters(TEST_ROOT, { status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].charter.dot_id).toBe('repo-guardian');
  });

  it('loads a charter file end-to-end', () => {
    const filePath = writeCharter(TEST_ROOT, 'one.json', VALID_CHARTER);
    expect(loadDotCharter(filePath).runtime.heartbeat_id).toBe('dot-repo-guardian');
  });

  it('accepts the loop extensions and keeps them optional', () => {
    const charter = validateDotCharter({
      ...VALID_CHARTER,
      goal: {
        ...VALID_CHARTER.goal,
        outcome_settle_minutes: 30,
        key_results: [
          {
            kr_id: 'ci-green',
            title: 'CI green ratio',
            metric: { source: 'signal_ratio', signal: 'ci healthy', window_hours: 24 },
            target: 95,
            direction: 'increase',
          },
          {
            kr_id: 'incidents',
            title: 'Open incidents',
            metric: { source: 'org_metric', metric: 'open_incidents' },
            target: 0,
            direction: 'decrease',
            baseline: 5,
          },
        ],
      },
      authority: {
        authority_role: 'infrastructure_sentinel',
        allowed_pipelines: ['pipelines/a.json'],
      },
      attention: {
        triggers: [
          {
            kind: 'event',
            sources: ['github'],
            types: ['push'],
            match: { json_path: '$.ref', in: ['main'] },
          },
        ],
      },
      runtime: { heartbeat_id: 'dot-repo-guardian', cron_catch_up_hours: 12 },
      memory: { enabled: true, max_bytes: 8192 },
      followups: { max_pending: 3 },
      autonomy: { initial_level: 'L2', max_level: 'L3', min_level: 'L1' },
      team: { owns: ['path:src/**'], priority: 70, goal_ref: { objective_id: 'obj-1' } },
    });
    expect(charter.goal.key_results).toHaveLength(2);
    expect(dotGoalRefLabel(charter)).toBe('obj-1');
  });

  it('rejects malformed loop extensions', () => {
    const bad = (patch: Record<string, unknown>) =>
      expect(() => validateDotCharter({ ...VALID_CHARTER, ...patch })).toThrow(
        /Invalid dot charter/
      );
    bad({ runtime: { heartbeat_id: 'dot-x', cron_catch_up_hours: 48 } });
    bad({ team: { priority: 101 } });
    bad({ autonomy: { max_level: 'L9' } });
    bad({
      goal: {
        statement: 's',
        key_results: [
          {
            kr_id: 'A B',
            title: 't',
            metric: { source: 'nope' },
            target: 1,
            direction: 'increase',
          },
        ],
      },
    });
    bad({ attention: { triggers: [{ kind: 'event', sources: [] }] } });
  });

  it('labels string and objective goal refs', () => {
    expect(dotGoalRefLabel(VALID_CHARTER)).toBeUndefined();
    expect(dotGoalRefLabel({ ...VALID_CHARTER, team: { goal_ref: 'ship it' } })).toBe('ship it');
    expect(
      dotGoalRefLabel({
        ...VALID_CHARTER,
        team: { goal_ref: { organization_id: 'o1', objective_id: 'obj' } },
      })
    ).toBe('o1/obj');
  });
});
