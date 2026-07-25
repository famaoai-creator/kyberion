import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findDuplicateHintsSections,
  PERSISTENT_TIER_FIXTURE_PATTERNS,
  scanPersistentTierFixturePollution,
  type Violation,
} from '../scripts/check_tier_hygiene.js';

/**
 * KP-07: hermetic coverage for the persistent-tier (knowledge/personal/,
 * knowledge/confidential/) test-fixture pollution detector added to KM-04's
 * check_tier_hygiene.ts.
 *
 * These tests deliberately do NOT scan the real `knowledge/` tree — that
 * directory is per-machine local state (gitignored, and additionally
 * role-gated by secure-io's "Sovereign Sanctuary" check), so asserting on
 * it here would (a) not be hermetic — pass/fail would hinge on whatever a
 * given sandbox's onboarding state happens to be — and (b) collide with
 * other agents/processes sharing this checkout. See
 * scripts/check_tier_hygiene.ts's `scan()` for why the persistent-tier scan
 * is intentionally not wired into the shared `pnpm check:tier-hygiene` gate,
 * and STATUS.md for the current real-tree pollution inventory.
 *
 * Instead, every test builds its own isolated fixture directory under
 * `active/shared/tmp/` (the sanctioned temp-file location — see AGENTS.md
 * §1) and calls the scan functions directly against it, using rel-paths
 * that *read* as `knowledge/personal/...` / `knowledge/confidential/...` to
 * exercise the real pattern matching without touching anything under the
 * repo's actual `knowledge/` directory.
 */

const FIXTURE_ROOT = path.join(
  process.cwd(),
  'active',
  'shared',
  'tmp',
  `kp07-knowledge-store-purity-${process.pid}`
);

function writeFixture(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

afterEach(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe('scanPersistentTierFixturePollution (KP-07)', () => {
  it('fails on a seeded persistent-tier pollution fixture', () => {
    writeFixture(
      FIXTURE_ROOT,
      'knowledge/personal/my-identity.json',
      JSON.stringify({ sovereign: 'test', initialized_at: '2026-07-24T20:20:37.891Z' }, null, 2)
    );
    writeFixture(
      FIXTURE_ROOT,
      'knowledge/confidential/common/operations/generated/MEM-PROBE.json',
      JSON.stringify(
        { evidence_refs: ['active/missions/MSN-TEST-PURITY-PROBE/evidence/ledger.jsonl'] },
        null,
        2
      )
    );

    const files = [
      'knowledge/personal/my-identity.json',
      'knowledge/confidential/common/operations/generated/MEM-PROBE.json',
    ];
    const violations: Violation[] = scanPersistentTierFixturePollution(FIXTURE_ROOT, files);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.pattern === 'sovereign-test-placeholder')).toBe(true);
    expect(violations.some((v) => v.pattern === 'test-mission-slug')).toBe(true);
    expect(violations.every((v) => v.file === files[0] || v.file === files[1])).toBe(true);
  });

  it('passes on a clean persistent-tier fixture tree', () => {
    // Realistic (non-test) shaped content: no MSN-TEST-* slug, no
    // {"sovereign":"test"} placeholder.
    writeFixture(
      FIXTURE_ROOT,
      'knowledge/personal/my-identity.json',
      JSON.stringify(
        { sovereign: 'operator-alpha', initialized_at: '2026-06-01T00:00:00.000Z' },
        null,
        2
      )
    );
    writeFixture(
      FIXTURE_ROOT,
      'knowledge/confidential/tenants/index.json',
      JSON.stringify({ tenants: [] }, null, 2)
    );
    // A file outside the persistent tier / HINTS.md should never be
    // scanned even if it happens to contain the substrings.
    writeFixture(
      FIXTURE_ROOT,
      'knowledge/public/example.md',
      'Example doc mentioning MSN-TEST-NOT-SCANNED and "sovereign": "test" in prose.'
    );

    const files = [
      'knowledge/personal/my-identity.json',
      'knowledge/confidential/tenants/index.json',
      'knowledge/public/example.md',
    ];
    const violations = scanPersistentTierFixturePollution(FIXTURE_ROOT, files);

    expect(violations).toEqual([]);
  });

  it('flags the HINTS.md path specifically, independent of the personal/confidential prefix', () => {
    writeFixture(
      FIXTURE_ROOT,
      'knowledge/product/governance/HINTS.md',
      [
        '# Operational Hints',
        '',
        '## MEM-AAA (2026-07-01)',
        '',
        'Duplicate hint body.',
        '',
        'source_ref: MEM-AAA',
        'evidence_refs:',
        '',
        '- active/missions/MSN-TEST-DUP/evidence/ledger.jsonl',
        '',
        '## MEM-BBB (2026-07-02)',
        '',
        'Duplicate hint body.',
        '',
        'source_ref: MEM-BBB',
        'evidence_refs:',
        '',
        '- active/missions/MSN-TEST-DUP/evidence/ledger.jsonl',
        '',
      ].join('\n')
    );

    const files = ['knowledge/product/governance/HINTS.md'];
    const violations = scanPersistentTierFixturePollution(FIXTURE_ROOT, files);

    expect(violations.some((v) => v.pattern === 'test-mission-slug')).toBe(true);
    expect(violations.some((v) => v.pattern === 'duplicate-hints-section')).toBe(true);
  });

  it('declares both fixture patterns as exported, documented constants', () => {
    expect(PERSISTENT_TIER_FIXTURE_PATTERNS.map((p) => p.name)).toEqual([
      'test-mission-slug',
      'sovereign-test-placeholder',
    ]);
  });
});

describe('findDuplicateHintsSections (KP-07)', () => {
  it('groups sections whose body is identical apart from the header id and source_ref line', () => {
    const content = [
      '# Operational Hints',
      '',
      '## MEM-ONE (2026-07-01)',
      '',
      'Reusable weekly review note.',
      '',
      'source_ref: MEM-ONE',
      'evidence_refs:',
      '',
      '- active/missions/MSN-TEST-AUTOPROMOTE/evidence/ledger.jsonl',
      '',
      '## MEM-TWO (2026-07-02)',
      '',
      'Reusable weekly review note.',
      '',
      'source_ref: MEM-TWO',
      'evidence_refs:',
      '',
      '- active/missions/MSN-TEST-AUTOPROMOTE/evidence/ledger.jsonl',
      '',
      '## MEM-THREE (2026-07-03)',
      '',
      'A genuinely different hint.',
      '',
      'source_ref: MEM-THREE',
      '',
    ].join('\n');

    const groups = findDuplicateHintsSections(content);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].headers).toEqual(['MEM-ONE (2026-07-01)', 'MEM-TWO (2026-07-02)']);
  });

  it('returns no groups when every section is unique', () => {
    const content = [
      '## MEM-ONE (2026-07-01)',
      '',
      'First hint.',
      '',
      'source_ref: MEM-ONE',
      '',
      '## MEM-TWO (2026-07-02)',
      '',
      'Second hint.',
      '',
      'source_ref: MEM-TWO',
      '',
    ].join('\n');

    expect(findDuplicateHintsSections(content)).toEqual([]);
  });
});
