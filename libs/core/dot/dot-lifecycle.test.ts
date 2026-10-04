import { afterEach, describe, expect, it } from 'vitest';

import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { loadDotCharter, type DotCharter } from './dot-charter.js';
import {
  DOT_LIFECYCLE_AUDIT_PATH,
  checkDotActivationReadiness,
  isDotStatusTerminal,
  transitionDotCharterStatus,
} from './dot-lifecycle.js';

const TEST_ROOT = 'active/shared/tmp/dot-lifecycle-tests';

const DRAFT: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'repo-guardian',
  version: '1.0.0',
  title: 'Repo guardian',
  purpose: 'Keep the repository healthy.',
  status: 'draft',
  scope: { tier: 'public' },
  goal: { statement: 'Keep CI green.' },
  attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-repo-guardian' },
};

const KNOWN_ROLES = new Set(['infrastructure_sentinel']);
const deps = {
  rootDir: TEST_ROOT,
  hasRole: (role: string) => KNOWN_ROLES.has(role),
  supervisedDaemonIds: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
};

function writeCharter(charter: unknown, name = 'dot.json'): string {
  safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
  const filePath = `${TEST_ROOT}/dots/${name}`;
  safeWriteFile(filePath, JSON.stringify(charter, null, 2) + '\n');
  return filePath;
}

function writeTenantCharter(slug: string, charter: DotCharter, name = 'dot.json'): string {
  const profiles = `${TEST_ROOT}/knowledge/personal/tenants`;
  safeMkdir(profiles, { recursive: true });
  safeWriteFile(
    `${profiles}/${slug}.json`,
    JSON.stringify({
      tenant_slug: slug,
      display_name: slug,
      status: 'active',
      assigned_role: 'owner',
    })
  );
  const dir = `${TEST_ROOT}/knowledge/confidential/${slug}/dots`;
  safeMkdir(dir, { recursive: true });
  const filePath = `${dir}/${name}`;
  safeWriteFile(
    filePath,
    JSON.stringify({
      ...charter,
      scope: { tier: 'confidential', tenant_slug: slug },
    })
  );
  return filePath;
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('transitionDotCharterStatus', () => {
  it.each(['active', 'paused', 'retired'] as const)(
    'rejects ambiguous identity before a %s transition or any write',
    (target) => {
      const status = target === 'active' ? 'draft' : 'active';
      const repoPath = writeCharter({ ...DRAFT, status });
      const secondPath = writeCharter({ ...DRAFT, status }, 'second.json');
      expect(() => transitionDotCharterStatus(DRAFT.dot_id, target, deps)).toThrow(
        /Duplicate dot_id 'repo-guardian'/
      );
      expect(loadDotCharter(repoPath).status).toBe(status);
      expect(loadDotCharter(secondPath).status).toBe(status);
      expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(false);
    }
  );

  it('transitions the repo owner of an id a tenant duplicate reuses, leaving the duplicate', () => {
    const repoPath = writeCharter(DRAFT);
    const tenantPath = writeTenantCharter('acme', { ...DRAFT, status: 'draft' });
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'active', deps).status).toBe('active');
    expect(loadDotCharter(repoPath).status).toBe('active');
    expect(loadDotCharter(tenantPath).status).toBe('draft');
  });

  it('transitions only the owner of an identity shared by two tenants', () => {
    const first = writeTenantCharter('acme', { ...DRAFT, status: 'active' });
    const second = writeTenantCharter('globex', { ...DRAFT, status: 'active' });
    // No lifecycle history: the earliest-activated established charter owns the id.
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'paused', deps).status).toBe('paused');
    expect(loadDotCharter(first).status).toBe('paused');
    expect(loadDotCharter(second).status).toBe('active');
  });

  it('rejects a transition for an identity two files in one tenant declare', () => {
    const first = writeTenantCharter('acme', { ...DRAFT, status: 'active' });
    const second = writeTenantCharter('acme', { ...DRAFT, status: 'active' }, 'second.json');
    expect(() => transitionDotCharterStatus(DRAFT.dot_id, 'paused', deps)).toThrow(
      /Duplicate dot_id 'repo-guardian'/
    );
    expect(loadDotCharter(first).status).toBe('active');
    expect(loadDotCharter(second).status).toBe('active');
    expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(false);
  });

  it('still transitions an unambiguous tenant charter beside malformed and colliding siblings', () => {
    writeCharter({ ...DRAFT, dot_id: 'collision' }, 'one.json');
    writeCharter({ ...DRAFT, dot_id: 'collision' }, 'two.json');
    writeCharter({ ...DRAFT, bogus: true }, 'broken.json');
    const filePath = writeTenantCharter('acme', { ...DRAFT, dot_id: 'unique', status: 'active' });
    expect(transitionDotCharterStatus('unique', 'paused', deps).status).toBe('paused');
    expect(loadDotCharter(filePath).status).toBe('paused');
  });

  it('activates a draft charter when the gate passes', () => {
    const filePath = writeCharter({ ...DRAFT, $schema: '../schema.json' });
    const updated = transitionDotCharterStatus('repo-guardian', 'active', deps);
    expect(updated.status).toBe('active');
    // The on-disk file retains $schema and the new status.
    expect(loadDotCharter(filePath).status).toBe('active');
    expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(true);
  });

  it('rejects activation when the authority role is not in the registry', () => {
    writeCharter({ ...DRAFT, authority: { authority_role: 'ghost_role' } });
    expect(() => transitionDotCharterStatus('repo-guardian', 'active', deps)).toThrow(
      /DOT_ACTIVATE_ROLE.*ghost_role/
    );
    expect(loadDotCharter(`${TEST_ROOT}/dots/dot.json`).status).toBe('draft');
  });

  it('rejects activation when the heartbeat id collides with a supervised daemon', () => {
    writeCharter({ ...DRAFT, runtime: { heartbeat_id: 'chronos-daemon' } });
    expect(() => transitionDotCharterStatus('repo-guardian', 'active', deps)).toThrow(
      /DOT_ACTIVATE_HEARTBEAT/
    );
  });

  it('rejects activation when the heartbeat id is used by another active dot', () => {
    writeCharter({ ...DRAFT, status: 'active' }, 'one.json');
    writeCharter({ ...DRAFT, dot_id: 'second-dot' }, 'two.json');
    expect(() => transitionDotCharterStatus('second-dot', 'active', deps)).toThrow(
      /DOT_ACTIVATE_HEARTBEAT.*repo-guardian/
    );
  });

  it('rejects activation while another active dot holds the same responsibility', () => {
    writeCharter(
      { ...DRAFT, status: 'active', team: { responsibilities: ['ci.health', 'deps'] } },
      'one.json'
    );
    writeCharter(
      {
        ...DRAFT,
        dot_id: 'second-dot',
        runtime: { heartbeat_id: 'dot-second' },
        team: { responsibilities: ['deps'] },
      },
      'two.json'
    );
    expect(() => transitionDotCharterStatus('second-dot', 'active', deps)).toThrow(
      /DOT_ACTIVATE_RESPONSIBILITY.*deps.*repo-guardian/
    );
    writeCharter(
      {
        ...DRAFT,
        dot_id: 'second-dot',
        runtime: { heartbeat_id: 'dot-second' },
        team: { responsibilities: ['releases'] },
      },
      'two.json'
    );
    expect(transitionDotCharterStatus('second-dot', 'active', deps).status).toBe('active');
  });

  it('allows pause and re-activation, forbids retiring a retired dot', () => {
    writeCharter({ ...DRAFT, status: 'active' });
    expect(transitionDotCharterStatus('repo-guardian', 'paused', deps).status).toBe('paused');
    expect(transitionDotCharterStatus('repo-guardian', 'active', deps).status).toBe('active');
    transitionDotCharterStatus('repo-guardian', 'retired', deps);
    expect(isDotStatusTerminal('retired')).toBe(true);
    expect(() => transitionDotCharterStatus('repo-guardian', 'active', deps)).toThrow(
      /DOT_TRANSITION/
    );
  });

  it('rejects draft → paused directly and unknown dots', () => {
    writeCharter(DRAFT);
    expect(() => transitionDotCharterStatus('repo-guardian', 'paused', deps)).toThrow(
      /DOT_TRANSITION/
    );
    expect(() => transitionDotCharterStatus('nope', 'active', deps)).toThrow(/DOT_NOT_FOUND/);
  });
});

describe('checkDotActivationReadiness', () => {
  it('reports an ownerless duplicate identity as an activation blocker', () => {
    writeCharter(DRAFT);
    writeCharter(DRAFT, 'second.json');
    expect(checkDotActivationReadiness(DRAFT, deps)).toMatchObject({
      ready: false,
      errors: [expect.stringContaining("Duplicate dot_id 'repo-guardian'")],
    });
  });

  it('blocks a rejected duplicate but not the owner of its id', () => {
    writeCharter(DRAFT);
    writeTenantCharter('acme', { ...DRAFT, status: 'retired' });
    expect(checkDotActivationReadiness(DRAFT, deps)).toEqual({ ready: true, errors: [] });
    const duplicate: DotCharter = {
      ...DRAFT,
      status: 'retired',
      scope: { tier: 'confidential', tenant_slug: 'acme' },
    };
    expect(checkDotActivationReadiness(duplicate, deps)).toMatchObject({
      ready: false,
      errors: [expect.stringContaining('[DOT_IDENTITY]')],
    });
  });

  it('reports gate errors without mutating the charter', () => {
    writeCharter({ ...DRAFT, authority: { authority_role: 'ghost_role' } });
    const check = checkDotActivationReadiness(
      { ...DRAFT, authority: { authority_role: 'ghost_role' } },
      deps
    );
    expect(check.ready).toBe(false);
    expect(check.errors[0]).toContain('ghost_role');
  });
});
