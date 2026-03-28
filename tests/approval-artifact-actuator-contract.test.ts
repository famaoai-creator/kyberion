import { afterEach, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as path from 'node:path';
import {
  appendGovernedArtifactJsonl,
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeUnlinkSync,
} from '@agent/core';
import {
  listGovernedArtifacts,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '@agent/core/artifacts';
import { createApprovalRequest, decideApprovalRequest, loadApprovalRequest } from '@agent/core/governance';

const rootDir = process.cwd();

function loadJson(filePath: string) {
  return JSON.parse(safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string);
}

describe('Approval and artifact actuator contracts', () => {
  const contractChannel = 'contract-test';
  const contractCoordination = pathResolver.rootResolve(`active/shared/coordination/channels/${contractChannel}`);
  const contractObservability = pathResolver.rootResolve(`active/shared/observability/channels/${contractChannel}`);
  const createdSlackRequestPaths = new Set<string>();

  afterEach(() => {
    process.env.MISSION_ROLE = 'infrastructure_sentinel';
    if (safeExistsSync(contractCoordination)) safeRmSync(contractCoordination);
    if (safeExistsSync(contractObservability)) safeRmSync(contractObservability);
    for (const logicalPath of createdSlackRequestPaths) {
      if (safeExistsSync(logicalPath)) safeUnlinkSync(logicalPath);
    }
    createdSlackRequestPaths.clear();
  });

  it('writes governed artifacts only inside coordination/observability paths', () => {
    const written = writeGovernedArtifactJson(
      'infrastructure_sentinel',
      `active/shared/coordination/channels/${contractChannel}/inbox/test.json`,
      { ok: true },
    );
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      `active/shared/observability/channels/${contractChannel}/events.jsonl`,
      { event: 'x' },
    );

    expect(safeExistsSync(written)).toBe(true);
    expect(
      readGovernedArtifactJson<{ ok: boolean }>(`active/shared/coordination/channels/${contractChannel}/inbox/test.json`)?.ok,
    ).toBe(true);
    expect(listGovernedArtifacts(`active/shared/coordination/channels/${contractChannel}/inbox`)).toContain('test.json');
  });

  it('creates and decides approval requests through the generic store', () => {
    const request = createApprovalRequest('slack_bridge', {
      channel: 'C123',
      storageChannel: 'slack',
      threadTs: '1.234',
      correlationId: 'corr-1',
      requestedBy: 'slack-surface-agent',
      draft: {
        title: 'Deploy change',
        summary: 'Need a human approval',
      },
      sourceText: 'deploy please',
    });

    createdSlackRequestPaths.add(`active/shared/coordination/channels/slack/approvals/requests/${request.id}.json`);
    expect(loadApprovalRequest('slack', request.id)?.status).toBe('pending');

    const decided = decideApprovalRequest('slack_bridge', {
      channel: 'C123',
      storageChannel: 'slack',
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'U123',
    });

    expect(decided.status).toBe('approved');
    const events = safeReadFile(pathResolver.rootResolve('active/shared/observability/channels/slack/approvals.jsonl'), { encoding: 'utf8' }) as string;
    expect(events).toContain('approval_requested');
    expect(events).toContain('approved');
  });

  it('stores a secret mutation approval request with a sovereign-only workflow', () => {
    const request = createApprovalRequest('slack_bridge', {
      channel: 'C123',
      storageChannel: 'slack',
      threadTs: '9.876',
      correlationId: 'corr-secret-1',
      requestedBy: 'slack-bridge',
      draft: {
        title: 'Rotate Slack bot token',
        summary: 'Socket Mode auth failed and requires operator approval',
        details: 'Proposed by the Slack bridge during reconcile',
        severity: 'high',
      },
      kind: 'secret_mutation',
      requestedByContext: {
        surface: 'slack',
        actorId: 'slack-bridge',
        actorRole: 'slack_bridge',
        missionId: 'MSN-SLACK-SECRET-001',
      },
      target: {
        serviceId: 'slack',
        secretKey: 'SLACK_BOT_TOKEN',
        mutation: 'rotate',
        store: 'os_keychain',
        existingValuePresent: true,
      },
      justification: {
        reason: 'Slack socket authentication failed',
        impactSummary: 'slack-bridge cannot reconnect until the token is replaced',
      },
      risk: {
        level: 'high',
        restartScope: 'service',
        requiresStrongAuth: true,
        policyId: 'secret-slack-rotation',
      },
      workflow: {
        workflowId: 'wf_secret_single_sovereign_v1',
        mode: 'all_required',
        requiredRoles: ['sovereign'],
        currentStage: 'primary_approval',
        stages: [
          { stageId: 'primary_approval', requiredRoles: ['sovereign'] },
        ],
        approvals: [
          { role: 'sovereign', status: 'pending' },
        ],
      },
    });

    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(loadJson('schemas/secret-mutation-approval.schema.json'));
    const canonical = {
      request_id: request.id,
      kind: request.kind,
      status: request.status,
      created_at: request.requestedAt,
      expires_at: request.expiresAt,
      requested_by: {
        surface: request.requestedByContext?.surface,
        actor_id: request.requestedByContext?.actorId,
        actor_role: request.requestedByContext?.actorRole,
        mission_id: request.requestedByContext?.missionId,
        runtime_id: request.requestedByContext?.runtimeId,
      },
      target: {
        service_id: request.target?.serviceId,
        secret_key: request.target?.secretKey,
        mutation: request.target?.mutation,
        store: request.target?.store,
        new_value_fingerprint: request.target?.newValueFingerprint,
        existing_value_present: request.target?.existingValuePresent,
      },
      justification: {
        reason: request.justification?.reason,
        impact_summary: request.justification?.impactSummary,
        evidence: request.justification?.evidence,
        requested_effects: request.justification?.requestedEffects,
      },
      risk: {
        level: request.risk?.level,
        restart_scope: request.risk?.restartScope,
        requires_strong_auth: request.risk?.requiresStrongAuth,
        policy_id: request.risk?.policyId,
      },
      workflow: {
        workflow_id: request.workflow?.workflowId,
        mode: request.workflow?.mode,
        required_roles: request.workflow?.requiredRoles,
        current_stage: request.workflow?.currentStage,
        stages: request.workflow?.stages.map((stage) => ({
          stage_id: stage.stageId,
          required_roles: stage.requiredRoles,
          description: stage.description,
        })),
        approvals: request.workflow?.approvals.map((approval) => ({
          role: approval.role,
          status: approval.status,
          approved_by: approval.approvedBy,
          approved_at: approval.approvedAt,
          auth_method: approval.authMethod,
          note: approval.note,
        })),
      },
    };

    expect(validate(canonical), ajv.errorsText(validate.errors)).toBe(true);

    const decided = decideApprovalRequest('slack_bridge', {
      channel: 'C123',
      storageChannel: 'slack',
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'sovereign-user',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      note: 'approved from terminal',
    });

    expect(decided.workflow?.approvals[0]).toMatchObject({
      role: 'sovereign',
      status: 'approved',
      approvedBy: 'sovereign-user',
      authMethod: 'manual',
      note: 'approved from terminal',
    });

    createdSlackRequestPaths.add(`active/shared/coordination/channels/slack/approvals/requests/${request.id}.json`);
    expect(loadApprovalRequest('slack', request.id)?.status).toBe('approved');
  });
});
