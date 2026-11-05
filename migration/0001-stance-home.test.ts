import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planStanceMoves } from './0001-stance-home.js';

describe('0001-stance-home migration plan', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('moves stance entries and traces, and leaves the tenant files in place', () => {
    // secure-io only reads inside the repository: keep the fixture on the scratch floor.
    fs.mkdirSync(path.join(process.cwd(), 'active/shared/tmp'), { recursive: true });
    root = fs.mkdtempSync(path.join(process.cwd(), 'active/shared/tmp/stance-home-'));
    const legacy = path.join(root, 'customer', 'acme');
    for (const dir of [
      'policy',
      'voice',
      'connections',
      'deals',
      'logs/traces',
      'logs/audit',
      'brand',
    ])
      fs.mkdirSync(path.join(legacy, dir), { recursive: true });
    for (const file of [
      'identity.json',
      'organization-profile.json',
      'customer.json',
      'vision.md',
      'org-chart.json',
      'connections/slack.json',
      'connections/channel-bindings.json',
    ])
      fs.writeFileSync(path.join(legacy, file), '{}');

    const moves = planStanceMoves('acme', root).map((move) => ({
      from: path.relative(root, move.from),
      to: path.relative(root, move.to),
    }));

    expect(moves).toEqual([
      {
        from: 'customer/acme/connections/slack.json',
        to: 'knowledge/personal/stances/acme/connections/slack.json',
      },
      { from: 'customer/acme/identity.json', to: 'knowledge/personal/stances/acme/identity.json' },
      { from: 'customer/acme/logs/traces', to: 'active/shared/logs/stances/acme/traces' },
      { from: 'customer/acme/policy', to: 'knowledge/personal/stances/acme/policy' },
      { from: 'customer/acme/voice', to: 'knowledge/personal/stances/acme/voice' },
    ]);
    const moved = moves.map((move) => move.from).join('\n');
    for (const tenantFile of [
      'organization-profile.json',
      'customer.json',
      'vision.md',
      'org-chart.json',
      'deals',
      'brand',
      'logs/audit',
      'channel-bindings.json',
    ])
      expect(moved).not.toContain(tenantFile);
  });
});
