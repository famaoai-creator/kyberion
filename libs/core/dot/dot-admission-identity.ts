/** Generic admission identities and synchronous per-dot serialization. */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { withLockSync } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import type { DotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
import type { DotActionRecord } from './dot-action-ledger.js';

export function dotAdmissionScopeHash(charter: DotCharter): string {
  return recoveryEvidenceHash({ dot_id: charter.dot_id, scope: charter.scope });
}
export function genericDotActionIdentity(
  charter: DotCharter,
  proposal: DotProposal,
  ordinal: number,
  operationKey?: string
): Pick<DotActionRecord, 'action_ref' | 'admission'> {
  if (operationKey !== undefined && (!operationKey.trim() || operationKey.length > 2000))
    throw new Error('invalid dot operation key');
  const scope_hash = dotAdmissionScopeHash(charter);
  const semantic_hash = recoveryEvidenceHash(proposal);
  const key = operationKey ?? randomUUID();
  return {
    action_ref: 'dact-' + recoveryEvidenceHash([scope_hash, key, ordinal]),
    admission: {
      scope_hash,
      semantic_hash,
      ordinal,
      proposal,
      authority_role: charter.authority.authority_role,
      ...(operationKey ? { operation_key: operationKey } : {}),
    },
  };
}
export function dotAdmissionItemId(actionRef: string): string {
  return 'WITEM-DOT-' + createHash('sha256').update(actionRef).digest('hex').slice(0, 40);
}
const held = new Set<string>();
export function withDotAdmissionLock<T>(
  charter: DotCharter,
  rootDir: string | undefined,
  fn: () => T
): T {
  const key =
    'dot-admission-' +
    recoveryEvidenceHash([
      path.resolve(rootDir ?? pathResolver.rootDir()),
      dotAdmissionScopeHash(charter),
    ]);
  if (held.has(key)) return fn();
  return withLockSync(key, () => {
    held.add(key);
    try {
      return fn();
    } finally {
      held.delete(key);
    }
  });
}

/** Bind pre-upgrade parked work before its first executable creation. */
export function admissionForDotRecord(
  charter: DotCharter,
  row: DotActionRecord
): NonNullable<DotActionRecord['admission']> {
  if (row.admission) return row.admission;
  const proposal: DotProposal = {
    action_id: row.action_id,
    title: row.title,
    objective: row.objective,
    work_shape: row.work_shape,
  };
  for (const key of [
    'priority',
    'rationale',
    'pipeline_ref',
    'expected_effect',
    'target',
    'intent',
    'handoff_to',
  ] as const) {
    if (row[key] !== undefined) Object.assign(proposal, { [key]: row[key] });
  }
  return genericDotActionIdentity(charter, proposal, 0).admission!;
}
