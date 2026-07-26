import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeRmSync } from './secure-io.js';
import { resolveIdentityContext, withExecutionContext } from './authority.js';
import {
  issueTaskGrant,
  issueTaskGrantBestEffort,
  listActiveGrants,
  resolveGrantsForActor,
  revokeGrantsForTask,
  revokeTaskGrant,
  setTaskGrantAuditSinkForTests,
  TASK_GRANT_DEFAULT_TTL_MS,
  TASK_GRANT_DENIED_EVENT,
  TASK_GRANT_ISSUED_EVENT,
  TASK_GRANT_MAX_TTL_MS,
  TASK_GRANT_REVOKED_EVENT,
  TASK_GRANTS_PATH_ENV,
  TaskGrantGovernedError,
  TaskGrantValidationError,
  taskScopedGrantSchema,
  type TaskGrantAuditEvent,
  type TaskScopedGrant,
} from './task-scoped-grants.js';

/**
 * NI-04 tests. Hermetic: every test repoints the store via the
 * KYBERION_TASK_GRANTS_PATH env override at a fresh, unique JSONL path under
 * active/shared/tmp/ (never the governed default path) — the same
 * default-path-under-test discipline as agent-identity.test.ts.
 */

const TMP_DIR = `active/shared/tmp/ni04-tests-${process.pid}`;
let counter = 0;

function nextStorePath(): string {
  counter += 1;
  return `${TMP_DIR}/task-grants-${counter}.jsonl`;
}

function cleanupTmpDir(): void {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

const GRANTEE = 'kyberion://agent/demo-org/nerve-agent';
const OTHER_GRANTEE = 'kyberion://agent/demo-org/other-agent';

const SAVED_ENV_KEYS = [
  TASK_GRANTS_PATH_ENV,
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'MISSION_ID',
  'TASK_ID',
  'KYBERION_NHI_ID',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env[TASK_GRANTS_PATH_ENV] = nextStorePath();
});

afterEach(() => {
  setTaskGrantAuditSinkForTests(null);
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => cleanupTmpDir());

function issueGoverned(
  overrides: Partial<Parameters<typeof issueTaskGrant>[0]> = {}
): TaskScopedGrant {
  return withExecutionContext('mission_controller', () =>
    issueTaskGrant({
      granteeNhiId: GRANTEE,
      audience: { missionId: 'MSN-A', taskId: 'task-1' },
      ...overrides,
    })
  );
}

describe('task-scoped grants: issuance', () => {
  it('issues a schema-valid grant with bounded default TTL and lists it as active', () => {
    const before = Date.now();
    const grant = issueGoverned();
    expect(taskScopedGrantSchema.parse(grant)).toEqual(grant);
    expect(grant.grant_id).toMatch(/^tg-/);
    expect(grant.grantee_nhi_id).toBe(GRANTEE);
    expect(grant.audience).toEqual({ mission_id: 'MSN-A', task_id: 'task-1' });
    expect(grant.issued_by).toBe('mission_controller');
    const expires = Date.parse(grant.expires_at);
    expect(expires).toBeGreaterThan(before);
    expect(expires).toBeLessThanOrEqual(Date.now() + TASK_GRANT_DEFAULT_TTL_MS + 1000);
    expect(listActiveGrants({ missionId: 'MSN-A' })).toHaveLength(1);
  });

  it('fails closed outside an allowlisted execution context', () => {
    expect(() =>
      withExecutionContext('software_developer', () =>
        issueTaskGrant({ granteeNhiId: GRANTEE, audience: { missionId: 'MSN-A' } })
      )
    ).toThrow(TaskGrantGovernedError);
  });

  it('refuses the governed default store path under vitest', () => {
    delete process.env[TASK_GRANTS_PATH_ENV];
    expect(() => issueGoverned()).toThrow(/refusing to write the governed default store/);
  });

  it('rejects a non-canonical grantee nhi_id', () => {
    expect(() => issueGoverned({ granteeNhiId: 'sovereign-brain' })).toThrow(
      TaskGrantValidationError
    );
  });

  it('clamps an excessive caller-supplied expiry to the 24h max TTL', () => {
    const now = Date.now();
    const grant = issueGoverned({
      expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    });
    const expires = Date.parse(grant.expires_at);
    expect(expires).toBeLessThanOrEqual(now + TASK_GRANT_MAX_TTL_MS + 1000);
    expect(expires).toBeGreaterThan(now + TASK_GRANT_MAX_TTL_MS - 60_000);
  });

  it('uses the task deadline when it is shorter than the requested expiry', () => {
    const now = Date.now();
    const deadline = new Date(now + 30 * 60 * 1000).toISOString();
    const grant = issueGoverned({
      expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
      taskDeadline: deadline,
    });
    expect(grant.expires_at).toBe(deadline);
  });

  it('rejects an expiry that is already in the past', () => {
    expect(() => issueGoverned({ expiresAt: new Date(Date.now() - 60_000).toISOString() })).toThrow(
      TaskGrantValidationError
    );
  });
});

describe('task-scoped grants: audience enforcement (RFC 8707 analogue)', () => {
  it('serves a grant only for its exact mission/task audience', () => {
    const grant = issueGoverned();

    // exact match: served
    expect(
      resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A', taskId: 'task-1' }).map(
        (g) => g.grant_id
      )
    ).toEqual([grant.grant_id]);

    // different mission: nothing
    expect(resolveGrantsForActor(GRANTEE, { missionId: 'MSN-B', taskId: 'task-1' })).toEqual([]);
    // different task: nothing
    expect(resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A', taskId: 'task-2' })).toEqual([]);
    // task-bound grant without task context: nothing
    expect(resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A' })).toEqual([]);
    // different actor: nothing
    expect(resolveGrantsForActor(OTHER_GRANTEE, { missionId: 'MSN-A', taskId: 'task-1' })).toEqual(
      []
    );
  });

  it('serves a mission-wide grant (no task_id) for any task of that mission', () => {
    const grant = issueGoverned({ audience: { missionId: 'MSN-A' } });
    expect(
      resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A', taskId: 'task-9' }).map(
        (g) => g.grant_id
      )
    ).toEqual([grant.grant_id]);
    expect(resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A' }).map((g) => g.grant_id)).toEqual([
      grant.grant_id,
    ]);
    expect(resolveGrantsForActor(GRANTEE, { missionId: 'MSN-B' })).toEqual([]);
  });

  it('records a typed deny audit event for an audience-mismatch attempt', () => {
    const events: TaskGrantAuditEvent[] = [];
    setTaskGrantAuditSinkForTests((event) => events.push(event));
    const grant = issueGoverned();
    events.length = 0;

    resolveGrantsForActor(GRANTEE, { missionId: 'MSN-B', taskId: 'task-1' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: TASK_GRANT_DENIED_EVENT,
      grant_id: grant.grant_id,
      grantee_nhi_id: GRANTEE,
      result: 'denied',
    });
    expect(events[0].reason).toContain('audience mismatch');
  });

  it('never serves an expired grant (lazy expiry, no deny audit)', () => {
    const events: TaskGrantAuditEvent[] = [];
    setTaskGrantAuditSinkForTests((event) => events.push(event));
    issueGoverned();
    events.length = 0;

    const afterExpiry = Date.now() + TASK_GRANT_MAX_TTL_MS + 60_000;
    expect(
      resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A', taskId: 'task-1' }, { now: afterExpiry })
    ).toEqual([]);
    expect(listActiveGrants({ now: afterExpiry })).toEqual([]);
    expect(events).toEqual([]); // expired grants are silently skipped, not "denied"
  });
});

describe('task-scoped grants: revocation', () => {
  it('revokes a grant, stops serving it, and is idempotent', () => {
    const grant = issueGoverned();
    const revoked = withExecutionContext('mission_controller', () =>
      revokeTaskGrant(grant.grant_id, 'test cleanup')
    );
    expect(revoked).toMatchObject({ grant_id: grant.grant_id, revoke_reason: 'test cleanup' });
    expect(revoked?.revoked_at).toBeTruthy();
    expect(resolveGrantsForActor(GRANTEE, { missionId: 'MSN-A', taskId: 'task-1' })).toEqual([]);
    expect(listActiveGrants()).toEqual([]);

    const again = withExecutionContext('mission_controller', () =>
      revokeTaskGrant(grant.grant_id, 'second reason')
    );
    expect(again?.revoke_reason).toBe('test cleanup'); // idempotent — first revoke wins
    expect(
      withExecutionContext('mission_controller', () => revokeTaskGrant('tg-unknown', 'x'))
    ).toBeNull();
  });

  it('revokeGrantsForTask revokes only grants bound to that exact task audience', () => {
    const taskGrant = issueGoverned();
    const otherTaskGrant = issueGoverned({ audience: { missionId: 'MSN-A', taskId: 'task-2' } });
    const missionWideGrant = issueGoverned({ audience: { missionId: 'MSN-A' } });

    const revoked = withExecutionContext('mission_controller', () =>
      revokeGrantsForTask('MSN-A', 'task-1', 'task done')
    );
    expect(revoked.map((g) => g.grant_id)).toEqual([taskGrant.grant_id]);

    const remaining = listActiveGrants({ missionId: 'MSN-A' }).map((g) => g.grant_id);
    expect(remaining).toContain(otherTaskGrant.grant_id);
    expect(remaining).toContain(missionWideGrant.grant_id);
    expect(remaining).not.toContain(taskGrant.grant_id);
  });

  it('appends issue and revoke audit records through the injected sink', () => {
    const events: TaskGrantAuditEvent[] = [];
    setTaskGrantAuditSinkForTests((event) => events.push(event));

    const grant = issueGoverned();
    withExecutionContext('mission_controller', () =>
      revokeGrantsForTask('MSN-A', 'task-1', 'task done')
    );

    expect(events.map((event) => event.action)).toEqual([
      TASK_GRANT_ISSUED_EVENT,
      TASK_GRANT_REVOKED_EVENT,
    ]);
    expect(events[0]).toMatchObject({
      grant_id: grant.grant_id,
      grantee_nhi_id: GRANTEE,
      audience: { mission_id: 'MSN-A', task_id: 'task-1' },
      result: 'allowed',
    });
    expect(events[1]).toMatchObject({ grant_id: grant.grant_id, reason: 'task done' });
  });
});

describe('task-scoped grants: store robustness and best-effort wrappers', () => {
  it('tolerates torn/corrupt store lines', () => {
    const grant = issueGoverned();
    const storePath = pathResolver.rootResolve(process.env[TASK_GRANTS_PATH_ENV] as string);
    safeAppendFileSync(storePath, 'not json at all\n{"grant_id": "half-\n');
    expect(listActiveGrants().map((g) => g.grant_id)).toEqual([grant.grant_id]);
  });

  it('best-effort issue never throws outside a governed context', () => {
    const result = issueTaskGrantBestEffort({
      granteeNhiId: GRANTEE,
      audience: { missionId: 'MSN-A', taskId: 'task-1' },
    });
    expect(result).toBeNull();
    expect(listActiveGrants()).toEqual([]);
  });
});

describe('task-scoped grants: authority.resolveIdentityContext integration', () => {
  it('grants an Authority to an audience-matched actor via KYBERION_NHI_ID', () => {
    issueGoverned({ scope: { capabilities: ['GIT_WRITE', 'deploy:prod'] } });
    process.env.MISSION_ID = 'MSN-A';
    process.env.TASK_ID = 'task-1';
    process.env.KYBERION_NHI_ID = GRANTEE;
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'software_developer';

    const context = resolveIdentityContext();
    expect(context.authorities).toContain('GIT_WRITE');
    // non-Authority capability names are opaque tags, never authorities
    expect(context.authorities).not.toContain('deploy:prod');
  });

  it('contributes nothing for a mismatched mission, task, or actor', () => {
    issueGoverned({ scope: { capabilities: ['GIT_WRITE'] } });
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'software_developer';
    process.env.KYBERION_NHI_ID = GRANTEE;

    process.env.MISSION_ID = 'MSN-B';
    process.env.TASK_ID = 'task-1';
    expect(resolveIdentityContext().authorities).not.toContain('GIT_WRITE');

    process.env.MISSION_ID = 'MSN-A';
    process.env.TASK_ID = 'task-2';
    expect(resolveIdentityContext().authorities).not.toContain('GIT_WRITE');

    process.env.TASK_ID = 'task-1';
    process.env.KYBERION_NHI_ID = OTHER_GRANTEE;
    expect(resolveIdentityContext().authorities).not.toContain('GIT_WRITE');

    // no resolvable actor identity at all: fail-closed
    delete process.env.KYBERION_NHI_ID;
    expect(resolveIdentityContext().authorities).not.toContain('GIT_WRITE');
  });

  it('contributes nothing for expired or revoked grants', () => {
    process.env.MISSION_ID = 'MSN-A';
    process.env.TASK_ID = 'task-1';
    process.env.KYBERION_NHI_ID = GRANTEE;
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'software_developer';

    // Revoked grant.
    const grant = issueGoverned({ scope: { capabilities: ['GIT_WRITE'] } });
    withExecutionContext('mission_controller', () => revokeTaskGrant(grant.grant_id, 'test'));
    expect(resolveIdentityContext().authorities).not.toContain('GIT_WRITE');

    // Expired grant: write a schema-valid record whose expiry is in the past
    // (issueTaskGrant refuses past expiries, so append it directly).
    const storePath = pathResolver.rootResolve(process.env[TASK_GRANTS_PATH_ENV] as string);
    const expired: TaskScopedGrant = {
      grant_id: 'tg-expired-1',
      grantee_nhi_id: GRANTEE,
      scope: { capabilities: ['NETWORK_FETCH'] },
      audience: { mission_id: 'MSN-A', task_id: 'task-1' },
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      issued_by: 'test',
      issued_at: new Date(Date.now() - 120_000).toISOString(),
    };
    safeAppendFileSync(storePath, `${JSON.stringify(expired)}\n`);
    expect(resolveIdentityContext().authorities).not.toContain('NETWORK_FETCH');
  });

  it('never translates SUDO from a grant capability', () => {
    issueGoverned({ scope: { capabilities: ['SUDO', 'SECRET_READ'] } });
    process.env.MISSION_ID = 'MSN-A';
    process.env.TASK_ID = 'task-1';
    process.env.KYBERION_NHI_ID = GRANTEE;
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'software_developer';

    const context = resolveIdentityContext();
    expect(context.authorities).toContain('SECRET_READ');
    expect(context.authorities).not.toContain('SUDO');
  });
});
