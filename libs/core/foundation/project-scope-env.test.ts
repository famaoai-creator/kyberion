import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { resolveProjectScope } from './project-scope-env.js';

const scopePath = pathResolver.sharedTmp('project-scope-env-test.env');
const scopedKeys = [
  'KYBERION_PROJECT_ID',
  'KYBERION_TENANT',
  'MISSION_ID',
  'KYBERION_TASK_ID',
  'KYBERION_SCOPE_ENV_PATH',
] as const;

const previousEnvironment = new Map(scopedKeys.map((key) => [key, process.env[key]]));

describe('persisted project scope environment', () => {
  beforeEach(() => {
    safeRmSync(scopePath, { force: true });
    process.env.KYBERION_SCOPE_ENV_PATH = scopePath;
    for (const key of scopedKeys.slice(0, -1)) delete process.env[key];
  });

  afterEach(() => {
    safeRmSync(scopePath, { force: true });
    for (const key of scopedKeys) {
      const previous = previousEnvironment.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('reads persisted tenant, project, mission, and task bindings', () => {
    safeWriteFile(
      scopePath,
      [
        'KYBERION_TENANT=acme-corp',
        'KYBERION_PROJECT_ID=PRJ-SCOPE-ENV',
        'MISSION_ID=MSN-SCOPE-ENV',
        'KYBERION_TASK_ID=TASK-SCOPE-ENV',
        '',
      ].join('\n')
    );

    expect(resolveProjectScope()).toEqual({
      projectId: 'PRJ-SCOPE-ENV',
      tenantSlug: 'acme-corp',
      missionId: 'MSN-SCOPE-ENV',
      taskId: 'TASK-SCOPE-ENV',
    });
  });

  it('lets valid environment bindings override persisted scope values', () => {
    safeWriteFile(
      scopePath,
      'KYBERION_TENANT=acme-corp\nKYBERION_PROJECT_ID=PRJ-PERSISTED\nMISSION_ID=MSN-PERSISTED\nKYBERION_TASK_ID=TASK-PERSISTED\n'
    );
    process.env.KYBERION_TENANT = 'beta-co';
    process.env.KYBERION_PROJECT_ID = 'PRJ-ENV';
    process.env.MISSION_ID = 'MSN-ENV';
    process.env.KYBERION_TASK_ID = 'TASK-ENV';

    expect(resolveProjectScope()).toEqual({
      projectId: 'PRJ-ENV',
      tenantSlug: 'beta-co',
      missionId: 'MSN-ENV',
      taskId: 'TASK-ENV',
    });
  });
});
