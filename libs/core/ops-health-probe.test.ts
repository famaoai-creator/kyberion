import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  runOpsHealthProbe,
  probeStoreOvergrowth,
  probeStaleCompactionCopies,
  STALE_COMPACTION_COPY_MS,
  storeActionThreshold,
  OPS_FINDINGS_PATH,
  OPS_ALERTS_PATH,
} from './ops-health-probe.js';
import { DEFAULT_COMPACT_MIN_BYTES, DEFAULT_ROTATE_MIN_BYTES } from './storage-retention-expiry.js';

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
    expect(dominance[0]!.evidence.source).toBe('watchdog');
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

  it('tolerates a torn alert line instead of failing the probe', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    const alertsPath = path.join(TEST_ROOT, OPS_ALERTS_PATH);
    safeMkdir(path.dirname(alertsPath), { recursive: true });
    const row = JSON.stringify({ kind: 'ops_alert', dedupe_key: 'noisy:x', title: 't' });
    safeWriteFile(
      alertsPath,
      `${Array.from({ length: 20 }, () => row).join('\r\n')}\r\n{"kind":"ops_al`
    );
    const res = runOpsHealthProbe({ rootDir: TEST_ROOT });
    const dominance = res.findings.filter((f) => f.kind === 'alert_dominance');
    expect(dominance.map((f) => f.evidence.source)).toEqual(['noisy']);
  });

  it('flags oversized .jsonl files inside review_required runtime directories', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    const dir = path.join(TEST_ROOT, 'active/shared/runtime/mesh-hub/tenant-a');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'presence.jsonl'), 'x'.repeat(2048));
    safeWriteFile(path.join(dir, 'small.jsonl'), 'x'.repeat(10));
    safeWriteFile(path.join(dir, 'blob.bin'), 'x'.repeat(4096));

    const findings = probeStoreOvergrowth({ rootDir: TEST_ROOT, reviewRequiredMaxBytes: 1024 });
    const paths = findings.map((f) => f.evidence.path);
    expect(paths).toEqual(['active/shared/runtime/mesh-hub/tenant-a/presence.jsonl']);
    expect(findings[0]!.evidence.catalog_path).toBe('active/shared/runtime/mesh-hub');
    expect(findings[0]!.kind).toBe('store_overgrowth');

    // Below the ceiling nothing is reported.
    expect(probeStoreOvergrowth({ rootDir: TEST_ROOT, reviewRequiredMaxBytes: 4096 })).toEqual([]);
  });

  it("uses the janitor's default threshold for rotate/compact entries without one", () => {
    expect(storeActionThreshold({ path: 'a.jsonl', artifact_class: 'log', action: 'rotate' })).toBe(
      DEFAULT_ROTATE_MIN_BYTES
    );
    expect(
      storeActionThreshold({
        path: 'a.jsonl',
        artifact_class: 'log',
        action: 'rotate',
        rotate_min_bytes: 5,
      })
    ).toBe(5);
    expect(
      storeActionThreshold({ path: 'a.jsonl', artifact_class: 'log', action: 'compact' })
    ).toBe(DEFAULT_COMPACT_MIN_BYTES);
    expect(
      storeActionThreshold({ path: 'd', artifact_class: 'log', action: 'review_required' })
    ).toBeUndefined();
  });
  it('flags leftover .compacting-* copies older than an hour, not fresh ones', () => {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    const dir = path.join(TEST_ROOT, 'active/shared/runtime/store-x');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'items.jsonl.compacting-t000000000000001-000000-1-a'), '{}\n');
    safeWriteFile(path.join(dir, 'items.jsonl'), '{}\n');
    const later = new Date(Date.now() + STALE_COMPACTION_COPY_MS + 60_000);
    const findings = probeStaleCompactionCopies({ rootDir: TEST_ROOT, now: () => later });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('stale_compaction_copy');
    expect(findings[0].evidence.path).toBe(
      'active/shared/runtime/store-x/items.jsonl.compacting-t000000000000001-000000-1-a'
    );
    expect(probeStaleCompactionCopies({ rootDir: TEST_ROOT })).toEqual([]);
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
  });
});
