import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendActionRecord,
  currentDotActions,
  observeDotActions,
  readDotActionLedger,
  latestDotActions,
  migrateLegacyDotActions,
  DOT_ACTION_LEDGER_PATH,
  dotActionRecordHash,
  dotProposalHash,
  readDotActionLedgerStrict,
  assertDotActionJudgmentBinding,
  resetDotActionLedgerGrowthWarnForTests,
  type DotActionRecord,
} from './dot-action-ledger.js';
import { readJsonLines } from '../foundation/json.js';

const ledgerWarn = vi.hoisted(() => vi.fn());
// Size seam for the strict reader: report the ledger as larger than it is.
const statInflation = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>();
  return {
    ...actual,
    createLogger: (name: string, options?: Parameters<typeof actual.createLogger>[1]) => {
      const real = actual.createLogger(name, options);
      return name === 'dot-action-ledger' ? { ...real, warn: ledgerWarn } : real;
    },
  };
});
vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...actual,
    safeLstat: (...args: Parameters<typeof actual.safeLstat>) => {
      const stat = actual.safeLstat(...args);
      if (!statInflation.bytes || !String(args[0]).endsWith('dot-action-ledger.jsonl')) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: stat.size + statInflation.bytes,
      });
    },
  };
});
import { dotStatePath } from './dot-state-paths.js';
import { safeReadFile, safeRmSync, safeMkdir, safeExistsSync } from '../secure-io.js';
import { appendJsonLine, writeJsonLines } from '../foundation/json.js';
import { withExecutionContext } from '../authority.js';
import { bindSyntheticDotJudgmentProposal } from './dot-judgment-binding.js';
import { normalizeDotProposal } from './dot-proposals.js';
import { genericDotActionIdentity } from './dot-admission-identity.js';
import { createJudgmentLatencyFixture } from '../organization/judgment-latency-fixture.js';
import { judgmentEvidenceParent } from '../organization/judgment-evidence.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';

const rootDir = 'active/shared/tmp/dot-private-action-ledger-tests';
function judgedRecord(): DotActionRecord {
  const data = createJudgmentLatencyFixture();
  const judgmentBinding = {
    schema_version: '1' as const,
    work_ref: 'private-judged-incident',
    work_revision: '1',
    trigger_key: 'private-trigger',
    scope_hash: judgmentCanonicalHash(data.scope),
    request_hash: 'a'.repeat(64),
    evidence_hash: 'b'.repeat(64),
    precedent_snapshot_hash: 'c'.repeat(64),
    policy_version: 'semantic-policy',
    rubric_version: 'rubric',
    evaluator_version: 'evaluator',
    model_config_hash: 'd'.repeat(64),
  };
  const parent = judgmentEvidenceParent({
    scope: data.scope,
    binding: judgmentBinding,
    effectRef: 'private-effect',
  });
  const proposal = bindSyntheticDotJudgmentProposal({
    mode: 'synthetic_fixture',
    charter: data.charter,
    scope: data.scope,
    judgmentBinding,
    effectRef: 'private-effect',
    effectPolicyVersion: 'effect-policy',
    originReceipt: { ...parent, attempt: 1, content_hash: 'e'.repeat(64) },
    proposal: normalizeDotProposal({
      title: 'Private judged repair',
      objective: 'Preserve the original goal',
      work_shape: 'pipeline',
      pipeline_ref: data.charter.authority.allowed_pipelines![0],
    }),
  });
  const identity = genericDotActionIdentity(data.charter, proposal, 0, 'same-operation');
  return {
    scope: data.scope,
    ...identity,
    semantic_judgment: proposal.semantic_judgment,
    dot_id: data.charter.dot_id,
    actor_id: `dot:${data.charter.dot_id}`,
    action_id: proposal.action_id,
    title: proposal.title,
    objective: proposal.objective,
    work_shape: proposal.work_shape,
    pipeline_ref: proposal.pipeline_ref,
    status: 'admitted',
    proposal_hash: dotProposalHash(data.charter.dot_id, proposal),
    at: '2026-10-31T00:00:00.000Z',
  };
}
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

  it('roundtrips complete judged evidence privately while shared inventory omits binding and source selectors', () => {
    const record = judgedRecord();
    expect(() => assertDotActionJudgmentBinding(record)).not.toThrow();
    expect(appendActionRecord(record, { rootDir })).toBe(record);
    const shared = String(safeReadFile(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`));
    for (const privateField of [
      'semantic_judgment',
      'origin_receipt',
      'judgment_binding',
      'private-judged-incident',
      'private-trigger',
      'private-effect',
      record.title,
    ])
      expect(shared).not.toContain(privateField);
    const index = readDotActionLedger({ rootDir })[0];
    expect(index).not.toHaveProperty('semantic_judgment');
    expect(index).not.toHaveProperty('admission');
    expect(index.private_content_hash).toBe(dotActionRecordHash(record));
    expect(() => assertDotActionJudgmentBinding(index)).toThrow('shared index');
    expect(currentDotActions(record.dot_id, { rootDir })).toEqual([record]);
    expect(readDotActionLedgerStrict({ rootDir, dotId: record.dot_id })).toEqual([record]);
    expect(readDotActionLedgerStrict({ rootDir, indexOnly: true })[0]).not.toHaveProperty(
      'semantic_judgment'
    );
    expect(record.semantic_judgment?.origin_receipt.attempt).toBe(1);
  });

  it('rejects missing, mismatched, malformed and one-sided changed bindings before append', () => {
    const record = judgedRecord();
    const clone = () => structuredClone(record);
    const missingTop = clone();
    delete missingTop.semantic_judgment;
    const missingAdmission = clone();
    delete missingAdmission.admission;
    const missingInner = clone();
    delete missingInner.admission!.proposal.semantic_judgment;
    const changedOrigin = clone();
    changedOrigin.admission!.proposal.semantic_judgment!.origin_receipt.attempt = 2;
    const forgedOrigin = clone();
    forgedOrigin.semantic_judgment!.origin_receipt.evaluation_key = 'f'.repeat(64);
    const badScope = clone();
    badScope.scope!.tenant_slug = 'other-tenant';
    const badSemanticHash = clone();
    badSemanticHash.admission!.semantic_hash = 'f'.repeat(64);
    const changedFacts = clone();
    changedFacts.admission!.proposal.objective = 'Changed target';
    for (const invalid of [
      missingTop,
      missingAdmission,
      missingInner,
      changedOrigin,
      forgedOrigin,
      badScope,
      badSemanticHash,
      changedFacts,
      ...[
        'action_id',
        'title',
        'objective',
        'work_shape',
        'rationale',
        'priority',
        'pipeline_ref',
        'target',
        'intent',
      ].map((field) => ({ ...clone(), [field]: 'changed' })),
      { ...clone(), expected_effect: { direction: 'increase', signal: 'changed' } },
      { ...clone(), mission_admission: {} },
      { ...clone(), handoff_to: 'other-dot' },
      { ...clone(), continuous_work: {} },
      { ...clone(), front_desk_execution: {} },
      { ...record, semantic_judgment: null } as unknown as DotActionRecord,
    ]) {
      expect(() => appendActionRecord(invalid as DotActionRecord, { rootDir })).toThrow();
    }
    expect(safeExistsSync(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`)).toBe(false);
    const getter = vi.fn(() => undefined);
    const accessor = Object.defineProperty({ ...record }, 'semantic_judgment', {
      enumerable: true,
      get: getter,
    });
    expect(() => assertDotActionJudgmentBinding(accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('validates hydrated private schema even when the shared hash matches the malformed full body', () => {
    const record = judgedRecord();
    appendActionRecord(record, { rootDir });
    const index = readDotActionLedger({ rootDir })[0];
    const malformed = structuredClone(record);
    delete malformed.admission!.proposal.semantic_judgment;
    const file = `${rootDir}/${dotStatePath({ scope: record.scope! }, 'action-ledger.jsonl')}`;
    writeJsonLines(file, [malformed]);
    writeJsonLines(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, [
      { ...index, private_content_hash: dotActionRecordHash(malformed) },
    ]);
    expect(() => currentDotActions(record.dot_id, { rootDir })).toThrow('Judgment action');
    expect(() => readDotActionLedgerStrict({ rootDir, dotId: record.dot_id })).toThrow(
      'Judgment action'
    );
    const inventory = latestDotActions({ rootDir })[0];
    expect(inventory.title).toBe('[scoped action]');
    expect(inventory).not.toHaveProperty('semantic_judgment');
    expect(() => assertDotActionJudgmentBinding(inventory)).toThrow('shared index');
  });

  it('missing judged private payload never becomes legacy off through the inventory fallback', () => {
    const record = judgedRecord();
    appendActionRecord(record, { rootDir });
    safeRmSync(`${rootDir}/${dotStatePath({ scope: record.scope! }, 'action-ledger.jsonl')}`);
    expect(() => currentDotActions(record.dot_id, { rootDir })).toThrow(
      'DOT_ACTION_CONTENT_UNAVAILABLE'
    );
    const index = latestDotActions({ rootDir })[0];
    expect(index).not.toHaveProperty('semantic_judgment');
    expect(() => assertDotActionJudgmentBinding(index)).toThrow('shared index');
    expect(() => appendActionRecord(index, { rootDir })).toThrow('shared index');
  });

  it.each(['pipeline_ref', 'title', 'objective', 'work_shape'] as const)(
    'rejects hydrated executable %s changes despite an updated shared content hash',
    (field) => {
      const record = judgedRecord();
      appendActionRecord(record, { rootDir });
      const index = readDotActionLedger({ rootDir })[0];
      const malformed = { ...structuredClone(record), [field]: 'changed' } as DotActionRecord;
      writeJsonLines(
        `${rootDir}/${dotStatePath({ scope: record.scope! }, 'action-ledger.jsonl')}`,
        [malformed]
      );
      writeJsonLines(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, [
        { ...index, private_content_hash: dotActionRecordHash(malformed) },
      ]);
      expect(() => currentDotActions(record.dot_id, { rootDir })).toThrow(
        'Judgment action executable field'
      );
      expect(() => readDotActionLedgerStrict({ rootDir, dotId: record.dot_id })).toThrow();
    }
  );

  it('keeps old records with absent or undefined judgment metadata off without canonicalizing legacy optional fields', () => {
    const record: DotActionRecord = {
      scope: { tier: 'public' },
      action_ref: 'legacy',
      dot_id: 'legacy-dot',
      actor_id: 'dot:legacy-dot',
      action_id: 'dot_delegate_work',
      title: 'Legacy',
      objective: 'Legacy',
      work_shape: 'direct_reply',
      status: 'admitted',
      proposal_hash: 'legacy-hash',
      semantic_judgment: undefined,
      reason: undefined,
      at: '2026-10-31T00:00:00.000Z',
    };
    expect(() => assertDotActionJudgmentBinding(record)).not.toThrow();
    appendActionRecord(record, { rootDir });
    expect(currentDotActions(record.dot_id, { rootDir })[0]).not.toHaveProperty(
      'semantic_judgment'
    );
    expect(readDotActionLedgerStrict({ rootDir })[0].action_ref).toBe('legacy');
  });

  it.each(['semantic_judgment', 'admission'] as const)(
    'rejects a malformed mixed private index carrying own %s before inventory or executable reads',
    (field) => {
      const record = judgedRecord();
      appendActionRecord(record, { rootDir });
      const index = readDotActionLedger({ rootDir })[0];
      expect(index.private_content_hash).toBe(dotActionRecordHash(record));
      const malformed = { ...index, [field]: record[field] };
      writeJsonLines(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, [malformed]);
      for (const read of [
        () => readDotActionLedger({ rootDir }),
        () => readDotActionLedgerStrict({ rootDir }),
        () => readDotActionLedgerStrict({ rootDir, indexOnly: true }),
        () => currentDotActions(record.dot_id, { rootDir }),
        () => latestDotActions({ rootDir }),
      ])
        expect(read).toThrow('shared index contains private judgment body');
      expect(() => appendActionRecord(malformed, { rootDir })).toThrow('shared index');
      // Rejection neither rewrites the inventory identity nor tries to move its private body.
      expect(
        JSON.parse(String(safeReadFile(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`)))
          .private_content_hash
      ).toBe(index.private_content_hash);
    }
  );
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
  describe('dot action ledger store bounds', () => {
    const publicScope = { tier: 'public' as const };
    const privateScope = { tier: 'confidential' as const, tenant_slug: 'acme' };
    function row(
      actionRef: string,
      status: DotActionRecord['status'],
      scope: DotActionRecord['scope'],
      dotId = 'bounds-dot'
    ): DotActionRecord {
      return {
        scope,
        action_ref: actionRef,
        dot_id: dotId,
        actor_id: `dot:${dotId}`,
        action_id: 'repair',
        title: `title ${actionRef} ${status}`,
        objective: 'keep the store bounded',
        work_shape: 'pipeline',
        status,
        proposal_hash: `hash-${actionRef}`,
        at: '2026-11-01T00:00:00.000Z',
      };
    }
    function seed(): void {
      appendActionRecord(row('a1', 'admitted', publicScope), { rootDir });
      appendActionRecord(row('p1', 'admitted', privateScope), { rootDir });
      appendActionRecord(row('a2', 'parked', publicScope, 'other-dot'), { rootDir });
      appendActionRecord(row('a1', 'dispatched', publicScope), { rootDir });
      appendActionRecord(row('p1', 'declined', privateScope), { rootDir });
      appendActionRecord(row('a3', 'shadow', publicScope), { rootDir });
    }
    afterEach(() => {
      statInflation.bytes = 0;
      ledgerWarn.mockClear();
      resetDotActionLedgerGrowthWarnForTests();
    });

    it('stream-folds across many read chunks with results identical to the whole-file read', () => {
      seed();
      // A non-record row is skipped by the readers and counted by the observer, like before.
      appendJsonLine(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, 'not-a-record');
      const tiny = { rootDir, readChunkBytes: 5 };
      const whole = readJsonLines<DotActionRecord>(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, {
        onMalformed: 'skip',
      }).filter((entry) => typeof entry?.action_ref === 'string');

      const index = readDotActionLedger(tiny);
      expect(index).toEqual(readDotActionLedger({ rootDir }));
      expect(index.map((entry) => [entry.action_ref, entry.status])).toEqual(
        whole.map((entry) => [entry.action_ref, entry.status])
      );
      const current = currentDotActions('bounds-dot', tiny);
      expect(current).toEqual(currentDotActions('bounds-dot', { rootDir }));
      expect(current.map((entry) => [entry.action_ref, entry.status])).toEqual([
        ['a1', 'dispatched'],
        ['p1', 'declined'],
        ['a3', 'shadow'],
      ]);
      expect(current[1].title).toBe('title p1 declined'); // hydrated from the scoped ledger
      expect(latestDotActions(tiny)).toEqual(latestDotActions({ rootDir }));
      expect(latestDotActions(tiny)).toHaveLength(4);
      const strict = readDotActionLedgerStrict({ rootDir, dotId: 'bounds-dot', readChunkBytes: 5 });
      expect(strict).toEqual(readDotActionLedgerStrict({ rootDir, dotId: 'bounds-dot' }));
      // Full history is kept: both versions of a1 and p1 are still present.
      expect(strict.map((entry) => [entry.action_ref, entry.status])).toEqual([
        ['a1', 'admitted'],
        ['p1', 'admitted'],
        ['a1', 'dispatched'],
        ['p1', 'declined'],
        ['a3', 'shadow'],
      ]);
      const observed = observeDotActions('bounds-dot', tiny);
      expect(observed).toEqual(observeDotActions('bounds-dot', { rootDir }));
      expect(observed.anomalies?.malformed_rows).toBe(1);
    });

    it('reads the strict history past the old 16MB cap', () => {
      seed();
      statInflation.bytes = 32 * 1024 * 1024;
      expect(
        readDotActionLedgerStrict({ rootDir, dotId: 'bounds-dot', indexOnly: true })
      ).toHaveLength(5);
    });

    it('warns on growth once per doubling and never fails the append', () => {
      const deps = { rootDir, growthWarnBytes: 600 };
      appendActionRecord(row('g1', 'admitted', publicScope), deps);
      expect(ledgerWarn).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++)
        appendActionRecord(row(`g${i + 2}`, 'admitted', publicScope), deps);
      expect(ledgerWarn).toHaveBeenCalledTimes(1);
      expect(String(ledgerWarn.mock.calls[0][0])).toMatch(/ — .* \| next: .* \| evidence: /);
      appendActionRecord(row('g9', 'admitted', publicScope), deps);
      expect(ledgerWarn).toHaveBeenCalledTimes(1); // not yet doubled
      expect(readDotActionLedger({ rootDir })).toHaveLength(5);
    });
  });
});
