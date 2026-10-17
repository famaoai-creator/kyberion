import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { runOpsHealthProbe, OPS_FINDINGS_PATH, OPS_ALERTS_PATH } from './ops-health-probe.js';

const TEST_ROOT = 'active/shared/tmp/ops-health-probe-tests';

describe('ops-health-probe', () => {
  it('flags a dominant dedupe key in ops-alerts (alert fatigue detector)', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    const alertsPath = path.join(TEST_ROOT, OPS_ALERTS_PATH);
    safeMkdir(path.dirname(alertsPath), { recursive: true });
    const lines = [
      ...Array.from({ length: 15 }, () =>
        JSON.stringify({
          kind: 'ops_alert',
          dedupe_key: 'watchdog:chronos:stale',
          severity: 'critical',
          title: 'x',
        })
      ),
      ...Array.from({ length: 5 }, () =>
        JSON.stringify({
          kind: 'ops_alert',
          dedupe_key: 'other:thing',
          severity: 'info',
          title: 'y',
        })
      ),
    ];
    safeWriteFile(alertsPath, lines.join('\n') + '\n');

    const res = runOpsHealthProbe({ rootDir: TEST_ROOT });
    const dominance = res.findings.filter((f) => f.kind === 'alert_dominance');
    expect(dominance.length).toBe(1);
    expect(dominance[0]!.evidence.dedupe_key).toBe('watchdog:chronos:stale');
    expect(safeExistsSync(path.join(pathResolver.rootDir(), TEST_ROOT, OPS_FINDINGS_PATH))).toBe(
      true
    );
  });

  it('files findings addressed to the ops dot so the executor can claim them', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    const alertsPath = path.join(TEST_ROOT, OPS_ALERTS_PATH);
    safeMkdir(path.dirname(alertsPath), { recursive: true });
    safeWriteFile(
      alertsPath,
      Array.from({ length: 20 }, () =>
        JSON.stringify({
          id: 'a',
          title: 'x',
          dedupe_key: 'watchdog:x:stale',
          severity: 'critical',
        })
      ).join('\n') + '\n'
    );

    const res = runOpsHealthProbe({ rootDir: TEST_ROOT, fileWorkItems: true });
    expect(res.work_items_filed.length).toBeGreaterThan(0);

    const itemsFile = path.join(TEST_ROOT, 'active/shared/runtime/work-coordination/items.jsonl');
    expect(safeExistsSync(itemsFile)).toBe(true);
    const item = JSON.parse(
      safeReadFile(itemsFile, { encoding: 'utf8' }).toString().trim().split('\n').pop()!
    );
    // Without these the item is never claimed: addressedTo() keys on
    // metadata.dot_id / handoff_to and the executor routes by work shape.
    expect(item.metadata?.dot_id).toBe('org-operations');
    expect(item.metadata?.requested_work_shape).toBe('direct_reply');
  });

  it('does not file findings on a healthy store set', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    safeMkdir(TEST_ROOT, { recursive: true });
    const res = runOpsHealthProbe({ rootDir: TEST_ROOT });
    expect(res.findings.every((f) => f.kind !== 'alert_dominance')).toBe(true);
  });
});
