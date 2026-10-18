import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  applyHearingTurn,
  createHearingRecord,
  type HearingDecisionOperation,
  type HearingDecisionIdentity,
  type HearingDecidedBy,
} from './hearing.js';
import {
  decideHearingRecord,
  hearingDecisionReceipt,
  loadHearingRecord,
  saveHearingRecord,
  updateHearingRecord,
  parseHearingDecisionOperation,
} from './hearing-runtime.js';
import { withoutHearingCompletionFields } from './hearing-completion.js';
const fault = vi.hoisted(() => ({ operation: '' }));
vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    safeWriteFile: (...args: Parameters<typeof actual.safeWriteFile>) => {
      if (
        fault.operation &&
        String(args[1]).includes('"current_decision_operation_id": "' + fault.operation + '"')
      )
        throw new Error('Injected receipt write failure');
      return actual.safeWriteFile(...args);
    },
  };
});
const namespace = 'zz-receipt-test';
const identity: HearingDecisionIdentity = {
  principal_id: 'test-principal',
  scope_key: 'test-scope',
  member_id: 'human-one',
  source: 'loopback',
};
const actor: HearingDecidedBy = { kind: 'human', id: 'user:' + identity.member_id, role: 'owner' };
const now = '2026-10-17T00:00:00.000Z';
const sessions: string[] = [];
function seed() {
  const session = 'receipt-' + randomUUID();
  sessions.push(session);
  let record = createHearingRecord(session, now);
  for (let i = 0; i < record.requirements.length; i++)
    record = applyHearingTurn(record, { text: 'answer ' + i, request_id: 'r' + i }, now);
  saveHearingRecord(namespace, record);
  const current = loadHearingRecord(namespace, session)!;
  const operation: HearingDecisionOperation = {
    version: 1,
    operation_id: 'op-' + randomUUID(),
    scenario_id: current.scenario,
    requirements_revision: current.requirements_revision!,
  };
  return { session, operation, current };
}
afterEach(() => {
  fault.operation = '';
  for (const session of sessions.splice(0))
    safeRmSync(
      pathResolver.rootResolve(
        'active/shared/runtime/hearing/confidential/' + namespace + '/' + namespace + '/' + session
      ),
      { recursive: true, force: true }
    );
});
describe('exact durable hearing decision receipts', () => {
  it('commits receipt atomically and exact replay does not rewrite or advance revision', () => {
    const { session, operation } = seed();
    const first = decideHearingRecord(namespace, session, operation, identity, actor, now);
    const again = decideHearingRecord(
      namespace,
      session,
      operation,
      identity,
      actor,
      '2026-10-18T00:00:00.000Z'
    );
    expect(first.decision_revision).toBe(first.record_revision);
    expect(again).toEqual(first);
    expect(
      hearingDecisionReceipt(loadHearingRecord(namespace, session), namespace, operation, identity)
        ?.status
    ).toBe('current');
    expect(withoutHearingCompletionFields(first)).not.toHaveProperty('decision_receipts');
    expect(withoutHearingCompletionFields(first)).not.toHaveProperty(
      'current_decision_operation_id'
    );
  });
  it('same ID with changed payload or actor is a conflict without mutation', () => {
    const { session, operation } = seed();
    const first = decideHearingRecord(namespace, session, operation, identity, actor, now);
    expect(() =>
      decideHearingRecord(
        namespace,
        session,
        { ...operation, requirements_revision: operation.requirements_revision + 1 },
        identity,
        actor,
        now
      )
    ).toThrow('operation_mismatch');
    expect(() =>
      decideHearingRecord(
        namespace,
        session,
        operation,
        { ...identity, principal_id: 'other' },
        actor,
        now
      )
    ).toThrow('operation_mismatch');
    expect(loadHearingRecord(namespace, session)).toEqual(first);
  });
  it('new stale operation cannot decide newer answers', () => {
    const { session, operation, current } = seed();
    expect(() =>
      decideHearingRecord(
        namespace,
        session,
        { ...operation, requirements_revision: operation.requirements_revision - 1 },
        identity,
        actor,
        now
      )
    ).toThrow('stale_snapshot');
    expect(loadHearingRecord(namespace, session)).toEqual(current);
  });
  it('historical replay never restores a decision or changes newer revision', () => {
    const { session, operation } = seed();
    decideHearingRecord(namespace, session, operation, identity, actor, now);
    const changed = updateHearingRecord(namespace, session, (current) => ({
      ...current!,
      requirements: current!.requirements.map((r, i) => (i ? r : { ...r, answer: 'changed' })),
    }));
    expect(changed.decided_at).toBeUndefined();
    expect(hearingDecisionReceipt(changed, namespace, operation, identity)?.status).toBe(
      'superseded'
    );
    expect(decideHearingRecord(namespace, session, operation, identity, actor, now)).toEqual(
      changed
    );
    expect(loadHearingRecord(namespace, session)?.decided_at).toBeUndefined();
  });
  it('legacy decisions do not fabricate receipts and supersede exact current proof', () => {
    const { session, operation } = seed();
    decideHearingRecord(namespace, session, operation, identity, actor, now);
    const legacy = decideHearingRecord(namespace, session, null, identity, actor, now);
    expect(legacy.decision_receipts).toHaveLength(1);
    expect(legacy.decision_revision).toBe(legacy.record_revision);
    expect(hearingDecisionReceipt(legacy, namespace, operation, identity)?.status).toBe(
      'superseded'
    );
  });
  it('receipt absence remains unknown', () => {
    const { operation, current } = seed();
    expect(hearingDecisionReceipt(current, namespace, operation, identity)).toBeNull();
    expect(hearingDecisionReceipt(null, namespace, operation, identity)).toBeNull();
  });
  it('a failed atomic write leaves both decision and receipt uncommitted', () => {
    const { session, operation, current } = seed();
    fault.operation = operation.operation_id;
    expect(() => decideHearingRecord(namespace, session, operation, identity, actor, now)).toThrow(
      'Injected receipt'
    );
    expect(loadHearingRecord(namespace, session)).toEqual(current);
  });
  it('parses only exact versioned bodies or empty legacy bodies', () => {
    expect(parseHearingDecisionOperation({})).toBeNull();
    for (const bad of [
      null,
      [],
      { operation_id: 'x' },
      {
        version: 1,
        operation_id: 'x',
        scenario_id: 'web_app_build',
        requirements_revision: 0,
        actor: 'spoof',
      },
    ])
      expect(() => parseHearingDecisionOperation(bad)).toThrow();
  });
  it.each(['duplicate', 'scope', 'identity', 'revision', 'pointer'] as const)(
    'fails closed on corrupt persisted receipt %s',
    (kind) => {
      const { session, operation } = seed();
      const committed = decideHearingRecord(namespace, session, operation, identity, actor, now);
      const bad = structuredClone(committed);
      const receipt = bad.decision_receipts![0];
      if (kind === 'duplicate') bad.decision_receipts!.push(structuredClone(receipt));
      if (kind === 'scope') receipt.namespace = 'another-tenant';
      if (kind === 'identity') receipt.identity.member_id = 'another-human';
      if (kind === 'revision') receipt.record_revision += 10;
      if (kind === 'pointer') bad.current_decision_operation_id = 'missing';
      safeWriteFile(
        pathResolver.rootResolve(
          'active/shared/runtime/hearing/confidential/' +
            namespace +
            '/' +
            namespace +
            '/' +
            session +
            '/' +
            session +
            '.json'
        ),
        JSON.stringify(bad)
      );
      expect(() => loadHearingRecord(namespace, session)).toThrow('HEARING_RECEIPT_INVALID');
      expect(() =>
        decideHearingRecord(namespace, session, operation, identity, actor, now)
      ).toThrow('HEARING_RECEIPT_INVALID');
    }
  );
  it('fails closed at receipt capacity without pruning prior exact operation evidence', () => {
    const { session, operation } = seed();
    const first = decideHearingRecord(namespace, session, operation, identity, actor, now);
    const full = {
      ...first,
      record_revision: 129,
      current_decision_operation_id: 'full-127',
      decision_receipts: Array.from({ length: 128 }, (_, i) => ({
        ...first.decision_receipts![0],
        record_revision: i + 2,
        operation: { ...operation, operation_id: 'full-' + i },
      })),
    };
    safeWriteFile(
      pathResolver.rootResolve(
        'active/shared/runtime/hearing/confidential/' +
          namespace +
          '/' +
          namespace +
          '/' +
          session +
          '/' +
          session +
          '.json'
      ),
      JSON.stringify(full)
    );
    expect(() => decideHearingRecord(namespace, session, operation, identity, actor, now)).toThrow(
      'receipt_capacity'
    );
    expect(loadHearingRecord(namespace, session)).toEqual(full);
  });
});
