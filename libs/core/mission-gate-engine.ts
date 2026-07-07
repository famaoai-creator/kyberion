import * as path from 'node:path';

import {
  type StructuredOutputSchemaName,
  resolveStructuredOutputSchema,
} from './structured-output-contracts.js';
import { safeExistsSync, safeExec, safeReadFile } from './secure-io.js';
import { safeWriteFile, safeMkdir } from './secure-io.js';
import {
  evaluateDeliverableQuality,
  inferDeliverableKind,
  qualityScoreFromReport,
} from './deliverable-quality.js';

export type MissionGateCheckKind =
  | 'evidence_exists'
  | 'schema_valid'
  | 'command_succeeds'
  | 'reviewer_approved'
  | 'human_override'
  | 'deliverable_quality'
  | 'custom';

export interface MissionGateCheck {
  kind: MissionGateCheckKind;
  params?: Record<string, unknown>;
}

export interface MissionGateDefinition {
  id: string;
  title?: string;
  checks: MissionGateCheck[];
}

export interface MissionGateEvaluation {
  gate_id: string;
  title?: string;
  verdict: 'pass' | 'fail';
  reasons: string[];
  checked_at: string;
  evidence_path?: string;
  checks: Array<{
    kind: MissionGateCheckKind;
    passed: boolean;
    reason?: string;
  }>;
}

export interface MissionGateRecordInput {
  missionId: string;
  gateId: string;
  payload: Record<string, unknown> | MissionGateEvaluation;
  evidenceDir?: string;
  recordPath?: string;
}

export interface MissionGateOverrideInput {
  missionId: string;
  gateId: string;
  outcome: 'passed' | 'rejected';
  note?: string;
  actorId?: string;
  evidenceDir?: string;
}

function toStringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function writeMissionGateRecord(input: MissionGateRecordInput): string {
  const recordDir = input.recordPath ?? input.evidenceDir;
  if (!recordDir) {
    throw new Error('A recordPath or evidenceDir is required to write a mission gate record.');
  }
  safeMkdir(recordDir, { recursive: true });
  const recordPath = input.recordPath
    ? input.recordPath
    : path.join(recordDir, `${input.gateId}-${Date.now().toString(36)}.json`);
  safeWriteFile(
    recordPath,
    JSON.stringify(
      {
        mission_id: input.missionId,
        gate_id: input.gateId,
        ...(input.payload as Record<string, unknown>),
      },
      null,
      2
    )
  );
  return recordPath;
}

export function recordMissionGateOverride(input: MissionGateOverrideInput): string {
  const checkedAt = new Date().toISOString();
  const verdict = input.outcome === 'passed' ? 'pass' : 'fail';
  return writeMissionGateRecord({
    missionId: input.missionId,
    gateId: `${input.gateId}-override`,
    evidenceDir: input.evidenceDir,
    payload: {
      verdict,
      override: true,
      override_outcome: input.outcome,
      ...(input.note ? { note: input.note } : {}),
      ...(input.actorId ? { confirmed_by: input.actorId } : {}),
      checked_at: checkedAt,
      confirmed_at: checkedAt,
      source_gate_id: input.gateId,
    },
  });
}

async function evaluateGateCheck(check: MissionGateCheck): Promise<{
  passed: boolean;
  reason?: string;
}> {
  switch (check.kind) {
    case 'evidence_exists': {
      const params = check.params || {};
      const evidencePaths = toStringList(
        params.paths ?? params.path ?? params.evidence_paths ?? params.evidencePath
      );
      if (evidencePaths.length === 0) {
        return { passed: false, reason: 'No evidence paths were provided.' };
      }
      const missing = evidencePaths.filter((entry) => !safeExistsSync(entry));
      return missing.length === 0
        ? { passed: true }
        : { passed: false, reason: `Missing evidence: ${missing.join(', ')}` };
    }
    case 'schema_valid': {
      const params = check.params || {};
      const schemaName = firstString(params.schema, params.schema_name, params.schemaName) as
        | StructuredOutputSchemaName
        | undefined;
      if (!schemaName) {
        return { passed: false, reason: 'No schema name was provided.' };
      }
      const schema = resolveStructuredOutputSchema(schemaName);
      const value =
        params.value ??
        params.payload ??
        params.data ??
        (typeof params.text === 'string'
          ? (() => {
              try {
                return JSON.parse(params.text as string);
              } catch {
                return undefined;
              }
            })()
          : undefined);
      const result = schema.safeParse(value);
      return result.success
        ? { passed: true }
        : {
            passed: false,
            reason: result.error.issues.map((issue) => issue.message).join('; '),
          };
    }
    case 'command_succeeds': {
      const params = check.params || {};
      const command = firstString(params.command, params.bin);
      if (!command) {
        return { passed: false, reason: 'No command was provided.' };
      }
      const args = Array.isArray(params.args) ? params.args.map((entry) => String(entry)) : [];
      try {
        safeExec(command, args, {
          cwd: firstString(params.cwd),
          timeoutMs:
            typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined,
          env:
            params.env && typeof params.env === 'object'
              ? (params.env as NodeJS.ProcessEnv)
              : undefined,
        });
        return { passed: true };
      } catch (error: any) {
        return { passed: false, reason: error?.message ?? String(error) };
      }
    }
    case 'reviewer_approved': {
      const params = check.params || {};
      const approved =
        params.approved === true ||
        params.verdict === 'approved' ||
        params.decision === 'approved' ||
        params.refuted === false;
      return approved
        ? { passed: true }
        : {
            passed: false,
            reason: firstString(params.reason, params.message) ?? 'Reviewer rejected.',
          };
    }
    case 'human_override': {
      const params = check.params || {};
      const allowed = params.allow !== false;
      return allowed
        ? { passed: true }
        : {
            passed: false,
            reason: firstString(params.reason, params.message) ?? 'Human override denied.',
          };
    }
    case 'deliverable_quality': {
      // Deterministic per-kind rubric gate (MO-01/MO-07 seam): reads the
      // deliverable from disk and scores it via evaluateDeliverableQuality.
      // `min_score` is on a 0..1 scale (ok=1.0, warn=0.5, poor=0).
      const params = check.params || {};
      const artifactPath = firstString(params.path, params.artifact_path, params.deliverable);
      if (!artifactPath) {
        return { passed: false, reason: 'No deliverable path was provided.' };
      }
      if (!safeExistsSync(artifactPath)) {
        return { passed: false, reason: `Deliverable not found: ${artifactPath}` };
      }
      const raw = safeReadFile(artifactPath, { encoding: 'utf8' }) as string;
      let artifact: unknown = raw;
      try {
        artifact = JSON.parse(raw);
      } catch {
        // Non-JSON deliverables (markdown, text) are evaluated as raw text.
      }
      const extension = artifactPath.split('.').pop() ?? '';
      const kind =
        firstString(params.kind, params.deliverable_kind) ?? inferDeliverableKind(extension);
      if (!kind) {
        return {
          passed: false,
          reason: `Could not determine deliverable kind for ${artifactPath}.`,
        };
      }
      const report = evaluateDeliverableQuality(kind, artifact);
      const score = qualityScoreFromReport(report) / 100;
      const minScore =
        typeof params.min_score === 'number' && Number.isFinite(params.min_score)
          ? params.min_score
          : 0.5;
      return score >= minScore
        ? { passed: true }
        : {
            passed: false,
            reason: `Deliverable quality ${score.toFixed(2)} below ${minScore} — ${report.reason}`,
          };
    }
    case 'custom': {
      const params = check.params || {};
      const evaluate = params.evaluate as
        | ((input: { params: Record<string, unknown> }) => unknown | Promise<unknown>)
        | undefined;
      if (typeof evaluate !== 'function') {
        return { passed: false, reason: 'Custom gate missing evaluate() callback.' };
      }
      const result = await Promise.resolve(
        evaluate({
          params,
        })
      );
      if (result && typeof result === 'object') {
        const passed = 'passed' in result ? Boolean((result as any).passed) : Boolean(result);
        const reason = firstString((result as any).reason, (result as any).message);
        return passed
          ? { passed: true }
          : { passed: false, reason: reason ?? 'Custom gate failed.' };
      }
      return result ? { passed: true } : { passed: false, reason: 'Custom gate failed.' };
    }
    default:
      return { passed: false, reason: `Unsupported gate check: ${String(check.kind)}` };
  }
}

export async function evaluateMissionGate(input: {
  missionId: string;
  gate: MissionGateDefinition;
  evidenceDir?: string;
  recordPath?: string;
}): Promise<MissionGateEvaluation> {
  const checkedAt = new Date().toISOString();
  const checks: MissionGateEvaluation['checks'] = [];
  const reasons: string[] = [];
  for (const check of input.gate.checks) {
    const result = await evaluateGateCheck(check);
    checks.push({
      kind: check.kind,
      passed: result.passed,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    if (!result.passed && result.reason) reasons.push(result.reason);
  }

  const evaluation: MissionGateEvaluation = {
    gate_id: input.gate.id,
    ...(input.gate.title ? { title: input.gate.title } : {}),
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    checked_at: checkedAt,
    checks,
  };

  const recordDir = input.recordPath ?? input.evidenceDir;
  if (recordDir) {
    evaluation.evidence_path = writeMissionGateRecord({
      missionId: input.missionId,
      gateId: input.gate.id,
      evidenceDir: input.evidenceDir,
      recordPath: input.recordPath,
      payload: evaluation,
    });
  }

  return evaluation;
}
