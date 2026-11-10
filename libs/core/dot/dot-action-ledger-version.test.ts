import { afterEach, describe, expect, it } from 'vitest';
import {
  appendActionRecord,
  assertDotActionJudgmentBinding,
  currentDotActions,
  DOT_ACTION_LEDGER_PATH,
  dotActionRecordHash,
  dotProposalHash,
  readDotActionLedgerStrict,
  type DotActionRecord,
} from './dot-action-ledger.js';
import {
  DOT_ACTION_SCHEMA_VERSION,
  dotProposalEvidenceHash,
  readDotActionRow,
  sameVersionOneAdmission,
  writtenDotActionRow,
} from './dot-action-ledger-version.js';
import { requestedExecutionShape } from './dot-requested-shape.js';
import { dotStatePath } from './dot-state-paths.js';
import { bindSyntheticDotJudgmentProposal } from './dot-judgment-binding.js';
import { normalizeDotProposal } from './dot-proposals.js';
import { admissionForDotRecord, genericDotActionIdentity } from './dot-admission-identity.js';
import { appendJsonLine, readJsonLines, writeJsonLines } from '../foundation/json.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { createJudgmentLatencyFixture } from '../organization/judgment-latency-fixture.js';
import { judgmentEvidenceParent } from '../organization/judgment-evidence.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';

const rootDir = 'active/shared/tmp/dot-action-ledger-version-tests';
afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

type Raw = Record<string, unknown>;

/** A server-bound judged pipeline proposal (current normalizer output). */
function boundProposal() {
  const data = createJudgmentLatencyFixture();
  const judgmentBinding = {
    schema_version: '1' as const,
    work_ref: 'schema-judged-incident',
    work_revision: '1',
    trigger_key: 'schema-trigger',
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
    effectRef: 'schema-effect',
  });
  const proposal = bindSyntheticDotJudgmentProposal({
    mode: 'synthetic_fixture',
    charter: data.charter,
    scope: data.scope,
    judgmentBinding,
    effectRef: 'schema-effect',
    effectPolicyVersion: 'effect-policy',
    originReceipt: { ...parent, attempt: 1, content_hash: 'e'.repeat(64) },
    proposal: normalizeDotProposal({
      title: 'Schema judged repair',
      objective: 'Preserve the original goal',
      execution_shape: 'pipeline',
      pipeline_ref: data.charter.authority.allowed_pipelines![0],
    }),
  });
  return { data, proposal: structuredClone(proposal) };
}

/** A version-2 (current) judged record view, as dispatch builds it. */
function currentRecord(): DotActionRecord {
  const { data, proposal } = boundProposal();
  const identity = genericDotActionIdentity(data.charter, proposal, 0, 'schema-operation');
  return {
    scope: data.scope,
    ...identity,
    semantic_judgment: proposal.semantic_judgment,
    dot_id: data.charter.dot_id,
    actor_id: `dot:${data.charter.dot_id}`,
    action_id: proposal.action_id,
    title: proposal.title,
    objective: proposal.objective,
    execution_shape: proposal.execution_shape,
    pipeline_ref: proposal.pipeline_ref,
    status: 'admitted',
    proposal_hash: dotProposalHash(data.charter.dot_id, proposal),
    at: '2026-10-31T00:00:00.000Z',
  };
}

/**
 * A judged action exactly as the pre-rename (version 1) code wrote it, built by hand
 * with the old hashing rules — no mapping code is used to author it:
 * `work_shape` on the row and on the admitted proposal, no `schema_version`,
 * `semantic_hash = recoveryEvidenceHash(proposal)` and the judgment's
 * `original_proposal_hash` over the proposal without its binding.
 */
function legacyJudgedRow(): Raw {
  const { data, proposal } = boundProposal();
  const { execution_shape: shape, semantic_judgment: judgment, ...fields } = proposal;
  const base: Raw = { ...fields, work_shape: shape };
  const binding = { ...judgment!, original_proposal_hash: judgmentCanonicalHash(base) };
  const stored: Raw = { ...base, semantic_judgment: binding };
  const current = genericDotActionIdentity(data.charter, proposal, 0, 'legacy-operation');
  return {
    scope: data.scope,
    action_ref: current.action_ref,
    admission: {
      ...current.admission!,
      semantic_hash: recoveryEvidenceHash(stored),
      proposal: stored,
    },
    semantic_judgment: binding,
    dot_id: data.charter.dot_id,
    actor_id: `dot:${data.charter.dot_id}`,
    action_id: proposal.action_id,
    title: proposal.title,
    objective: proposal.objective,
    work_shape: shape,
    pipeline_ref: proposal.pipeline_ref,
    status: 'admitted',
    proposal_hash: 'legacy-proposal-hash',
    at: '2026-10-01T00:00:00.000Z',
  };
}

function scopedFile(row: Raw): string {
  return `${rootDir}/${dotStatePath({ scope: row.scope as DotActionRecord['scope'] }, 'action-ledger.jsonl')}`;
}

/** Persist rows the way the version-1 writer did: scoped body + shared metadata index. */
function writeLegacyLedger(rows: Raw[]): void {
  safeMkdir(`${rootDir}/active/shared/runtime`, { recursive: true });
  for (const row of rows) {
    const file = scopedFile(row);
    safeMkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    appendJsonLine(file, row);
    appendJsonLine(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`, {
      scope: row.scope,
      private_content_hash: recoveryEvidenceHash(row),
      action_ref: row.action_ref,
      dot_id: row.dot_id,
      actor_id: row.actor_id,
      action_id: row.action_id,
      title: '[scoped action]',
      objective: '[scoped action]',
      work_shape: row.work_shape,
      status: row.status,
      proposal_hash: row.proposal_hash,
      at: row.at,
    });
  }
}

function rewriteLedger(rows: Raw[]): void {
  writeJsonLines(scopedFile(rows[0]), rows);
  writeJsonLines(
    `${rootDir}/${DOT_ACTION_LEDGER_PATH}`,
    rows.map((row) =>
      writtenDotActionRow({
        ...readDotActionRow({ ...row }),
        title: '[scoped action]',
        objective: '[scoped action]',
        admission: undefined,
        semantic_judgment: undefined,
        private_content_hash: recoveryEvidenceHash(row),
      } as DotActionRecord)
    )
  );
}

describe('dot action ledger schema versions', () => {
  it('verifies an old (version 1) ledger over its original written form', () => {
    const raw = legacyJudgedRow();
    writeLegacyLedger([raw]);
    const [view] = currentDotActions(raw.dot_id as string, { rootDir });
    expect(view.execution_shape).toBe('pipeline');
    expect(view).not.toHaveProperty('work_shape');
    expect(view.schema_version).toBe(1);
    expect(view.admission?.proposal.execution_shape).toBe('pipeline');
    expect(() => assertDotActionJudgmentBinding(view)).not.toThrow();
    // Hashes are taken over the record exactly as it was written.
    expect(dotActionRecordHash(view)).toBe(recoveryEvidenceHash(raw));
    expect(dotProposalEvidenceHash(view.admission!.proposal)).toBe(
      (raw.admission as Raw).semantic_hash
    );
    expect(writtenDotActionRow(view)).toEqual(raw);
    expect(readDotActionLedgerStrict({ rootDir, dotId: raw.dot_id as string })).toEqual([view]);
  });

  it('writes new records as version 2 with execution_shape and verifies them', () => {
    const record = currentRecord();
    appendActionRecord(record, { rootDir });
    const [stored] = readJsonLines<Raw>(scopedFile(record as unknown as Raw));
    expect(stored.schema_version).toBe(DOT_ACTION_SCHEMA_VERSION);
    expect(stored.execution_shape).toBe('pipeline');
    expect(stored).not.toHaveProperty('work_shape');
    expect((stored.admission as { proposal: Raw }).proposal.execution_shape).toBe('pipeline');
    expect((stored.admission as { proposal: Raw }).proposal).not.toHaveProperty('schema_version');
    const [index] = readJsonLines<Raw>(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`);
    expect(index.schema_version).toBe(DOT_ACTION_SCHEMA_VERSION);
    expect(index.private_content_hash).toBe(recoveryEvidenceHash(stored));
    expect(currentDotActions(record.dot_id, { rootDir })).toEqual([record]);
    expect(readDotActionLedgerStrict({ rootDir, dotId: record.dot_id })).toEqual([record]);
  });

  it('keeps a status rewrite of an old admitted action in version 1, like-for-like', () => {
    const raw = legacyJudgedRow();
    writeLegacyLedger([raw]);
    const [admitted] = currentDotActions(raw.dot_id as string, { rootDir });
    appendActionRecord(
      {
        ...admitted,
        status: 'dispatched',
        work_item_id: 'WITEM-schema',
        at: '2026-11-10T00:00:00Z',
      },
      { rootDir }
    );
    const stored = readJsonLines<Raw>(scopedFile(raw));
    expect(stored).toHaveLength(2);
    expect(stored[1]).not.toHaveProperty('schema_version');
    expect(stored[1].work_shape).toBe('pipeline');
    expect(stored[1]).not.toHaveProperty('execution_shape');
    expect(stored[1].admission).toEqual(raw.admission);
    const [index] = readJsonLines<Raw>(`${rootDir}/${DOT_ACTION_LEDGER_PATH}`).slice(-1);
    expect(index).not.toHaveProperty('schema_version');
    expect(index.work_shape).toBe('pipeline');
    const history = readDotActionLedgerStrict({ rootDir, dotId: raw.dot_id as string });
    expect(history.map((row) => row.status)).toEqual(['admitted', 'dispatched']);
    for (const row of history) expect(() => assertDotActionJudgmentBinding(row)).not.toThrow();
    expect(currentDotActions(raw.dot_id as string, { rootDir })[0]).toMatchObject({
      status: 'dispatched',
      execution_shape: 'pipeline',
      schema_version: 1,
    });
  });

  it('still fails tampering in a version 1 record', () => {
    const shape = { ...legacyJudgedRow(), work_shape: 'direct_reply' };
    rewriteLedger([shape]);
    expect(() => currentDotActions(shape.dot_id as string, { rootDir })).toThrow(
      'Judgment action executable field differs: work_shape'
    );
    const base = legacyJudgedRow();
    const proposal = { ...(base.admission as { proposal: Raw }).proposal, objective: 'changed' };
    const changed = { ...base, admission: { ...(base.admission as Raw), proposal } };
    rewriteLedger([changed]);
    expect(() => currentDotActions(changed.dot_id as string, { rootDir })).toThrow();
    // Renaming the key in place is not a valid version 1 record.
    const { work_shape: legacyShape, ...rest } = legacyJudgedRow();
    expect(() => readDotActionRow({ ...rest, execution_shape: legacyShape })).toThrow(
      'DOT_ACTION_SCHEMA'
    );
  });

  it('still fails tampering in a version 2 record', () => {
    const record = currentRecord();
    appendActionRecord(record, { rootDir });
    const [stored] = readJsonLines<Raw>(scopedFile(record as unknown as Raw));
    rewriteLedger([{ ...stored, execution_shape: 'direct_reply' }]);
    expect(() => currentDotActions(record.dot_id, { rootDir })).toThrow(
      'Judgment action executable field differs: execution_shape'
    );
    expect(() => readDotActionLedgerStrict({ rootDir, dotId: record.dot_id })).toThrow();
    // A version 2 row cannot be paired with a version 1 admitted proposal (or key).
    const admission = stored.admission as { proposal: Raw };
    const { execution_shape: shape, ...proposal } = admission.proposal;
    expect(() =>
      readDotActionRow({
        ...stored,
        admission: { ...admission, proposal: { ...proposal, work_shape: shape } },
      })
    ).toThrow('DOT_ACTION_SCHEMA');
    expect(() => readDotActionRow({ ...stored, work_shape: 'pipeline' })).toThrow(
      'DOT_ACTION_SCHEMA'
    );
    expect(() => readDotActionRow({ ...stored, schema_version: 3 })).toThrow(
      'unknown action schema_version'
    );
  });

  it('treats a re-proposal of a version 1 operation as the same admission only when it hashes the same', () => {
    const [prior] = [readDotActionRow(legacyJudgedRow())];
    const proposal = { ...prior.admission!.proposal };
    delete proposal.schema_version;
    const current = { ...prior.admission!, proposal };
    expect(sameVersionOneAdmission(prior.admission, current)).toBe(true);
    expect(
      sameVersionOneAdmission(prior.admission, {
        ...current,
        proposal: { ...proposal, objective: 'changed' },
      })
    ).toBe(false);
    // A version 2 admission is compared by its own hash, never re-written as version 1.
    const fresh = currentRecord().admission;
    expect(sameVersionOneAdmission(fresh, fresh)).toBe(false);
  });

  it('binds a pre-admission version 1 row in version 1, so its row and WorkItem keep their keys', () => {
    const view = readDotActionRow({
      scope: { tier: 'public' },
      action_ref: 'pre-admission',
      dot_id: 'legacy-dot',
      actor_id: 'dot:legacy-dot',
      action_id: 'dot_delegate_work',
      title: 'Legacy parked work',
      objective: 'Finish the legacy work',
      work_shape: 'direct_reply',
      status: 'parked',
      proposal_hash: 'legacy-hash',
      at: '2026-10-01T00:00:00.000Z',
    });
    const charter = {
      dot_id: 'legacy-dot',
      scope: { tier: 'public' },
      status: 'active',
      runtime: {},
      authority: { authority_role: 'mission_controller' },
    } as never;
    const admission = admissionForDotRecord(charter, view);
    const written = writtenDotActionRow({ ...view, admission });
    expect(written).not.toHaveProperty('schema_version');
    expect(written.work_shape).toBe('direct_reply');
    expect((written.admission as { proposal: Raw }).proposal.work_shape).toBe('direct_reply');
    expect(admission.semantic_hash).toBe(
      recoveryEvidenceHash((written.admission as { proposal: Raw }).proposal)
    );
  });

  it('reads both WorkItem shape keys for one release', () => {
    expect(requestedExecutionShape({ requested_execution_shape: 'pipeline' })).toBe('pipeline');
    expect(requestedExecutionShape({ requested_work_shape: 'mission' })).toBe('mission');
    expect(requestedExecutionShape(undefined)).toBeUndefined();
  });
});
