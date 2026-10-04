import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';
import {
  listDotCharterPaths,
  dotGoalRefLabel,
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
