import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applySlackApprovalDecision,
  buildSlackSurfacePrompt,
  buildSlackApprovalBlocks,
  buildSlackOnboardingBlocks,
  buildSlackOnboardingModal,
  createSlackApprovalRequest,
  extractSurfaceBlocks,
  handleSlackOnboardingTurn,
  isEnvironmentInitialized,
  loadSlackApprovalRequest,
  parseSlackOnboardingAction,
  parseSlackApprovalAction,
  shouldForceSlackDelegation,
  prepareSlackSurfaceArtifact,
  recordSlackSurfaceArtifact,
  recordChronosSurfaceRequest,
  recordChronosDelegationSummary,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  pathResolver,
} from '@agent/core';
import { runSurfaceConversation } from '@agent/core';
import * as core from '@agent/core';

describe('Channel surface agents', () => {
  const identityPath = pathResolver.rootResolve('knowledge/personal/my-identity.json');
  const visionPath = pathResolver.rootResolve('knowledge/personal/my-vision.md');
  const agentIdentityPath = pathResolver.rootResolve('knowledge/personal/agent-identity.json');
  const withRole = <T>(role: string, fn: () => T): T => {
    const previous = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = role;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previous;
    }
  };
  const baselineIdentity = withRole(
    'sovereign_concierge',
    () => (safeExistsSync(identityPath) ? (safeReadFile(identityPath, { encoding: 'utf8' }) as string) : null)
  );
  const baselineVision = withRole(
    'sovereign_concierge',
    () => (safeExistsSync(visionPath) ? (safeReadFile(visionPath, { encoding: 'utf8' }) as string) : null)
  );
  const baselineAgentIdentity = withRole(
    'sovereign_concierge',
    () => (safeExistsSync(agentIdentityPath) ? (safeReadFile(agentIdentityPath, { encoding: 'utf8' }) as string) : null)
  );

  afterEach(() => {
    const slackDir = pathResolver.rootResolve('active/shared/coordination/channels/slack');
    const slackObsDir = pathResolver.rootResolve('active/shared/observability/channels/slack');
    const chronosDir = pathResolver.rootResolve('active/shared/coordination/chronos');
    const chronosObsDir = pathResolver.rootResolve('active/shared/observability/chronos');
    const onboardingDir = pathResolver.rootResolve('active/shared/coordination/channels/slack/onboarding');
    const personalDir = pathResolver.rootResolve('knowledge/personal');
    process.env.MISSION_ROLE = 'slack_bridge';
    if (safeExistsSync(slackDir)) safeRmSync(slackDir);
    if (safeExistsSync(slackObsDir)) safeRmSync(slackObsDir);
    if (safeExistsSync(onboardingDir)) safeRmSync(onboardingDir);
    process.env.MISSION_ROLE = 'chronos_gateway';
    if (safeExistsSync(chronosDir)) safeRmSync(chronosDir);
    if (safeExistsSync(chronosObsDir)) safeRmSync(chronosObsDir);
    process.env.MISSION_ROLE = 'ecosystem_architect';
    if (baselineIdentity !== null) core.safeWriteFile(identityPath, baselineIdentity);
    else if (safeExistsSync(identityPath)) safeRmSync(identityPath);
    if (baselineVision !== null) core.safeWriteFile(visionPath, baselineVision);
    else if (safeExistsSync(visionPath)) safeRmSync(visionPath);
    if (baselineAgentIdentity !== null) core.safeWriteFile(agentIdentityPath, baselineAgentIdentity);
    else if (safeExistsSync(agentIdentityPath)) safeRmSync(agentIdentityPath);
  });

  it('creates Slack handoff artifacts and events through the Slack surface agent role', () => {
    const artifact = prepareSlackSurfaceArtifact({
      user: 'U123',
      text: 'deploy status please',
      channel: 'C123',
      ts: '1710000000.000100',
      channelType: 'im',
      team: 'T123',
    });

    const inboxPath = recordSlackSurfaceArtifact(artifact);
    expect(safeExistsSync(inboxPath)).toBe(true);

    const eventPath = pathResolver.rootResolve('active/shared/observability/channels/slack/events.jsonl');
    expect(safeExistsSync(eventPath)).toBe(true);

    const content = safeReadFile(inboxPath, { encoding: 'utf8' }) as string;
    expect(content).toContain('slack-surface-agent');
    expect(artifact.shouldAck).toBe(true);
    expect(buildSlackSurfacePrompt({
      user: 'U123',
      text: 'deploy status please',
      channel: 'C123',
      ts: '1710000000.000100',
      channelType: 'im',
    })).toContain('Slack Surface Agent');
    expect(shouldForceSlackDelegation('deploy status please')).toBe(true);
    expect(shouldForceSlackDelegation('ping')).toBe(false);
  });

  it('records Chronos control-plane requests and delegation summaries', () => {
    const requestPath = recordChronosSurfaceRequest({
      query: 'summarize active missions',
      sessionId: 'chronos-session-1',
      requesterId: 'sovereign',
    });

    expect(safeExistsSync(requestPath)).toBe(true);

    const requestJson = JSON.parse(safeReadFile(requestPath, { encoding: 'utf8' }) as string);
    recordChronosDelegationSummary(requestJson.correlation_id, 2, ['agent-a', 'agent-b']);

    const requestEventPath = pathResolver.rootResolve('active/shared/observability/chronos/requests.jsonl');
    const delegationEventPath = pathResolver.rootResolve('active/shared/observability/chronos/delegations.jsonl');
    expect(safeExistsSync(requestEventPath)).toBe(true);
    expect(safeExistsSync(delegationEventPath)).toBe(true);
  });

  it('extracts a2ui and a2a blocks from a surface-agent response', () => {
    const parsed = extractSurfaceBlocks([
      'Hello',
      '```a2ui',
      '{"createSurface":{"surfaceId":"s1","title":"Test"}}',
      '```',
      '```a2a',
      '{"header":{"receiver":"nerve-agent","performative":"request"},"payload":{"text":"help"}}',
      '```',
    ].join('\n'));

    expect(parsed.text).toBe('Hello');
    expect(parsed.a2uiMessages).toHaveLength(1);
    expect(parsed.a2aMessages).toHaveLength(1);
  });

  it('extracts approval blocks from a surface-agent response', () => {
    const parsed = extractSurfaceBlocks([
      'Need approval.',
      '```approval',
      '{"title":"Deploy production change","summary":"Apply schema migration","severity":"high"}',
      '```',
    ].join('\n'));

    expect(parsed.text).toBe('Need approval.');
    expect(parsed.approvalRequests).toHaveLength(1);
    expect(parsed.approvalRequests[0].title).toBe('Deploy production change');
  });

  it('routes uninitialized Slack threads into onboarding and persists identity artifacts', () => {
    process.env.MISSION_ROLE = 'ecosystem_architect';
    if (safeExistsSync(identityPath)) safeRmSync(identityPath);
    if (safeExistsSync(visionPath)) safeRmSync(visionPath);
    if (safeExistsSync(agentIdentityPath)) safeRmSync(agentIdentityPath);

    expect(isEnvironmentInitialized()).toBe(false);

    const first = handleSlackOnboardingTurn({
      channel: 'C123',
      threadTs: '1710000000.000100',
      text: 'hello',
    });
    expect(first.replyText).toContain('オンボーディング');

    const answers = ['Sovereign', 'Japanese', 'Concierge', 'Software Engineering', 'Build a strong AI operating system.', 'KYBERION-PRIME'];
    let current = first;
    for (const answer of answers) {
      current = handleSlackOnboardingTurn({
        channel: 'C123',
        threadTs: '1710000000.000100',
        text: answer,
      });
    }

    expect(current.completed).toBe(true);
    expect(isEnvironmentInitialized()).toBe(true);
    expect(safeExistsSync(pathResolver.rootResolve('knowledge/personal/my-identity.json'))).toBe(true);
    expect(safeExistsSync(pathResolver.rootResolve('knowledge/personal/my-vision.md'))).toBe(true);
    expect(safeExistsSync(pathResolver.rootResolve('knowledge/personal/agent-identity.json'))).toBe(true);
  });

  it('accepts explicit Slack confirmation phrases for the default agent id', () => {
    handleSlackOnboardingTurn({
      channel: 'C123',
      threadTs: '1710000000.000200',
      text: 'hello',
    });

    const answers = [
      'Sovereign',
      'Japanese',
      'Concierge',
      'Software Engineering',
      'Build a strong AI operating system.',
      'いただいた名前で大丈夫です',
    ];

    let current = { replyText: '', completed: false };
    for (const answer of answers) {
      current = handleSlackOnboardingTurn({
        channel: 'C123',
        threadTs: '1710000000.000200',
        text: answer,
      });
    }

    expect(current.completed).toBe(true);
    const agentIdentity = JSON.parse(
      safeReadFile(pathResolver.rootResolve('knowledge/personal/agent-identity.json'), { encoding: 'utf8' }) as string
    );
    expect(agentIdentity.agent_id).toBe('KYBERION-PRIME');
  });

  it('builds interactive Slack onboarding blocks and modal payloads', () => {
    handleSlackOnboardingTurn({
      channel: 'C123',
      threadTs: '1710000000.000300',
      text: 'hello',
    });

    const nameBlocks = buildSlackOnboardingBlocks('C123', '1710000000.000300');
    expect(nameBlocks[1].elements[0].action_id).toBe('slack_onboarding_open_modal');

    handleSlackOnboardingTurn({
      channel: 'C123',
      threadTs: '1710000000.000300',
      text: 'Sovereign',
    });

    const languageBlocks = buildSlackOnboardingBlocks('C123', '1710000000.000300');
    expect(languageBlocks[1].elements[0].action_id).toBe('slack_onboarding_pick');

    const payload = parseSlackOnboardingAction(languageBlocks[1].elements[0].value);
    expect(payload.field).toBe('language');

    const modal = buildSlackOnboardingModal({
      channel: 'C123',
      threadTs: '1710000000.000300',
      field: 'vision',
    });
    expect(modal.callback_id).toBe('slack_onboarding_submit');
    expect(modal.blocks[0].element.multiline).toBe(true);
  });

  it('persists Slack approval requests and decisions', () => {
    const record = createSlackApprovalRequest({
      channel: 'C123',
      threadTs: '1710000000.000400',
      correlationId: 'corr-1',
      requestedBy: 'slack-surface-agent',
      draft: {
        title: 'Deploy production change',
        summary: 'Apply schema migration',
        severity: 'high',
      },
      sourceText: 'deploy this now',
    });

    const blocks = buildSlackApprovalBlocks(record);
    const actionsBlock = blocks.find((block: any) => block.type === 'actions');
    const payload = parseSlackApprovalAction(actionsBlock.elements[0].value);
    expect(payload.decision).toBe('approved');

    const updated = applySlackApprovalDecision({
      requestId: record.id,
      decision: 'approved',
      decidedBy: 'U123',
    });

    expect(updated.status).toBe('approved');
    expect(loadSlackApprovalRequest(record.id)?.decidedBy).toBe('U123');
  });

  it('includes delegated response context when building the summary prompt', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce('```a2a\n{"header":{"receiver":"nerve-agent","performative":"request"},"payload":{"text":"help"}}\n```')
      .mockResolvedValueOnce('final slack reply');

    const spawnSpy = vi.spyOn(core.agentLifecycle, 'spawn').mockResolvedValue({
      agentId: 'slack-surface-agent',
      ask,
      shutdown: async () => {},
      getRecord: () => ({ status: 'ready' } as any),
    } as any);

    const routeSpy = vi.spyOn(core.a2aBridge, 'route').mockResolvedValue({
      a2a_version: '1.0',
      header: { msg_id: '1', sender: 'nerve-agent', performative: 'result' },
      payload: { text: 'delegated answer' },
    } as any);

    const result = await runSurfaceConversation({
      agentId: 'slack-surface-agent',
      query: 'please help',
      senderAgentId: 'kyberion:slack-bridge',
      delegationSummaryInstruction: 'Summarize for Slack.',
    });

    expect(result.text).toBe('final slack reply');
    expect(routeSpy).toHaveBeenCalled();
    expect(ask).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('[Response from nerve-agent]: delegated answer')
    );

    spawnSpy.mockRestore();
    routeSpy.mockRestore();
  });
});
