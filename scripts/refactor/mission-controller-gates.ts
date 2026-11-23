import * as path from 'node:path';
import { baseRoleEnvText } from '@agent/core/foundation';
import { hasCliFlag } from '@agent/core/cli-guard';
import { logger } from '@agent/core/core';
import { DiagnosticError } from '@agent/core/logger';
import { auditChain } from '@agent/core/governance/audit-chain';
import { executionAgentId } from '@agent/core/governance/execution-agent-id';
import { missionEvidenceDir } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { loadState } from '@agent/core/mission/mission-state';
import { extractMissionStartCreateOptionsFromArgv, getOptionValue } from './mission-cli-args.js';
import { validateMissionStartCreateInput } from './mission-controller-args.js';

async function resolveGate(missionId: string, gateFile?: string): Promise<string> {
  const evidDir = missionEvidenceDir(missionId.toUpperCase());
  if (!evidDir) {
    throw new DiagnosticError({
      code: 'MISSION_NOT_FOUND',
      what: `mission ${missionId} evidence directory not found`,
      next: 'check the mission id — run `pnpm mission list` to see known missions',
    });
  }
  if (gateFile) {
    const abs = path.isAbsolute(gateFile) ? gateFile : path.resolve(evidDir, gateFile);
    if (!safeExistsSync(abs)) {
      throw new DiagnosticError({
        code: 'GATE_NOT_FOUND',
        what: 'gate file not found',
        evidence: abs,
        next: 'omit the gate file to auto-pick, or pass one under the mission evidence dir',
      });
    }
    return abs;
  }
  const files = safeReaddir(evidDir) as string[];
  const gates = files.filter((f) => f.endsWith('-gate.json'));
  if (gates.length === 0) {
    throw new DiagnosticError({
      code: 'GATE_NOT_FOUND',
      what: 'no gate files found in the mission evidence directory',
      evidence: evidDir,
      next: 'run the phase that emits the gate, then retry',
    });
  }
  if (gates.length > 1) {
    throw new DiagnosticError({
      code: 'GATE_AMBIGUOUS',
      what: 'multiple gates found — specify which one',
      why: `candidates: ${gates.join(', ')}`,
      next: 'pass the gate file name as an argument',
    });
  }
  return path.join(evidDir, gates[0]);
}

export async function gatePass(
  missionId: string,
  gateFile: string | undefined,
  note: string | undefined,
  argv: string[],
  print: (value: unknown) => void
): Promise<void> {
  const { recordMissionGateOverride } = await import('@agent/core/mission/mission-gate-engine');
  const {
    advanceCurrentPhase,
    evaluateStoredMissionGate,
    markPhaseTasksCompleted,
    readStoredMissionGate,
    requireMissionGateActivation,
  } = await import('@agent/core/mission/mission-process-planning');
  const { activateMissionOnGateProgress } = await import('@agent/core/mission/mission-creation');
  const dryRun = hasCliFlag(argv, '--dry-run');
  const machineOnly = hasCliFlag(argv, '--machine-only');
  const requireGateScope = () => {
    const state = loadState(missionId.toUpperCase());
    if (!state) throw new Error(`Mission ${missionId} was not found in the current scope.`);
    const options = extractMissionStartCreateOptionsFromArgv(argv);
    const selections = [
      ['Tenant', options.tenantSlug, state.tenant_slug],
      ['Tenant', options.tenantId, state.tenant_slug],
      ['Tenant', getOptionValue('--tenant', argv), state.tenant_slug],
      ['Organization', options.organizationId, state.organization_id],
      ['Tier', options.tier, state.tier],
      [
        'Project',
        options.relationships?.project?.project_id,
        state.relationships?.project?.project_id,
      ],
    ];
    for (const [label, selected, saved] of selections) {
      if (selected && selected !== saved)
        throw new Error(
          `[MISSION_GATE_SCOPE_MISMATCH] ${label} does not match the saved Mission scope.`
        );
    }
    return state;
  };
  const inspectActivation = (gateId: string) => {
    const state = requireGateScope();
    if (state.status === 'planned') {
      requireMissionGateActivation(state, gateId);
      const input = validateMissionStartCreateInput('start', missionId, [
        'start',
        missionId,
        '--dry-run',
      ]);
      if (!input.preflight?.ready) throw new Error(input.preflight?.issues.join(' | '));
    }
  };

  const { parseMachineMissionGate, runMachineOnlyMissionGate } =
    await import('../mission/mission_machine_gate.js');
  const inspectStoredGate = (upperId: string, gateId: string) => {
    inspectActivation(gateId);
    const stored = readStoredMissionGate(upperId, gateId);
    if (!stored) throw new Error(`Stored gate definition missing: ${upperId}/${gateId}`);
    if (
      machineOnly &&
      stored.definition.gate.checks.some(
        (check) => check.kind === 'human_override' || check.kind === 'reviewer_approved'
      )
    ) {
      throw new Error(
        `Machine-only gate requires human or reviewer confirmation: ${upperId}/${gateId}`
      );
    }
  };
  if (dryRun) {
    const issues: string[] = [];
    try {
      const { missionId: upperId, gateId } = parseMachineMissionGate({
        missionId: missionId || '',
        gateId: gateFile,
      });
      inspectStoredGate(upperId, gateId);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    print(
      JSON.stringify({
        action: 'gate-pass',
        mission_id: missionId,
        gate_id: gateFile,
        machine_only: machineOnly,
        input: { preflight: { ready: issues.length === 0, issues } },
      })
    );
    return;
  }
  if (machineOnly) {
    await runMachineOnlyMissionGate(
      { missionId: missionId || '', gateId: gateFile },
      {
        evaluateStored: (args) => {
          inspectStoredGate(args.missionId, args.gateId);
          return evaluateStoredMissionGate({ ...args, blocking: true });
        },
        advance: advanceCurrentPhase,
        markCompleted: markPhaseTasksCompleted,
        activate: activateMissionOnGateProgress,
        recordEvaluation: (upperId, gateId, stored) => {
          auditChain.record({
            agentId: executionAgentId('mission_controller'),
            action: stored.evaluation?.verdict === 'pass' ? 'gate.passed' : 'gate.rejected',
            operation: `gate-pass:${gateId}`,
            result: 'completed',
            metadata: {
              mission_id: upperId,
              gate_id: gateId,
              machine_only: true,
              verdict: stored.evaluation?.verdict,
              reasons: stored.evaluation?.reasons,
              evidence_path: stored.evaluation?.evidence_path,
            },
          });
        },
      }
    );

    return;
  }
  if (!missionId) {
    logger.error(
      'Usage: mission_controller gate-pass <MISSION_ID> [gate-file.json|GATE_ID] [--note "..."]'
    );
    return;
  }
  // Human holds (MO-02): --request-approval files the human decision;
  // --approval-request-id applies it as a signed override. A required hold
  // (catalog require_signature) is never passed by this command alone.
  const hold = gateFile && !gateFile.endsWith('.json') ? gateFile : undefined;
  const holdApprovalId = getOptionValue('--approval-request-id', argv);
  let pendingHoldRecord:
    import('@agent/core/mission/mission-gate-hold-approval').MissionGateHoldRecord | undefined;
  let holdMissionPath = '';
  if (hold) {
    const holdApproval = await import('@agent/core/mission/mission-gate-hold-approval');
    const { resolveRequiredHumanHolds } = holdApproval;
    if (hasCliFlag(argv, '--request-approval')) {
      inspectActivation(hold);
      const { missionControllerRequester } = await import('../lib/cli/cli-approval-requester.js');
      const request = holdApproval.createMissionGateHoldApprovalRequest({
        missionId,
        gateId: hold,
        note,
        requester: missionControllerRequester(getOptionValue('--requested-by', argv)),
      });
      print(JSON.stringify(request, null, 2));
      logger.info(
        `Human approval: review with \`pnpm kyberion approvals\`, then \`pnpm kyberion approvals --approve ${request.id}\`. ` +
          `Afterwards pass the gate with \`pnpm mission gate-pass ${missionId.toUpperCase()} ${hold} --approval-request-id ${request.id}\`.`
      );
      return;
    }
    if (holdApprovalId) {
      inspectActivation(hold);
      const prepared = holdApproval.prepareMissionGateHoldRecord({
        missionId,
        gateId: hold,
        approvalRequestId: holdApprovalId,
      });
      pendingHoldRecord = prepared.record;
      holdMissionPath = prepared.missionPath;
    } else if (resolveRequiredHumanHolds(missionId).some((entry) => entry.gateId === hold)) {
      throw new DiagnosticError({
        code: 'HUMAN_HOLD_APPROVAL_REQUIRED',
        what: `${hold} is a human hold of ${missionId.toUpperCase()} — a person must approve it`,
        why: 'the workflow marks this gate require_signature; gate-pass alone does not pass it',
        next: `pnpm mission gate-pass ${missionId.toUpperCase()} ${hold} --request-approval, then the person runs pnpm kyberion approvals --approve <id>, then gate-pass ... --approval-request-id <id>`,
      });
    }
  }
  // Process-template gates (MO-01/MO-02): when a stored gate definition
  // exists, machine-evaluate its checks instead of recording a bare override.
  // The operator command itself satisfies reviewer/human confirmation checks
  // (a required human hold is decided by its approval proof instead).
  if (gateFile && !gateFile.endsWith('.json')) {
    inspectActivation(gateFile);
    const stored = await evaluateStoredMissionGate({
      missionId,
      gateId: gateFile,
      humanConfirmed: true,
      ...(pendingHoldRecord ? { pendingHoldRecord } : {}),
    });
    if (stored.found && stored.evaluation) {
      const upperId = missionId.toUpperCase();
      auditChain.record({
        agentId: executionAgentId('operator'),
        action: stored.evaluation.verdict === 'pass' ? 'gate.passed' : 'gate.rejected',
        operation: `gate-pass:${gateFile}`,
        result: 'completed',
        metadata: {
          mission_id: upperId,
          gate_id: gateFile,
          verdict: stored.evaluation.verdict,
          reasons: stored.evaluation.reasons,
          evidence_path: stored.evaluation.evidence_path,
          note,
        },
      });
      if (stored.evaluation.verdict === 'pass') {
        if (pendingHoldRecord) {
          const { writeMissionGateHoldRecord } =
            await import('@agent/core/mission/mission-gate-hold-approval');
          const recordPath = writeMissionGateHoldRecord(holdMissionPath, pendingHoldRecord);
          auditChain.record({
            agentId: executionAgentId('operator'),
            action: 'gate.human_hold_approved',
            operation: `gate-pass:${gateFile}`,
            result: 'completed',
            metadata: {
              mission_id: upperId,
              gate_id: gateFile,
              approval_request_id: pendingHoldRecord.approval_request_id,
              approved_by: pendingHoldRecord.approved_by,
              record_path: recordPath,
            },
          });
          logger.info(
            `   Human hold signed for ${pendingHoldRecord.approved_by} (approval ${pendingHoldRecord.approval_request_id}).`
          );
        }
        if (await activateMissionOnGateProgress(upperId, stored.evaluation)) {
          logger.info('   Mission status: planned → active (first gate passed).');
        }
        if (stored.position === 'exit' && stored.phase) {
          await advanceCurrentPhase(upperId, stored.phase);
          const completed = markPhaseTasksCompleted(upperId, stored.phase);
          if (completed > 0) {
            logger.info(`   ${completed} task(s) in phase ${stored.phase} marked completed.`);
          }
        }
        logger.success(`✅ [GATE] ${gateFile} → passed (mission: ${upperId})`);
      } else {
        logger.warn(`❌ [GATE] ${gateFile} checks failed (mission: ${upperId}):`);
        for (const reason of stored.evaluation.reasons) logger.warn(`   - ${reason}`);
        logger.info(
          '   Resolve the failing checks, or record a legacy override via a gate evidence file.'
        );
      }
      return;
    }
  }
  if (pendingHoldRecord) {
    throw new Error(
      `[MISSION_GATE_NOT_FOUND] ${missionId.toUpperCase()} has no stored gate definition ${gateFile}; a human hold approval applies only to a stored gate.`
    );
  }
  requireGateScope();
  const gatePath = await resolveGate(missionId, gateFile);
  const overridePath = recordMissionGateOverride({
    missionId: missionId.toUpperCase(),
    gateId: path.basename(gatePath).replace(/-\w+\.json$/u, ''),
    outcome: 'passed',
    note,
    actorId: baseRoleEnvText() || 'operator',
    evidenceDir: path.dirname(gatePath),
  });
  auditChain.record({
    agentId: executionAgentId('operator'),
    action: 'gate.passed',
    operation: `gate-pass:${path.basename(gatePath)}`,
    result: 'completed',
    metadata: {
      mission_id: missionId.toUpperCase(),
      gate_file: gatePath,
      override_path: overridePath,
      note,
    },
  });
  logger.success(
    `✅ [GATE] ${path.basename(gatePath)} → passed (mission: ${missionId.toUpperCase()})`
  );
  logger.info(`   Override record: ${overridePath}`);
}

export async function gateFail(missionId: string, gateFile?: string, note?: string): Promise<void> {
  const { recordMissionGateOverride } = await import('@agent/core/mission/mission-gate-engine');
  const { evaluateStoredMissionGate, markPhaseTasksForRework } =
    await import('@agent/core/mission/mission-process-planning');
  if (!missionId) {
    logger.error(
      'Usage: mission_controller gate-fail <MISSION_ID> [gate-file.json|GATE_ID] [--note "..."]'
    );
    return;
  }
  // Process-template gates: record the failure and flip the phase's tasks to
  // rework so dependency-first dispatch re-executes them.
  if (gateFile && !gateFile.endsWith('.json')) {
    const stored = await evaluateStoredMissionGate({ missionId, gateId: gateFile });
    if (stored.found) {
      const upperId = missionId.toUpperCase();
      const reworked = stored.phase ? markPhaseTasksForRework(upperId, stored.phase) : 0;
      auditChain.record({
        agentId: executionAgentId('operator'),
        action: 'gate.rejected',
        operation: `gate-fail:${gateFile}`,
        result: 'completed',
        metadata: {
          mission_id: upperId,
          gate_id: gateFile,
          phase: stored.phase,
          reworked_tasks: reworked,
          note,
        },
      });
      logger.warn(`❌ [GATE] ${gateFile} → rejected (mission: ${upperId})`);
      if (reworked > 0) {
        logger.info(`   ${reworked} task(s) in phase ${stored.phase} flipped to rework.`);
      }
      if (note) logger.info(`   Reason: ${note}`);
      return;
    }
  }
  const gatePath = await resolveGate(missionId, gateFile);
  const overridePath = recordMissionGateOverride({
    missionId: missionId.toUpperCase(),
    gateId: path.basename(gatePath).replace(/-\w+\.json$/u, ''),
    outcome: 'rejected',
    note,
    actorId: baseRoleEnvText() || 'operator',
    evidenceDir: path.dirname(gatePath),
  });
  auditChain.record({
    agentId: executionAgentId('operator'),
    action: 'gate.rejected',
    operation: `gate-fail:${path.basename(gatePath)}`,
    result: 'completed',
    metadata: {
      mission_id: missionId.toUpperCase(),
      gate_file: gatePath,
      override_path: overridePath,
      note,
    },
  });
  logger.warn(
    `❌ [GATE] ${path.basename(gatePath)} → rejected (mission: ${missionId.toUpperCase()})`
  );
  logger.info(`   Override record: ${overridePath}`);
  if (note) logger.info(`   Reason: ${note}`);
}
