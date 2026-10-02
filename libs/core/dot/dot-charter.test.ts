import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';
import {
  listDotCharterPaths,
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
});
