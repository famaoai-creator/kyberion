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
  it('relocates a per-dot wake-circuit file and leaves a neighbour dot circuit in place', () => {
    const c = charter({ tier: 'public' });
    const legacy = `${ROOT}/active/shared/runtime/dot/wake-circuit`;
    safeMkdir(legacy, { recursive: true });
    safeWriteFile(`${legacy}/demo-dot.json`, '{"state":"open"}');
    safeWriteFile(`${legacy}/other-dot.json`, '{"state":"closed"}');
    expect(() => assertDotStateLayoutReady(c, ROOT)).toThrow('DOT_STATE_MIGRATION_REQUIRED');
    const result = withExecutionContext(
      'sovereign',
      () => migrateLegacyDotState(c, c.scope, ROOT),
      'sovereign'
    );
    expect(result.moved).toContain('wake-circuit');
    expect(
      String(safeReadFile(`${ROOT}/${dotStatePath(c, 'wake-circuit', 'demo-dot.json')}`))
    ).toContain('open');
    expect(String(safeReadFile(`${legacy}/other-dot.json`))).toContain('closed');
    expect(() => assertDotStateLayoutReady(c, ROOT)).not.toThrow();
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
  it('keeps append-only history rows that share an identity and replays without duplicating', () => {
    const c = charter({ tier: 'public' });
    const base = `${ROOT}/active/shared/runtime/dot`;
    safeMkdir(base, { recursive: true });
    const history = [
      { dot_id: c.dot_id, key: 'daily', scheduled_at: 't1', status: 'pending', attempts: 0 },
      { dot_id: c.dot_id, key: 'daily', scheduled_at: 't1', status: 'sent', attempts: 1 },
    ];
    const source = history.map((row) => JSON.stringify(row)).join('\n') + '\n';
    safeWriteFile(`${base}/digest-ledger.jsonl`, source);
    const migrate = () =>
      withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign');
    migrate();
    const dest = `${ROOT}/${dotStatePath(c, 'digest-ledger.jsonl')}`;
    const statuses = () =>
      String(safeReadFile(dest))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).status);
    expect(statuses()).toEqual(['pending', 'sent']);
    safeWriteFile(`${base}/digest-ledger.jsonl`, source);
    migrate();
    expect(statuses()).toEqual(['pending', 'sent']);
  });
  it('keeps a KR row domain `scope` value and merges with rows the runtime already wrote', () => {
    const c = charter({ tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' });
    const legacy = `${ROOT}/active/shared/runtime/dot/tenants/acme/organizations/org-1`;
    safeMkdir(legacy, { recursive: true });
    const kr = (at: string) =>
      JSON.stringify({ scope: 'dot', dot_id: c.dot_id, kr_id: 'k', value: 0, measured_at: at });
    safeWriteFile(`${legacy}/kr-ledger.jsonl`, kr('t1') + '\n');
    const dest = `${ROOT}/${dotStatePath(c, 'kr-ledger.jsonl')}`;
    safeMkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
    safeWriteFile(dest, kr('t2') + '\n');
    withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign');
    const rows = String(safeReadFile(dest))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.map((r) => [r.measured_at, r.scope])).toEqual([
      ['t2', 'dot'],
      ['t1', 'dot'],
    ]);
  });
  it('migrates owned org cadence state and lets a live destination copy supersede it', () => {
    const c = charter({ tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' });
    const legacy = `${ROOT}/active/shared/runtime/dot/tenants/acme/organizations/org-1`;
    const dest = `${ROOT}/${dotStatePath(c, 'org-cadence.json')}`;
    const migrate = () =>
      withExecutionContext('sovereign', () => migrateLegacyDotState(c, c.scope, ROOT), 'sovereign');
    safeMkdir(legacy, { recursive: true });
    safeWriteFile(`${legacy}/org-cadence.json`, '{"dot_id":"other-dot","tick":{}}');
    expect(() => migrate()).toThrow('DOT_STATE_MIGRATION_OWNERSHIP');
    safeWriteFile(
      `${legacy}/org-cadence.json`,
      '{"dot_id":"demo-dot","tick":{"last_run_at":"t1"}}'
    );
    migrate();
    expect(String(safeReadFile(dest))).toContain('"t1"');
    safeWriteFile(
      `${legacy}/org-cadence.json`,
      '{"dot_id":"demo-dot","tick":{"last_run_at":"t0"}}'
    );
    safeWriteFile(dest, '{"dot_id":"demo-dot","tick":{"last_run_at":"t2"}}');
    migrate();
    expect(String(safeReadFile(dest))).toContain('"t2"');
    expect(safeExistsSync(`${legacy}/org-cadence.json`)).toBe(false);
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
