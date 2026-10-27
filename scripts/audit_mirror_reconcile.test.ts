import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { collectAuditMirrorFindings } from './audit_mirror_reconcile.js';

const ROOT = pathResolver.sharedTmp('audit-mirror-reconcile-test');
const MASTER = `${ROOT}/active/shared/logs/audit/audit-2026-07-01.jsonl`;
const MIRROR = `${ROOT}/customer/acme/logs/audit/audit-2026-07-01.jsonl`;

function entry(id: string, previousHash: string) {
  return {
    id,
    timestamp: '2026-07-01T10:00:00.000Z',
    agentId: 'agent-1',
    action: 'act',
    operation: 'op',
    result: 'completed',
    tenantSlug: 'acme',
    previousHash,
    currentHash: `${id}-hash`,
  };
}

const lines = (...values: Array<string | object>) =>
  values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') +
  '\n';

describe('audit mirror reconcile findings', () => {
  afterEach(() => safeRmSync(ROOT, { recursive: true, force: true }));

  function fixture(master: string, mirror: string) {
    safeMkdir(`${ROOT}/customer/acme/logs/audit`, { recursive: true });
    safeWriteFile(MASTER, master);
    safeWriteFile(MIRROR, mirror);
  }

  it('turns an unreadable mirror line into a rebuild finding instead of throwing', () => {
    const a = entry('AUD-A', '0'.repeat(64));
    const b = entry('AUD-B', a.currentHash);
    fixture(lines(a, b), lines(a, 'not json', b));

    expect(collectAuditMirrorFindings(ROOT)).toEqual([
      expect.objectContaining({
        slug: 'acme',
        reason: 'mirror_unreadable',
        action: 'quarantine_and_rebuild',
        unreadable_lines: 1,
        mirror_count: 2,
        master_count: 2,
      }),
    ]);
  });

  it('reads the master leniently: an unreadable master line hides only itself', () => {
    const a = entry('AUD-A', '0'.repeat(64));
    const b = entry('AUD-B', a.currentHash);
    fixture(lines(a, '{"x":', b), lines(a, b));

    expect(collectAuditMirrorFindings(ROOT)).toEqual([]);
  });
});
