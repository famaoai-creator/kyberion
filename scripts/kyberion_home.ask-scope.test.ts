import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeContext } from '@agent/core/scope-context';
import * as path from 'node:path';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { readDotInboundEvents } from '@agent/core/dot/dot-event-intake';

const mocks = vi.hoisted(() => ({
  scope: { tier: 'public' } as ScopeContext,
  conversation: vi.fn(),
  materialize: vi.fn(),
  a2aRoute: vi.fn(),
  charters: [] as unknown[],
}));
const ASK_ROOT = 'active/shared/tmp/kyberion-home-ask-intake-tests';
const ASK_POLICY = {
  version: '1.0.0',
  sources: {
    'synthetic-ask-intake': {
      enabled: false,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_SYNTHETIC_ASK_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      tenant_slug: 'synthetic-ask',
      max_body_bytes: 4096,
    },
  },
};
vi.mock('@agent/core/dot/dot-event-intake', async (original) => {
  const actual = await original<typeof import('@agent/core/dot/dot-event-intake')>();
  return {
    ...actual,
    ingestAskIntake: (input: Parameters<typeof actual.ingestAskIntake>[0]) =>
      actual.ingestAskIntake({
        ...input,
        charters: mocks.charters as DotCharter[],
        policy: ASK_POLICY,
        rootDir: ASK_ROOT,
      }),
  };
});
vi.mock('@agent/core/mesh/a2a-bridge', () => ({ a2aBridge: { route: mocks.a2aRoute } }));
vi.mock('@agent/core/scope-context', async (original) => ({
  ...(await original<object>()),
  currentScope: () => mocks.scope,
}));
vi.mock('@agent/core/surface/surface-runtime-orchestrator', () => ({
  runSurfaceMessageConversation: mocks.conversation,
}));
vi.mock('@agent/core/execution-feedback', async (original) => ({
  ...(await original<object>()),
  materializeExecutionFeedbackCandidate: mocks.materialize,
}));
import { main } from './kyberion_home.js';

const organizationScope: ScopeContext = {
  tier: 'confidential',
  tenant_slug: 'synthetic-ask',
  organization_id: 'org-a',
  project_id: 'project-a',
  mission_id: 'MSN-SYNTHETIC-ASK',
  task_id: 'task-a',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  mocks.scope = { tier: 'public' };
  mocks.charters = [];
  mocks.materialize.mockReturnValue({ candidate: null });
  mocks.conversation.mockResolvedValue({ text: 'Recorded.', executionFeedbackRecord: undefined });
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (safeExistsSync(ASK_ROOT)) safeRmSync(ASK_ROOT, { recursive: true, force: true });
});

function orgDot(organizationId: string): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: `${organizationId}-intake`,
    version: '1.0.0',
    title: 'Org intake',
    purpose: 'Take operator asks for the organization.',
    status: 'active',
    scope: { tier: 'confidential', tenant_slug: 'synthetic-ask', organization_id: organizationId },
    goal: { statement: 'Handle operator asks.' },
    attention: { triggers: [{ kind: 'event', sources: ['synthetic-ask-intake'] }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: `dot-${organizationId}-intake` },
  };
}

describe('CLI ask scope and source correlation', () => {
  it.each([
    ['tenant', 'テナントの有効化状況を確認するには？'],
    ['objectives', '組織のOKRの進捗と関連プロジェクトを見る方法を教えて'],
    ['portfolio', '複数のプロジェクトを俯瞰するには？'],
    ['operations', '組織の定期オペレーションの実行履歴を見るには？'],
    ['project', '既存プロジェクトの状態を確認する方法は？'],
    ['track', 'プロジェクトのTrackで次のゲートと必要な成果物を確認するには？'],
    ['mission', '既存ミッションを再開する前に次の手順を確認したい'],
    ['workitem', '既存WorkItemの担当と引き継ぎ状況を確認する方法は？'],
    ['artifact', 'ミッションの成果物とレビュー・配布状況を見るには？'],
    ['model', '役割ごとに選ばれている推論モデルを確認するには？'],
    ['workspace', '作業用ワークスペースの掃除を事前確認するには？'],
    ['peer', 'テナントに登録されたPeerを確認する方法は？'],
    ['ingress', 'Tailscaleで公開する前に何を確認すればよいですか？'],
    ['actuator', 'PDFを読むアクチュエータを探す方法は？'],
    ['track', 'How do I find the next gate for a project track?'],
    ['task', 'タスクセッションを再開するには？'],
    ['task', '定型タスクを探すには？'],
    ['knowledge', '知識を登録して再利用するには？'],
    ['knowledge', 'ナレッジの取り込み状況を見るには？'],
    ['approval', '承認待ちを確認するには？'],
    ['approval', '立ち上げの承認ゲートを確認するには？'],
    ['operations', 'インシデントの対応履歴を見るには？'],
    ['operations', '定例レビューと意思決定の記録を見るには？'],
    ['runtime', 'サービスの登録と接続状況を確認するには？'],
    ['organization', 'NHIの状態を確認するには？'],
    ['workitem', '利用中のリースを確認するには？'],
    ['artifact', '配布の受領証を確認するには？'],
    ['channel', '通知先を確認するには？'],
    ['channel', '受信箱の未読を見るには？'],
    ['channel', 'チャネル連携を確認するには？'],
    ['customer', '顧客とのやりとりを見るには？'],
    ['release', 'リリースノートを作るには？'],
    ['pipeline', 'ADFのサンプルを見るには？'],
    ['credentials', '推論モデルの認証情報を確認するには？'],
    ['task', 'How do I inspect a task session?'],
    ['conversation', 'Kyberionを通して会話するには？'],
    ['conversation', 'Kyberionと会話するには？'],
    ['conversation', 'How do I talk through Kyberion?'],
    ['voice', 'Kyberionと音声で会話するには？'],
    ['channel', 'チームとSlackで会話するには？'],
    ['coordination', '別のKyberionと会話するには？'],
    ['coordination', '同じチェックアウトのClaudeとCodexで会話するには？'],
    ['discussion', '話し合って目標を決めるには？'],
    ['discussion', '議論をエージェントに任せるには？'],
    ['meeting', '会議に代理出席するには？'],
    ['meeting', '会議の文字起こしと宿題を確認するには？'],
    ['conversation', '会話の続きを再開するには？'],
    ['customer', '顧客と相談するには？'],
    ['channel', '通知が届いた会話を探すには？'],
    ['conversation', '手元のOllamaと会話するには？'],
    ['calendar', '日程とタスクの予定をまとめて見るには？'],
    ['audit', '誰が作業しているか監査するには？'],
    ['recovery', '一時停止して安全に再開するには？'],
    ['meeting', 'How do I join a meeting?'],
    ['meeting', 'How do I check meeting consent?'],
  ])('returns the %s guide before organization intake or delegation', async (id, text) => {
    mocks.scope = organizationScope;
    mocks.charters = [orgDot('org-a')];
    const output: unknown[] = [];
    await main(['ask', text, '--json'], (value) => output.push(value));
    expect(JSON.parse(output.join('\n'))).toMatchObject({
      kind: 'lifecycle_guidance',
      verification: 'not_run',
      routes: [{ id, inspection_commands: expect.any(Array) }],
    });
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(readDotInboundEvents('synthetic-ask', { rootDir: ASK_ROOT })).toHaveLength(0);
  });

  it('offers ways to clarify who the user wants to talk with without starting a turn', async () => {
    const output: unknown[] = [];
    await main(['ask', 'Kyberion 通しで会話したい', '--json'], (value) => output.push(value));
    const data = JSON.parse(output.join('\n'));
    expect(data.clarification.question).toBe('誰と会話したいですか？');
    expect(data.clarification.choices.map(({ domain }: { domain: string }) => domain)).toEqual([
      'conversation',
      'channel',
      'coordination',
    ]);
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it.each(['What is a Track?', 'Trackとは何ですか？'])(
    'returns the glossary reference for %s',
    async (text) => {
      const output: unknown[] = [];
      await main(['ask', text, '--json'], (value) => output.push(value));
      expect(JSON.parse(output.join('\n'))).toMatchObject({
        kind: 'lifecycle_guidance',
        definition_ref: 'docs/GLOSSARY.md#track',
        routes: [{ id: 'track' }],
      });
      expect(mocks.conversation).not.toHaveBeenCalled();
    }
  );

  it.each([
    'Create a new project.',
    'What is the status of my mission?',
    'What are the current pending approvals?',
    'How do I find the project track and start it?',
    '会議に代理出席して議事録を送ってください。',
    '別のKyberionにメッセージを送ってください。',
    'How do I find the project track? Then create the release.',
    'プロジェクトを作成してからトラックを確認する方法は？',
  ])('preserves the execution path for %s', async (text) => {
    await main(['ask', text, '--json']);
    expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });

  it('carries the selected complete scope without overriding its tier with the CLI default', async () => {
    mocks.scope = organizationScope;
    await main([
      'ask',
      'feedback use-case-synthetic: dissatisfied: Check the original brief.',
      '--correlation-id',
      'original-execution',
      '--json',
    ]);
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { ...organizationScope, scope_kind: 'task' },
        missionId: organizationScope.mission_id,
        correlationId: 'original-execution',
        threadTs: 'original-execution',
        executionFeedback: expect.objectContaining({
          scenario_id: 'use-case-synthetic',
          outcome: 'dissatisfied',
        }),
      })
    );
  });

  it.each(['en', 'ja'] as const)(
    'forwards the selected %s locale through the input helper',
    async (locale) => {
      mocks.scope = organizationScope;
      await main([
        'ask',
        'feedback use-case-synthetic: dissatisfied',
        '--locale',
        locale,
        '--json',
      ]);
      expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({ locale }));
    }
  );

  it('passes the returned scoped feedback record unchanged into candidate materialization', async () => {
    mocks.scope = organizationScope;
    const record = {
      feedback_id: 'synthetic',
      scope: organizationScope,
      correlation_id: 'source-1',
    };
    mocks.conversation.mockResolvedValue({ text: 'Recorded.', executionFeedbackRecord: record });
    await main(['ask', 'feedback use-case-synthetic: dissatisfied', '--json']);
    expect(mocks.materialize).toHaveBeenCalledWith({ feedback: record });
  });

  it('records scoped feedback and a review-only learning candidate through the real entrypoint', async () => {
    mocks.scope = organizationScope;
    const actualConversation = await vi.importActual<
      typeof import('@agent/core/surface/surface-runtime-orchestrator')
    >('@agent/core/surface/surface-runtime-orchestrator');
    const actualFeedback = await vi.importActual<typeof import('@agent/core/execution-feedback')>(
      '@agent/core/execution-feedback'
    );
    mocks.conversation.mockImplementation(actualConversation.runSurfaceMessageConversation);
    mocks.materialize.mockImplementation(actualFeedback.materializeExecutionFeedbackCandidate);
    const output: unknown[] = [];
    try {
      await main(
        [
          'ask',
          'feedback use-case-synthetic: dissatisfied: Check the original brief.',
          '--correlation-id',
          'original-execution',
          '--json',
        ],
        (value) => output.push(value)
      );
      const result = JSON.parse(String(output[0]));
      expect(result.executionFeedbackRecord).toMatchObject({
        scope: organizationScope,
        correlation_id: 'original-execution',
      });
      expect(result.improvement.candidate).toMatchObject({
        scope: organizationScope,
        status: 'proposed',
        evidence_refs: expect.arrayContaining(['correlation:original-execution']),
      });
      expect(
        actualFeedback.inspectExecutionFeedbackLearning(
          result.improvement.candidate.candidate_id,
          organizationScope
        ).blockers[0]
      ).toMatch(/^promotion_scope_not_preserved:/);
    } finally {
      safeRmSync(path.dirname(actualFeedback.resolveExecutionFeedbackPath(organizationScope)), {
        recursive: true,
        force: true,
      });
    }
  });

  it.each([
    ['--tier', 'confidential', '--tenant', 'another-tenant'],
    ['--tier=confidential'],
    ['--tenant=another-tenant'],
    ['--tenant-slug', 'another-tenant'],
    ['--tenantSlug=another-tenant'],
    ['--tenant-id', 'another-tenant'],
    ['--tenantId=another-tenant'],
    ['--organization-id', 'another-org'],
    ['--project-id', 'another-project'],
    ['--mission-id', 'MSN-ANOTHER'],
    ['--task-id', 'another-task'],
    ['--sessionId=another-session'],
    ['--scope', '{"tier":"confidential","tenant_slug":"another-tenant"}'],
  ])('never silently ignores explicit scope options: %j', async (...flags) => {
    for (const selected of [{ tier: 'public' as const }, organizationScope]) {
      mocks.scope = selected;
      await expect(
        main(['ask', 'feedback use-case-synthetic: dissatisfied', ...flags])
      ).rejects.toThrow(/SURFACE_CLI_SCOPE_FLAGS_UNSUPPORTED/);
    }
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('does not mistake scope-looking text inside feedback for a CLI option', async () => {
    const text = 'feedback use-case-synthetic: dissatisfied: Use --tenant=acme only after review.';
    await main(['ask', text, '--json']);
    expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });

  it('refuses scoped non-feedback before any legacy conversation or delegation can start', async () => {
    mocks.scope = organizationScope;
    await expect(main(['ask', 'Implement the next mission task.'])).rejects.toThrow(
      /SURFACE_CLI_SCOPE_UNSUPPORTED/
    );
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('hands a scoped ask to the organization dot as one intake event, with no conversation', async () => {
    mocks.scope = organizationScope;
    mocks.charters = [orgDot('org-a')];
    const output: unknown[] = [];
    await main(['ask', 'Implement the next mission task.', '--json'], (value) =>
      output.push(value)
    );
    const { dotIntake } = JSON.parse(String(output[0]));
    expect(dotIntake).toMatchObject({ status: 'accepted', dot_id: 'org-a-intake' });
    const events = readDotInboundEvents('synthetic-ask', { rootDir: ASK_ROOT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: dotIntake.event_id,
      tenant_slug: 'synthetic-ask',
      organization_id: 'org-a',
    });
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.a2aRoute).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('refuses a scoped ask when only another organization of the tenant has a dot', async () => {
    mocks.scope = organizationScope;
    mocks.charters = [orgDot('org-b')];
    await expect(main(['ask', 'Implement the next mission task.'])).rejects.toThrow(
      /SURFACE_CLI_SCOPE_UNSUPPORTED/
    );
    expect(readDotInboundEvents('synthetic-ask', { rootDir: ASK_ROOT })).toHaveLength(0);
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.a2aRoute).not.toHaveBeenCalled();
  });

  it('keeps legacy unscoped conversations available', async () => {
    mocks.charters = [orgDot('org-a')];
    await main(['ask', 'Hello', '--correlation-id', 'ordinary-turn']);
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello', correlationId: 'ordinary-turn' })
    );
    expect(mocks.conversation.mock.calls[0][0]).not.toHaveProperty('scope');
    expect(readDotInboundEvents('synthetic-ask', { rootDir: ASK_ROOT })).toHaveLength(0);
  });

  it('rejects incomplete selected organization scope instead of silently writing global feedback', async () => {
    mocks.scope = { tier: 'confidential', organization_id: 'org-a' };
    await expect(main(['ask', 'feedback use-case-synthetic: dissatisfied'])).rejects.toThrow(
      /SCOPE/
    );
    expect(mocks.conversation).not.toHaveBeenCalled();
  });
});
