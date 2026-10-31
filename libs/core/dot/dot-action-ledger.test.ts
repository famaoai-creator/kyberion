import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendActionRecord,
  currentDotActions,
  readDotActionLedger,
  latestDotActions,
  migrateLegacyDotActions,
  DOT_ACTION_LEDGER_PATH,
  dotActionRecordHash,
  dotProposalHash,
  readDotActionLedgerStrict,
  assertDotActionJudgmentBinding,
  type DotActionRecord,
} from './dot-action-ledger.js';
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
