import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planAuditMirrorMove, planTenantHomeMoves, relabelSource } from './0002-tenant-home.js';

describe('0002-tenant-home migration plan', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('moves company files and the audit mirror, and leaves deals in place', () => {
    // secure-io only reads inside the repository: keep the fixture on the scratch floor.
    fs.mkdirSync(path.join(process.cwd(), 'active/shared/tmp'), { recursive: true });
    root = fs.mkdtempSync(path.join(process.cwd(), 'active/shared/tmp/tenant-home-'));
    const legacy = path.join(root, 'customer', 'acme');
    for (const dir of ['deals/d1', 'logs/audit', 'brand', 'design', 'finance', 'connections'])
      fs.mkdirSync(path.join(legacy, dir), { recursive: true });
    for (const file of [
      'customer.json',
      'vision.md',
      'org-chart.json',
      'organization-profile.json',
      'okr.json',
      'decision-rights.json',
      'connections/channel-bindings.json',
      'connections/slack.json',
      'logs/audit/audit-2026-11-05.jsonl',
    ])
      fs.writeFileSync(path.join(legacy, file), '{}');

    const moves = planTenantHomeMoves('acme', root).map((move) => ({
      from: path.relative(root, move.from),
      to: path.relative(root, move.to),
    }));
    const home = 'knowledge/confidential/acme';
    expect(moves).toEqual([
      { from: 'customer/acme/brand', to: `${home}/brand` },
      {
        from: 'customer/acme/connections/channel-bindings.json',
        to: `${home}/connections/channel-bindings.json`,
      },
      { from: 'customer/acme/customer.json', to: `${home}/company.json` },
      { from: 'customer/acme/decision-rights.json', to: `${home}/decision-rights.json` },
      { from: 'customer/acme/design', to: `${home}/design` },
      { from: 'customer/acme/finance', to: `${home}/finance` },
      { from: 'customer/acme/okr.json', to: `${home}/okr.json` },
      { from: 'customer/acme/org-chart.json', to: `${home}/org-chart.json` },
      { from: 'customer/acme/organization-profile.json', to: `${home}/organization-profile.json` },
      { from: 'customer/acme/vision.md', to: `${home}/vision.md` },
    ]);
    const moved = moves.map((move) => move.from).join('\n');
    for (const kept of ['deals', 'slack.json', 'logs']) expect(moved).not.toContain(kept);

    const mirror = planAuditMirrorMove('acme', root);
    expect(mirror && path.relative(root, mirror.from)).toBe('customer/acme/logs/audit');
    expect(mirror && path.relative(root, mirror.to)).toBe(
      'active/shared/runtime/audit-mirror/confidential/acme'
    );
  });

  it('relabels a moved record from the customer source kind to its tenant home path', () => {
    const chart: Record<string, unknown> = {
      source_kind: 'customer',
      source_path: 'customer/acme/org-chart.json',
      name: 'Acme',
    };
    expect(relabelSource(chart, 'acme')).toBe(true);
    expect(chart).toEqual({
      source_kind: 'confidential',
      source_path: 'knowledge/confidential/acme/org-chart.json',
      name: 'Acme',
    });
    const other: Record<string, unknown> = { source_kind: 'public', source_path: 'x.json' };
    expect(relabelSource(other, 'acme')).toBe(false);
    expect(other).toEqual({ source_kind: 'public', source_path: 'x.json' });
  });
});
