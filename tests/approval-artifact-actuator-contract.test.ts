import { afterEach, describe, expect, it } from 'vitest';
import {
  appendGovernedArtifactJsonl,
  createApprovalRequest,
  decideApprovalRequest,
  listGovernedArtifacts,
  loadApprovalRequest,
  pathResolver,
  readGovernedArtifactJson,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  writeGovernedArtifactJson,
} from '@agent/core';

describe('Approval and artifact actuator contracts', () => {
  const contractChannel = 'contract-test';
  const contractCoordination = pathResolver.rootResolve(`active/shared/coordination/channels/${contractChannel}`);
  const contractObservability = pathResolver.rootResolve(`active/shared/observability/channels/${contractChannel}`);
  const slackCoordination = pathResolver.rootResolve('active/shared/coordination/channels/slack');
  const slackObservability = pathResolver.rootResolve('active/shared/observability/channels/slack');

  afterEach(() => {
    process.env.MISSION_ROLE = 'infrastructure_sentinel';
    if (safeExistsSync(contractCoordination)) safeRmSync(contractCoordination);
    if (safeExistsSync(contractObservability)) safeRmSync(contractObservability);
    process.env.MISSION_ROLE = 'slack_bridge';
    if (safeExistsSync(slackCoordination)) safeRmSync(slackCoordination);
    if (safeExistsSync(slackObservability)) safeRmSync(slackObservability);
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
});
