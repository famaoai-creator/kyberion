import { afterEach, describe, expect, it } from 'vitest';
import {
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeRmSync,
  safeExistsSync,
} from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import type { DotCharter } from './dot-charter.js';
import {
  dotMemoryPath,
  dotStatePath,
  orgKrLedgerPath,
  migrateLegacyDotState,
  assertDotStateLayoutReady,
} from './dot-state-paths.js';
const ROOT = 'active/shared/tmp/dot-layout-migration-test';
afterEach(() => safeRmSync(ROOT, { recursive: true, force: true }));

const charter = (scope: DotCharter['scope']) => ({ dot_id: 'demo-dot', scope }) as DotCharter;

describe('dotStatePath', () => {
  it('blocks unknown legacy origins and preserves state through explicit reviewed replayable migration', () => {
    const c = charter({ tier: 'public' });
    const source = `${ROOT}/active/shared/runtime/dot/memory/demo-dot.json`;
    safeMkdir(`${ROOT}/active/shared/runtime/dot/memory`, { recursive: true });
    safeWriteFile(source, '{"lesson":"synthetic"}');
    expect(() => assertDotStateLayoutReady(c, ROOT)).toThrow('DOT_STATE_MIGRATION_REQUIRED');
    const migrate = (scope = c.scope) =>
      withExecutionContext('sovereign', () => migrateLegacyDotState(c, scope, ROOT), 'sovereign');
    expect(() => migrate({ tier: 'confidential', tenant_slug: 'acme' })).toThrow(
      'DOT_STATE_MIGRATION_SCOPE'
    );
    expect(migrate().moved).toContain('memory');
    expect(String(safeReadFile(`${ROOT}/${dotMemoryPath(c)}`))).toContain('synthetic');
    expect(() => assertDotStateLayoutReady(c, ROOT)).not.toThrow();
    expect(migrate().moved).toEqual([]);
  });
  it('places untenanted dots directly under the dot domain', () => {
    expect(dotStatePath(charter({ tier: 'public' }), 'work-results.jsonl')).toBe(
      'active/shared/runtime/dot/public/shared/work-results.jsonl'
    );
  });
  it('moves only selected dot records from a mixed legacy public and personal root', () => {
    const c = charter({ tier: 'public' });
    const base = `${ROOT}/active/shared/runtime/dot`;
    safeMkdir(`${base}/memory`, { recursive: true });
    safeWriteFile(`${base}/memory/personal-dot.json`, '{"secret":"private-memory"}');
    safeWriteFile(
      `${base}/work-results.jsonl`,
      [
        JSON.stringify({ dot_id: c.dot_id, summary: 'public result' }),
        JSON.stringify({ dot_id: 'personal-dot', summary: 'private result' }),
      ].join('\n') + '\n'
    );
    withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign');
    expect(String(safeReadFile(`${ROOT}/${dotStatePath(c, 'work-results.jsonl')}`))).toContain(
      'public result'
    );
    expect(String(safeReadFile(`${ROOT}/${dotStatePath(c, 'work-results.jsonl')}`))).not.toContain(
      'private result'
    );
    expect(String(safeReadFile(`${base}/work-results.jsonl`))).toContain('private result');
    expect(String(safeReadFile(`${base}/work-results.jsonl`))).not.toContain('public result');
    expect(String(safeReadFile(`${base}/memory/personal-dot.json`))).toContain('private-memory');
    expect(() => assertDotStateLayoutReady(c, ROOT)).not.toThrow();
  });
  it('rejects unowned aggregate records before moving any private material', () => {
    const c = charter({ tier: 'public' });
    const base = `${ROOT}/active/shared/runtime/dot`;
    safeMkdir(base, { recursive: true });
    safeWriteFile(
      `${base}/work-results.jsonl`,
      JSON.stringify({ summary: 'unknown private origin' }) + '\n'
    );
    expect(() =>
      withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign')
    ).toThrow('DOT_STATE_MIGRATION_OWNERSHIP');
    expect(String(safeReadFile(`${base}/work-results.jsonl`))).toContain('unknown private origin');
    safeWriteFile(
      `${base}/work-results.jsonl`,
      JSON.stringify({
        dot_id: c.dot_id,
        scope: { tier: 'personal', owner_nhi: 'owner-a' },
        summary: 'tagged private origin',
      }) + '\n'
    );
    expect(() =>
      withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign')
    ).toThrow('DOT_STATE_MIGRATION_SCOPE');
  });
  it('merges two reviewed dots in one destination without replacing the first dot', () => {
    const a = charter({ tier: 'public' });
    const b = { ...a, dot_id: 'second-dot' };
    const base = `${ROOT}/active/shared/runtime/dot`;
    safeMkdir(base, { recursive: true });
    safeWriteFile(
      `${base}/work-results.jsonl`,
      [a, b]
        .map((c) => JSON.stringify({ dot_id: c.dot_id, at: 't1', summary: c.dot_id }))
        .join('\n') + '\n'
    );
    const migrate = (c: DotCharter) =>
      withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign');
    migrate(a);
    migrate(b);
    const dest = `${ROOT}/${dotStatePath(a, 'work-results.jsonl')}`;
    const rows = String(safeReadFile(dest))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.map((r) => r.dot_id)).toEqual([a.dot_id, b.dot_id]);
    expect(rows.every((r) => r.scope.tier === 'public')).toBe(true);
    safeWriteFile(
      `${base}/work-results.jsonl`,
      JSON.stringify({ dot_id: b.dot_id, at: 't1', summary: b.dot_id }) + '\n'
    );
    migrate(b);
    expect(String(safeReadFile(dest)).trim().split('\n')).toHaveLength(2);
    safeMkdir(`${base}/memory`, { recursive: true });
    safeWriteFile(`${base}/memory/${b.dot_id}.json`, '{"kept":true}');
    safeWriteFile(
      `${base}/work-results.jsonl`,
      JSON.stringify({ dot_id: b.dot_id, at: 't1', summary: 'conflict' }) + '\n'
    );
    expect(() => migrate(b)).toThrow('DOT_STATE_MIGRATION_CONFLICT');
    expect(String(safeReadFile(`${base}/memory/${b.dot_id}.json`))).toContain('kept');
    expect(safeExistsSync(`${ROOT}/${dotMemoryPath(b)}`)).toBe(false);
  });
  it('places tenant dots under the physical tenant namespace', () => {
    expect(
      dotStatePath(
        charter({ tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' }),
        'memory',
        'x.json'
      )
    ).toBe('active/shared/runtime/dot/confidential/acme/organizations/org-1/memory/x.json');
    expect(dotMemoryPath(charter({ tier: 'confidential', tenant_slug: 'acme' }))).toBe(
      'active/shared/runtime/dot/confidential/acme/memory/demo-dot.json'
    );
  });
  it('never aliases tiers or personal owners', () => {
    expect(
      orgKrLedgerPath({ tier: 'personal', ownerNhi: 'owner-a', organizationId: 'org-1' })
    ).toContain('/personal/shared/owners/');
    expect(
      orgKrLedgerPath({ tier: 'personal', ownerNhi: 'owner-a', organizationId: 'org-1' })
    ).not.toBe(orgKrLedgerPath({ tier: 'personal', ownerNhi: 'owner-b', organizationId: 'org-1' }));
    const scope = { tenant_slug: 'acme', organization_id: 'org-1' };
    const paths = [
      dotMemoryPath(charter({ ...scope, tier: 'public' })),
      dotMemoryPath(charter({ ...scope, tier: 'confidential' })),
      dotMemoryPath(charter({ ...scope, tier: 'personal', owner_nhi: 'owner-a' })),
      dotMemoryPath(charter({ ...scope, tier: 'personal', owner_nhi: 'owner-b' })),
    ];
    expect(new Set(paths).size).toBe(4);
    expect(() => dotMemoryPath(charter({ tier: 'personal' }))).toThrow('owner_nhi');
  });
});
