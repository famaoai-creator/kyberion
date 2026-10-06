import { createHash } from 'node:crypto';
import {
  parseFrontDeskExecutionBinding,
  type FrontDeskExecutionBinding,
} from './front-desk-execution-contract.js';

/** An immutable human recovery decision, never execution/approval authority. */
export interface FrontDeskExecutionRecoveryReceipt {
  version: 1;
  binding: FrontDeskExecutionBinding;
  action_ref: string;
  approval_request_id: string;
  approval_hash: string;
  action_hash: string;
  display_digest: string;
  actor_id: string;
  member_id: string;
  browser_session_id: string;
  terminated_at: string;
  reason: 'approval_verification_failed';
  recovery_id?: string;
}
export function recoveryEvidenceHash(value: unknown): string {
  const normalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === 'object'
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, normalize(item)])
          )
        : entry;
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}
export function parseFrontDeskExecutionRecoveryReceipt(
  value: unknown
): FrontDeskExecutionRecoveryReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const allowed = [
    'version',
    'binding',
    'action_ref',
    'approval_request_id',
    'approval_hash',
    'action_hash',
    'display_digest',
    'actor_id',
    'member_id',
    'browser_session_id',
    'terminated_at',
    'reason',
    'recovery_id',
  ];
  const binding = parseFrontDeskExecutionBinding(row.binding);
  if (
    !binding ||
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    row.version !== 1 ||
    row.reason !== 'approval_verification_failed'
  )
    return undefined;
  for (const key of [
    'action_ref',
    'approval_request_id',
    'actor_id',
    'member_id',
    'browser_session_id',
  ])
    if (
      typeof row[key] !== 'string' ||
      !(row[key] as string).trim() ||
      (row[key] as string).length > 512
    )
      return undefined;
  for (const key of ['approval_hash', 'action_hash', 'display_digest'])
    if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key] as string))
      return undefined;
  if (
    typeof row.terminated_at !== 'string' ||
    !Number.isFinite(Date.parse(row.terminated_at)) ||
    !String(row.actor_id).startsWith('user:') ||
    (row.recovery_id !== undefined &&
      (typeof row.recovery_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.recovery_id)))
  )
    return undefined;
  return structuredClone(value) as FrontDeskExecutionRecoveryReceipt;
}
export function sameRecoveryReceipt(
  a: FrontDeskExecutionRecoveryReceipt,
  b: FrontDeskExecutionRecoveryReceipt
): boolean {
  return recoveryEvidenceHash(a) === recoveryEvidenceHash(b);
}
