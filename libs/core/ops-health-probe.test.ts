import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
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
    expect(fs.existsSync(path.join(pathResolver.rootDir(), TEST_ROOT, OPS_FINDINGS_PATH))).toBe(
      true
    );
  });

  it('does not file findings on a healthy store set', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    safeMkdir(TEST_ROOT, { recursive: true });
    const res = runOpsHealthProbe({ rootDir: TEST_ROOT });
    expect(res.findings.every((f) => f.kind !== 'alert_dominance')).toBe(true);
  });
});
