import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendActionRecord,
  currentDotActions,
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
