import { describe, expect, it } from 'vitest';
import { buildDecisionBrief } from '@agent/core/surface/decision-brief';
import {
  actorDisplayName,
  cardSummary,
  kindBrief,
  parseDecisionBrief,
  renderDisplayText,
} from './decision-brief-view';

const RUN = 'c4396aa619129eea16a92e80be87da7592c122316f3d9514fa4077ffc1b5db76';
const SUMMARY = `Task: vcs:pr_create\n\nResult:\n- Created active/shared/artifacts/confidential/famao-ai/evidence/pr-publication/${RUN}/29533c06a309d71599a8fbc0c70763d8092b12a3b3b0dc8fa14ecba5373fe54d.json\n\nApproval required:\n- none\n\nDefault action:\n- unknown; no external delivery was performed`;

function prodBrief() {
  return buildDecisionBrief(
    {
      id: '579a5674-3e34-4bd3-9f68-4584ebb50bd8',
      kind: 'mission_gate',
      channel: 'external-operation',
      title: 'Approval required: vcs:pr_create',
      summary: SUMMARY,
      status: 'pending',
      requestedBy: `pipeline:${RUN}`,
      requestedAt: '2026-10-27T17:24:57.597Z',
      accountability: { finalDecision: 'human_only', effectBinding: 'vcs:pr_create' },
      scope: { tenant_slug: 'famao-ai' },
    } as never,
    {
      publication: {
        repository: 'famaoai-creator/kyberion',
        title: 'repro2',
        head: 'repro-branch-2',
        base: 'main',
      },
    }
  );
}

describe('decision brief (client)', () => {
  it('renders the prod pr_create card in both locales without machine text', () => {
    const brief = parseDecisionBrief(JSON.parse(JSON.stringify(prodBrief())));
    expect(brief).toBeDefined();
    expect(renderDisplayText(brief!.ask, 'ja')).toBe(
      'famaoai-creator/kyberion に PR「repro2」を作成してよいですか'
    );
    expect(renderDisplayText(brief!.ask, 'en')).toBe(
      'Open the pull request "repro2" on famaoai-creator/kyberion?'
    );
    const body = [brief!.ask, ...brief!.why, brief!.onApprove, brief!.onReject, brief!.requester]
      .map((line) => renderDisplayText(line, 'ja'))
      .join('\n');
    expect(body).not.toMatch(/[0-9a-f]{32,}|active\/shared|Approval required/u);
    expect(renderDisplayText(brief!.requester, 'ja')).toBe('自動処理（パイプライン）');
  });

  it('drops a brief with unknown vocabulary keys or a bad shape', () => {
    const good = prodBrief();
    expect(parseDecisionBrief({ ...good, ask: { key: 'home.title' } })).toBeUndefined();
    expect(parseDecisionBrief({ ...good, state: 'approved' })).toBeUndefined();
    expect(parseDecisionBrief(null)).toBeUndefined();
  });

  it('formats ISO instants in params', () => {
    const text = renderDisplayText(
      { key: 'ux_a_veto_if_silent', params: { deadline: '2026-11-05T03:00:00.000Z' } },
      'ja'
    );
    expect(text).not.toContain('2026-11-05T');
    expect(text).toContain('異議がなければ');
  });

  it('names actors for people', () => {
    expect(actorDisplayName('vcs-publication-cli', 'ja')).toBe('自動処理（PR 公開）');
    expect(actorDisplayName('user:owner', 'ja', 'Famao')).toBe('Famao');
    expect(actorDisplayName('kyberion://agent/default/kyberion-prime', 'en')).toBe(
      'Agent: Kyberion Prime'
    );
  });

  it('gives every non-approval kind an ask and per-option effects', () => {
    expect(renderDisplayText(kindBrief('hygiene').ask, 'ja')).toContain('続けますか');
    expect(kindBrief('memory').impacts.map((impact) => impact.labelKey)).toEqual([
      'decide_remember',
      'decide_forget',
    ]);
    expect(kindBrief('outcome').impacts).toHaveLength(2);
    expect(kindBrief('exception').impacts).toHaveLength(0);
  });

  it('strips machine text from a card summary', () => {
    expect(cardSummary(SUMMARY).short).not.toMatch(/[0-9a-f]{32,}|active\//u);
  });
});
