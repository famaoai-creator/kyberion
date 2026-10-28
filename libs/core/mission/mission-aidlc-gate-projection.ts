/** AI-DLC is a read model of canonical mission gate records, never a second gate. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createAiDlcPhaseState,
  loadAiDlcPhaseState,
  projectAiDlcGateReceipt,
  saveAiDlcPhaseState,
  type AiDlcGateReceipt,
  type AiDlcPhaseState,
} from '../aidlc-phase-state.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';
import { frameUntrustedInput } from '../untrusted-input-framing.js';
import {
  existingMissionPath,
  loadMissionGateRecordAtPath,
  loadMissionStateSnapshot,
} from './mission-gate-record-reader.js';
import { loadMissionPhaseGateDefinitionAtPath } from './mission-phase-gate-definition-reader.js';
import { fingerprintMissionGateInputs } from './mission-gate-input-fingerprint.js';

function isAiDlcMission(missionId: string): boolean {
  const state = loadMissionStateSnapshot(missionId);
  const process = state?.process_template as Record<string, unknown> | undefined;
  return process?.pattern === 'aidlc_code_change' || process?.workflow_id === 'code-change-aidlc';
}

function phaseOf(value: string): AiDlcGateReceipt['phase'] | null {
  return value === 'alignment' ||
    value === 'execution' ||
    value === 'test' ||
    value === 'self_review'
    ? value
    : null;
}

function regularJsonFiles(directory: string | null): string[] {
  if (!directory || !safeExistsSync(directory)) return [];
  return safeReaddir(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => assertSafeRepositoryPath(path.join(directory, name)))
    .filter((file) => safeLstat(file).isFile());
}

/** Durable publication order wins over clocks. Ambiguous legacy ties fail closed. */
function compareReceiptOrder(
  left: { sequence?: number; checked_at?: string; verdict?: 'pass' | 'fail' },
  right: { sequence?: number; checked_at?: string; verdict?: 'pass' | 'fail' }
): number {
  if (left.sequence !== undefined && right.sequence !== undefined)
    return left.sequence - right.sequence;
  if (left.sequence !== undefined) return 1;
  if (right.sequence !== undefined) return -1;
  const leftTime = left.checked_at ?? '';
  const rightTime = right.checked_at ?? '';
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  if (left.verdict !== right.verdict) return left.verdict === 'fail' ? 1 : -1;
  return 0;
}

/** Rebuild from authoritative receipts, so crash/restart cannot lose a failed gate. */
export function readMissionAiDlcGateProjection(missionId: string): AiDlcPhaseState | null {
  if (!isAiDlcMission(missionId)) return null;
  const definitions = regularJsonFiles(existingMissionPath(missionId, 'gates/definitions')).map(
    (file) => loadMissionPhaseGateDefinitionAtPath(file, missionId)
  );
  const receipts: AiDlcGateReceipt[] = [];
  const files = [
    ...regularJsonFiles(existingMissionPath(missionId, 'gates')),
    ...regularJsonFiles(existingMissionPath(missionId, 'gates/records')),
  ];
  for (const file of files) {
    const record = loadMissionGateRecordAtPath(file, missionId);
    // Overrides remain explicit mission authority; they do not rewrite a failed
    // machine check as a successful technical verification in the learning view.
    if (record.override || !record.checked_at || !record.verdict) continue;
    const definition = definitions.find((candidate) => candidate.gate.id === record.gate_id);
    const phase = definition ? phaseOf(definition.phase) : null;
    if (!definition || !phase) continue;
    if (definition.position !== 'exit' && record.verdict === 'pass') continue;
    const digest = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    const ref = pathResolver.toRepoRelative(file);
    receipts.push({
      receipt_id: `${ref}:${digest}`,
      ...(record.sequence !== undefined ? { sequence: record.sequence } : {}),
      gate_id: definition.gate.id,
      phase,
      verdict: record.verdict,
      checked_at: record.checked_at,
      summary:
        record.reasons?.join('; ') || record.reason || `${record.gate_id}: ${record.verdict}`,
      artifact_refs: [ref],
      open_questions: record.verdict === 'fail' ? (record.reasons ?? []) : [],
    });
  }
  receipts.sort(compareReceiptOrder);
  if (receipts.length === 0) return null;
  let projected = createAiDlcPhaseState(missionId, { now: receipts[0]!.checked_at });
  for (const receipt of receipts) projected = projectAiDlcGateReceipt(projected, receipt);
  // Resume metadata is operational history, not gate authority. Never use the
  // saved phase/attempts to override the replay of canonical records.
  const persisted = loadAiDlcPhaseState(missionId);
  if (persisted?.resume_count !== undefined) projected.resume_count = persisted.resume_count;
  if (persisted?.last_resumed_at) projected.last_resumed_at = persisted.last_resumed_at;
  return projected;
}

export function persistMissionAiDlcGateProjection(missionId: string): void {
  const projection = readMissionAiDlcGateProjection(missionId);
  if (projection) saveAiDlcPhaseState(projection);
}

/**
 * Retry admission reads the gate receipt, not the auxiliary phase projection.
 * Only actual blocking contract failures with unchanged declared inputs defer
 * work. Advisory failures, transient commands and re-planning are unaffected.
 */
export function unchangedAiDlcContractFailure(
  missionId: string,
  phase: string
): { gateId: string; reason: string; receiptRef: string } | null {
  if (!isAiDlcMission(missionId)) return null;
  const directory = existingMissionPath(missionId, '');
  if (!directory) return null;
  const definitions = regularJsonFiles(existingMissionPath(missionId, 'gates/definitions'))
    .map((file) => loadMissionPhaseGateDefinitionAtPath(file, missionId))
    .filter((definition) => definition.phase === phase);
  const records = [
    ...regularJsonFiles(existingMissionPath(missionId, 'gates')),
    ...regularJsonFiles(existingMissionPath(missionId, 'gates/records')),
  ].map((file) => ({ file, record: loadMissionGateRecordAtPath(file, missionId) }));
  for (const definition of definitions) {
    const relevant = records.filter(({ record }) => record.gate_id === definition.gate.id);
    relevant.sort((left, right) => compareReceiptOrder(right.record, left.record));
    const latest = relevant[0];
    if (!latest || latest.record.verdict !== 'fail' || latest.record.blocking !== true) continue;
    const failed = latest.record.checks?.filter((check) => !check.passed) ?? [];
    const contractBound = failed.some(
      (check) =>
        check.kind === 'schema_valid' ||
        check.kind === 'quality_contract_valid' ||
        definition.gate.checks.some(
          (declared) =>
            declared.kind === check.kind &&
            Array.isArray(declared.params?.input_paths) &&
            declared.params.input_paths.length > 0
        )
    );
    if (!contractBound || !latest.record.input_digest) continue;
    if (fingerprintMissionGateInputs(definition.gate, directory) !== latest.record.input_digest)
      continue;
    return {
      gateId: definition.gate.id,
      reason:
        'Blocking contract gate failed with unchanged inputs; revise the contract or re-plan before retrying.',
      receiptRef: pathResolver.toRepoRelative(latest.file),
    };
  }
  return null;
}

/** Bounded evidence references and failure summary for owner/worker re-planning. */
export function buildMissionAiDlcFailureLines(missionId: string): string[] {
  const projection = readMissionAiDlcGateProjection(missionId);
  if (!projection?.failure_context) return [];
  const failure = projection.failure_context;
  return [
    '## AI-DLC gate failure — re-plan before retrying',
    'Resolve the failed contract or revise the plan using the evidence below. Do not retry the same broken contract unchanged. Mission gates remain authoritative.',
    frameUntrustedInput({
      source: `mission:${missionId}:gate-failure`,
      data: JSON.stringify({
        failed_phase: failure.failed_phase,
        what_failed: failure.what_failed.slice(0, 2000),
        attempted: failure.attempted.slice(-12),
        open_questions: failure.open_questions.slice(0, 8).map((item) => item.slice(0, 300)),
        artifact_refs: failure.artifact_refs ?? [],
      }),
    }),
  ];
}
