import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendActionRecord,
  currentDotActions,
  observeDotActions,
  readDotActionLedger,
  latestDotActions,
  migrateLegacyDotActions,
  DOT_ACTION_LEDGER_PATH,
  type DotActionRecord,
} from './dot-action-ledger.js';
import { dotStatePath } from './dot-state-paths.js';
import { safeReadFile, safeRmSync, safeMkdir } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import { withExecutionContext } from '../authority.js';

const rootDir = 'active/shared/tmp/dot-private-action-ledger-tests';
afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('private Dot action evidence', () => {
  it('does not hydrate another personal owner even under a privileged role', () => {
    const record: DotActionRecord = {
      scope: { tier: 'personal', owner_nhi: 'owner-a' },
      action_ref: 'personal-action',
      dot_id: 'personal-dot',
      actor_id: 'dot:personal-dot',
      action_id: 'repair',
      title: 'personal-secret',
      objective: 'private objective',
      work_shape: 'pipeline',
      status: 'admitted',
      proposal_hash: 'hash',
      at: '2026-10-26T00:00:00Z',
    };
    vi.stubEnv('KYBERION_NHI_ID', 'owner-a');
    appendActionRecord(record, { rootDir });
    expect(currentDotActions(record.dot_id, { rootDir })[0].title).toBe('personal-secret');
    vi.stubEnv('KYBERION_NHI_ID', 'owner-b');
    withExecutionContext(
      'sovereign',
      () => {
        expect(() => currentDotActions(record.dot_id, { rootDir })).toThrow('DOT_PERSONAL_OWNER');
        expect(latestDotActions({ rootDir })[0].title).toBe('[scoped action]');
      },
      'sovereign'
    );
  });
  it('does not treat legacy unscoped prose as public and requires reviewed operator adoption', () => {
    const scope = { tier: 'confidential' as const, tenant_slug: 'acme' };
    const raw: DotActionRecord = {
      action_ref: 'old',
      dot_id: 'old-dot',
      actor_id: 'dot:old-dot',
      action_id: 'repair',
      title: 'legacy-secret',
      objective: 'legacy-objective',
      work_shape: 'pipeline',
      status: 'parked',
      proposal_hash: 'hash',
      at: '2026-10-26T00:00:00Z',
    };
    safeMkdir(`${rootDir}/active/shared/runtime`, { recursive: true });
    appendJsonLine(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, raw);
    expect(readDotActionLedger({ rootDir })[0].title).toBe('[scoped action]');
    expect(() => currentDotActions(raw.dot_id, { rootDir })).toThrow(
      'DOT_ACTION_CONTENT_UNAVAILABLE'
    );
    const charter = { dot_id: raw.dot_id, scope } as never;
    const moved = withExecutionContext(
      'sovereign',
      () => migrateLegacyDotActions(charter, { rootDir }),
      'sovereign'
    );
    expect(moved).toBe(1);
    expect(currentDotActions(raw.dot_id, { rootDir })).toEqual([{ ...raw, scope }]);
    expect(String(safeReadFile(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`))).not.toContain(
      'legacy-secret'
    );
  });
  it('stores full proposals only in their tier namespace and requires that evidence to execute', () => {
    const record: DotActionRecord = {
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      action_ref: 'private-action',
      dot_id: 'private-dot',
      actor_id: 'dot:private-dot',
      action_id: 'repair',
      title: 'synthetic-private-title',
      objective: 'synthetic-private-objective',
      rationale: 'synthetic-private-rationale',
      target: 'synthetic-private-target',
      work_shape: 'pipeline',
      status: 'admitted',
      proposal_hash: 'hash',
      at: '2026-10-26T00:00:00Z',
    };
    appendActionRecord(record, { rootDir });
    const shared = String(safeReadFile(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`));
    for (const secret of [record.title, record.objective, record.rationale!, record.target!])
      expect(shared).not.toContain(secret);
    expect(readDotActionLedger({ rootDir })[0]).toMatchObject({
      title: '[scoped action]',
      status: 'admitted',
    });
    expect(currentDotActions(record.dot_id, { rootDir })).toEqual([record]);
    const scoped = `${rootDir}/${dotStatePath({ scope: record.scope! }, 'action-ledger.jsonl')}`;
    safeRmSync(scoped);
    expect(() => currentDotActions(record.dot_id, { rootDir })).toThrow(
      'DOT_ACTION_CONTENT_UNAVAILABLE'
    );
    expect(() => appendActionRecord(readDotActionLedger({ rootDir })[0], { rootDir })).toThrow(
      'shared index'
    );
  });
});

describe('observeDotActions (R07 status observation)', () => {
  const scopedRecord = (overrides: Partial<DotActionRecord> = {}): DotActionRecord => ({
    scope: { tier: 'confidential', tenant_slug: 'acme' },
    action_ref: 'ref-normal',
    dot_id: 'obs-dot',
    actor_id: 'dot:obs-dot',
    action_id: 'repair',
    title: 'scoped-secret-title',
    objective: 'scoped-secret-objective',
    work_shape: 'pipeline',
    status: 'admitted',
    proposal_hash: 'hash',
    at: '2026-10-26T00:00:00Z',
    ...overrides,
  });

  it('keeps permitted sections visible beside malformed and missing-evidence rows', () => {
    const normal = scopedRecord();
    const missing = scopedRecord({
      scope: { tier: 'confidential', tenant_slug: 'acme-missing' },
      action_ref: 'ref-missing',
    });
    appendActionRecord(normal, { rootDir });
    appendActionRecord(missing, { rootDir });
    // Corrupt private index: a non-hex content identity is malformed evidence.
    appendJsonLine(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, {
      dot_id: 'obs-dot',
      action_ref: 'ref-corrupt',
      private_content_hash: 'not-a-hex-digest',
      scope: { tier: 'confidential', tenant_slug: 'acme-missing' },
      actor_id: 'dot:obs-dot',
      action_id: 'repair',
      work_shape: 'pipeline',
      status: 'admitted',
      proposal_hash: 'hash',
      at: '2026-10-26T00:01:00Z',
    });
    // Drop the scoped evidence for `ref-missing`: the index row stays.
    safeRmSync(`${rootDir}/${dotStatePath({ scope: missing.scope! }, 'action-ledger.jsonl')}`);

    const observation = observeDotActions('obs-dot', { rootDir });
    expect(observation.integrity).toBe('integrity_error');
    expect(observation.actions.map((row) => row.action_ref)).toEqual(['ref-normal']);
    expect(observation.actions[0].title).toBe('scoped-secret-title');
    // The missing-evidence row is still reported at index level — metadata only.
    expect(observation.index_only.map((row) => row.action_ref)).toEqual(['ref-missing']);
    expect(observation.index_only[0].title).toBe('[scoped action]');
    expect(observation.anomalies).toMatchObject({ malformed_rows: 1, missing_evidence: 1 });
    // The strict execution hydrate still refuses the same ledger.
    expect(() => currentDotActions('obs-dot', { rootDir })).toThrow(
      'DOT_ACTION_CONTENT_UNAVAILABLE'
    );
    // Repair guidance points at a reviewed path — never a silent rewrite.
    expect(observation.repair.join(' ')).toContain('migrate-state');
  });

  it('counts rows in an invisible scope without returning their contents or ids', () => {
    vi.stubEnv('KYBERION_NHI_ID', 'owner-a');
    appendActionRecord(
      scopedRecord({
        scope: { tier: 'personal', owner_nhi: 'owner-a' },
        action_ref: 'ref-personal',
        title: 'personal-secret',
      }),
      { rootDir }
    );
    appendActionRecord(scopedRecord({ action_ref: 'ref-normal' }), { rootDir });
    vi.stubEnv('KYBERION_NHI_ID', 'owner-b');
    const observation = observeDotActions('obs-dot', { rootDir });
    expect(observation.integrity).toBe('partial');
    expect(observation.anomalies).toMatchObject({ not_visible: 1, malformed_rows: 0 });
    expect(observation.actions.map((row) => row.action_ref)).toEqual(['ref-normal']);
    expect(observation.index_only).toEqual([]);
    expect(JSON.stringify(observation)).not.toContain('personal-secret');
    expect(JSON.stringify(observation)).not.toContain('ref-personal');
  });

  it('flags unparseable index lines and reports unknown counts when the index is unreadable', () => {
    safeMkdir(`${rootDir}/active/shared/runtime`, { recursive: true });
    appendJsonLine(
      `${rootDir}/${DOT_ACTION_LEDGER_PATH}`,
      scopedRecord({ scope: { tier: 'public' } })
    );
    const parsed = observeDotActions('obs-dot', { rootDir });
    expect(parsed.integrity).toBe('complete');
    expect(parsed.anomalies).toMatchObject({
      malformed_rows: 0,
      missing_evidence: 0,
      not_visible: 0,
    });

    appendJsonLine(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, { nope: true } as never);
    const flagged = observeDotActions('obs-dot', { rootDir });
    expect(flagged.integrity).toBe('integrity_error');
    expect(flagged.anomalies?.malformed_rows).toBe(1);
    expect(flagged.actions).toHaveLength(1);

    // Whole index unreadable → counts themselves are unknown, never zero-filled.
    safeMkdir(`${rootDir}-blocked/active/shared/runtime/dot-action-ledger.jsonl`, {
      recursive: true,
    });
    const unreadable = observeDotActions('obs-dot', { rootDir: `${rootDir}-blocked` });
    expect(unreadable.integrity).toBe('integrity_error');
    expect(unreadable.anomalies).toBeNull();
    expect(unreadable.actions).toEqual([]);
    expect(unreadable.repair.join(' ')).toContain('counts are unknown');
  });
});
