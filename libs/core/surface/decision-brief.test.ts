import { describe, expect, it } from 'vitest';
import { t } from '../t.js';
import type { VocabularyKey } from '../t.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { decisionReasonText } from './decision-reason-text.js';
import {
  buildDecisionBrief,
  compareDecisionUrgency,
  groupByDecision,
  parsePublicationPreview,
  publicationArtifactRef,
  type DecisionBriefSubject,
  type DisplayText,
} from './decision-brief.js';

const RUN = 'c4396aa619129eea16a92e80be87da7592c122316f3d9514fa4077ffc1b5db76';
const FILE = '29533c06a309d71599a8fbc0c70763d8092b12a3b3b0dc8fa14ecba5373fe54d';
const PR_SUMMARY = `Task: vcs:pr_create\n\nResult:\n- Created active/shared/artifacts/confidential/famao-ai/evidence/pr-publication/${RUN}/${FILE}.json\n\nApproval required:\n- none\n\nDefault action:\n- unknown; no external delivery was performed`;

/** The prod record shape (MSN-SHELL-UX-20261104 evidence), trimmed to the fields read. */
function prCreate(overrides: Partial<DecisionBriefSubject> = {}): DecisionBriefSubject {
  return {
    id: '579a5674-3e34-4bd3-9f68-4584ebb50bd8',
    kind: 'mission_gate',
    channel: 'external-operation',
    title: 'Approval required: vcs:pr_create',
    summary: PR_SUMMARY,
    details: `Operation: vcs:pr_create\nAgent: pipeline-external-worker\n\n${PR_SUMMARY}`,
    severity: 'medium',
    status: 'pending',
    requestedBy: `pipeline:${RUN}`,
    requestedAt: '2026-10-27T17:24:57.597Z',
    accountability: {
      finalDecision: 'human_only',
      min_assurance: 'A2',
      payloadHash: '9cf819125cd040e21effae22fcea9007c8d7fed77374690352fb53f9ebaeb52e',
      effectBinding: 'vcs:pr_create',
    },
    scope: { tenant_slug: 'famao-ai', organization_id: 'famao-ai', tier: 'confidential' },
    ...overrides,
  } as DecisionBriefSubject;
}

const render = (text: DisplayText, locale: 'ja' | 'en' = 'ja') =>
  'text' in text
    ? text.text
    : t(`concierge:${text.key}` as VocabularyKey, text.params as Record<string, string>, locale);

function cardBody(brief: ReturnType<typeof buildDecisionBrief>, locale: 'ja' | 'en' = 'ja') {
  return [
    brief.ask,
    ...brief.why,
    brief.onApprove,
    brief.onReject,
    brief.ifSilent,
    brief.requester,
    ...(brief.recommendation ? [brief.recommendation] : []),
  ]
    .map((line) => render(line, locale))
    .join('\n');
}

const publication = {
  repository: 'famaoai-creator/kyberion',
  title: 'repro2',
  head: 'repro-branch-2',
  base: 'main',
};

describe('buildDecisionBrief — vcs:pr_create', () => {
  it('turns the prod pr_create record into a readable sentence with no hash or path', () => {
    const brief = buildDecisionBrief(prCreate(), { publication, now: Date.parse('2026-11-04') });
    expect(brief.effectId).toBe('vcs:pr_create');
    expect(render(brief.ask)).toBe('famaoai-creator/kyberion に PR「repro2」を作成してよいですか');
    expect(render(brief.requester)).toBe('自動処理（パイプライン）');
    const body = cardBody(brief);
    expect(body).toContain('ブランチ repro-branch-2 → main');
    expect(body).toContain('まだ取り込み（マージ）はされません');
    expect(body).not.toMatch(/[0-9a-f]{32,}/u);
    expect(body).not.toContain('active/shared');
    expect(body).not.toContain('Approval required');
    expect(brief.reversible).toBe(true);
    expect(brief.state).toBe('pending');
    // The machine text is still there — only behind 詳細.
    expect(brief.details.map((row) => row.value).join('\n')).toContain(FILE);
  });

  it('falls back to a safe generic sentence when the PR content is not available', () => {
    const brief = buildDecisionBrief(prCreate({ requestedBy: 'vcs-publication-cli' }));
    expect(render(brief.ask)).toBe('リポジトリに PR（変更の取り込み依頼）を作成してよいですか');
    expect(render(brief.requester)).toBe('自動処理（PR 公開）');
    expect(cardBody(brief)).not.toMatch(/[0-9a-f]{32,}|active\//u);
    expect(render(brief.ask, 'en')).toContain('pull request');
  });

  it('folds identical PRs into one group and keeps different ones apart', () => {
    const a = buildDecisionBrief(prCreate({ id: 'a' }), { publication });
    const b = buildDecisionBrief(prCreate({ id: 'b', requestedBy: 'vcs-publication-cli' }), {
      publication,
    });
    const c = buildDecisionBrief(prCreate({ id: 'c' }), {
      publication: { ...publication, title: 'another' },
    });
    expect(a.groupKey).toBe(b.groupKey);
    expect(a.groupKey).not.toBe(c.groupKey);
    const groups = groupByDecision([{ brief: a }, { brief: c }, { brief: b }]);
    expect(groups.map((group) => group.others.length)).toEqual([1, 0]);
  });

  it('reports a consumed, expired or decided request as not pending', () => {
    const now = Date.parse('2026-11-04T00:00:00Z');
    expect(buildDecisionBrief(prCreate({ expiresAt: '2026-11-01T00:00:00Z' }), { now }).state).toBe(
      'expired'
    );
    expect(
      buildDecisionBrief(
        prCreate({ consumption: { consumedAt: '2026-11-02T00:00:00Z' } as never }),
        { now }
      ).state
    ).toBe('resolved');
    expect(buildDecisionBrief(prCreate({ status: 'approved' }), { now }).state).toBe('resolved');
  });
});

describe('buildDecisionBrief — other kinds', () => {
  it('uses justification impact and risk for a destructive computer action', () => {
    const brief = buildDecisionBrief({
      id: 'x',
      kind: 'channel-approval',
      channel: 'computer',
      title: 'Approval required: close Chrome tab',
      summary: 'A computer interaction requested a destructive browser tab close operation.',
      status: 'pending',
      requestedBy: 'system-actuator',
      requestedAt: '2026-11-01T14:45:30.741Z',
      justification: {
        reason: 'Potentially destructive desktop operation requested through computer_interaction.',
        impactSummary: 'The first matching Chrome tab will be closed.',
      },
      risk: { level: 'medium', restartScope: 'none', requiresStrongAuth: false },
    });
    expect(render(brief.ask)).toBe('「close Chrome tab」を実行してよいですか');
    expect(render(brief.onApprove)).toBe('The first matching Chrome tab will be closed.');
    expect(render(brief.onReject)).toBe('操作は実行されず、依頼元に却下が伝わります。');
    expect(brief.risk).toBe('medium');
  });

  it('carries a dot proposal card question (clamped), recommendation and veto consequence', () => {
    const question = `Kyberion Productization Owner proposes: Measure the readiness scorecard — Run pipelines/continuous-operations-report.json and report ${'the current values of the KRs, '.repeat(8)}done.`;
    const brief = buildDecisionBrief({
      id: 'd',
      kind: 'channel-approval',
      channel: 'dot:kyberion-productization',
      title: '[dot:kyberion-productization] Measure the readiness scorecard (operations report)',
      summary: question,
      status: 'pending',
      requestedBy: 'dot:kyberion-productization',
      requestedAt: '2026-10-24T21:18:04.946Z',
      decisionCard: {
        question,
        recommendation: 'Read-only measurement is the safest next step.',
        riskTier: 'notify',
        riskReasons: ['The agent asked for your judgment'],
        reversible: true,
        evidence: [],
        level: 'veto',
      },
      veto: { windowMinutes: 60 } as never,
    });
    expect('text' in brief.ask && brief.ask.text.endsWith('…')).toBe(true);
    expect(render(brief.ask)).not.toContain('pipelines/');
    expect(brief.askFull).toBeDefined();
    expect(render(brief.recommendation!)).toBe('Read-only measurement is the safest next step.');
    expect(render(brief.onReject)).toBe('提案は止まり、実行されません。');
    expect(render(brief.onApprove)).toBe('提案どおりに作業が始まります。');
    expect(render(brief.ifSilent)).toBe('通知から 60 分たつと、異議がなければ進みます。');
    expect(render(brief.requester)).toBe('エージェントの提案：Kyberion Productization');
    expect(brief.reversible).toBe(true);
  });

  it('localizes a stored English gate reason for a Japanese reader', () => {
    const brief = buildDecisionBrief(
      {
        id: 'r',
        kind: 'channel-approval',
        title: 'Approval required: dot:measure',
        status: 'pending',
        requestedBy: 'dot:kyberion-productization',
        requestedAt: '2026-10-24T21:18:04.946Z',
        decisionCard: {
          question: 'Measure the scorecard?',
          riskTier: 'notify',
          riskReasons: ['The agent asked for your judgment'],
          reversible: true,
          evidence: [],
          level: 'veto',
        },
      } as never,
      { reasonText: decisionReasonText }
    );
    const why = brief.why.map((line) => render(line));
    expect(why).toContain('エージェント自身が人の判断を求めました');
    expect(why).not.toContain('The agent asked for your judgment');
  });

  it('names tenant and provider for a provider attestation', () => {
    const brief = buildDecisionBrief({
      id: 'p',
      kind: 'mission_gate',
      channel: 'tenant-provider-attestation',
      title: 'Provider attestation: codex for tenant famao-ai',
      summary: "Approve sending tenant 'famao-ai' confidential material to 'codex'.",
      status: 'pending',
      requestedBy: 'agent:devin',
      requestedAt: '2026-10-24T09:40:04.979Z',
      expiresAt: '2099-10-27T09:40:04.978Z',
      accountability: {
        finalDecision: 'human_only',
        effectBinding: 'tenant:famao-ai:attest-provider:codex',
      },
      risk: { level: 'high', restartScope: 'manual', requiresStrongAuth: true },
    });
    expect(render(brief.ask)).toBe('famao-ai の機密情報を codex に送ってよいですか');
    expect(brief.reversible).toBe(false);
    expect(brief.deadline).toBe('2099-10-27T09:40:04.978Z');
    expect(render(brief.requester)).toBe('エージェント：Devin');
  });

  it('describes a secret mutation from its target', () => {
    const brief = buildDecisionBrief({
      id: 's',
      kind: 'secret_mutation',
      channel: 'secrets',
      title: 'Rotate slack token',
      summary: 'rotate',
      status: 'pending',
      requestedBy: 'user:owner',
      requestedAt: '2026-10-24T09:40:04.979Z',
      target: { serviceId: 'slack', secretKey: 'bot_token', mutation: 'delete' },
    });
    expect(render(brief.ask)).toBe('slack の認証情報「bot_token」を変更（delete）してよいですか');
    expect(brief.reversible).toBe(false);
  });
});

describe('urgency order', () => {
  it('puts pending first, then the soonest deadline, then higher risk', () => {
    const items = [
      { id: 'late', brief: { state: 'pending' as const, deadline: '2026-12-01T00:00:00Z' } },
      { id: 'expired', brief: { state: 'expired' as const } },
      { id: 'soon', brief: { state: 'pending' as const, deadline: '2026-11-05T00:00:00Z' } },
      { id: 'none-high', brief: { state: 'pending' as const, risk: 'high' as const } },
      { id: 'none-low', brief: { state: 'pending' as const, risk: 'low' as const } },
    ];
    expect([...items].sort(compareDecisionUrgency).map((item) => item.id)).toEqual([
      'soon',
      'late',
      'none-high',
      'none-low',
      'expired',
    ]);
  });
});

describe('publication preview binding', () => {
  it('locates the review artifact only inside the request tenant floor', () => {
    expect(publicationArtifactRef(prCreate())).toMatchObject({
      contentHash: FILE,
      tenantSlug: 'famao-ai',
    });
    expect(
      publicationArtifactRef(prCreate({ scope: { tenant_slug: 'other' } as never }))
    ).toBeUndefined();
  });

  it('accepts only a well-formed preview', () => {
    const effect = {
      repository: { slug: 'famaoai-creator/kyberion' },
      head: 'repro-branch-2',
      base: 'main',
      title: 'repro2',
      body: 'body2',
    };
    expect(parsePublicationPreview(effect)).toEqual(publication);
    expect(parsePublicationPreview({ ...effect, repository: { slug: '../etc' } })).toBeUndefined();
    // The reader compares this hash with the artifact file name.
    expect(computeApprovalPayloadHash(effect)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
