import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '@agent/core/approval-store';

const mocks = vi.hoisted(() => ({
  listApprovalRequests: vi.fn(),
  safeExecResult: vi.fn(),
  listMissionsInSearchDirs: vi.fn(),
  loadStateAtPath: vi.fn(),
}));

vi.mock('@agent/core/approval-store', () => ({
  listApprovalRequests: mocks.listApprovalRequests,
}));
vi.mock('@agent/core/secure-io', () => ({ safeExecResult: mocks.safeExecResult }));
vi.mock('@agent/core/mission-state', () => ({
  listMissionsInSearchDirs: mocks.listMissionsInSearchDirs,
  loadStateAtPath: mocks.loadStateAtPath,
}));

import {
  approvalToIntervention,
  buildHumanInterventionReport,
  classifyApproval,
  collectHumanInterventions,
  conflictToIntervention,
  formatHumanInterventionReport,
  isFixtureApproval,
  isMainSyncMerge,
  missionStateToIntervention,
  parseGitLog,
  PR_ATTRIBUTION_NOTE,
  prMergeToIntervention,
  type HumanIntervention,
} from './report_human_interventions.js';

function approval(overrides: Partial<ApprovalRequestRecord>): ApprovalRequestRecord {
  return {
    id: 'req-1',
    kind: 'channel-approval',
    storageChannel: 'slack',
    channel: 'slack',
    threadTs: '1',
    correlationId: 'c-1',
    requestedBy: 'slack-surface-agent',
    requestedAt: '2026-09-20T00:00:00.000Z',
    status: 'pending',
    title: 'Approve',
    summary: 'Approve',
    severity: 'medium',
    ...overrides,
  } as ApprovalRequestRecord;
}

function workflow(...notes: string[]): ApprovalRequestRecord['workflow'] {
  return {
    approvals: notes.map((note) => ({ role: 'sovereign', status: 'approved', note })),
  } as unknown as ApprovalRequestRecord['workflow'];
}

const SEP = '\x1f';
const line = (sha: string, parents: string, author: string, at: string, subject: string) =>
  [sha, parents, author, at, subject].join(SEP);

describe('report_human_interventions', () => {
  it('excludes test fixtures by channel, requester, or decider tokens', () => {
    const fixture = (storageChannel: string, requestedBy: string, decidedBy?: string) =>
      isFixtureApproval({ storageChannel, requestedBy, ...(decidedBy ? { decidedBy } : {}) });
    expect(fixture('wisdom-decision-ops-test', 'x')).toBe(true);
    expect(fixture('qm10-contract-1-2', 'x')).toBe(true);
    expect(fixture('plugin-install', 'qm07-test')).toBe(true);
    expect(fixture('personal-workbench', 'human:alice')).toBe(true);
    expect(fixture('slack', 'slack-surface-agent', 'U123')).toBe(true);
    expect(fixture('pipeline-approval', 'pipeline:x', 'test-operator')).toBe(true);
    expect(fixture('slack', 'slack-surface-agent')).toBe(false);
    expect(fixture('slack', 'slack-surface-agent', 'U08ABCDEF')).toBe(false);
    expect(fixture('attestation', 'latest-builder', 'contest-judge')).toBe(false);
    expect(fixture('plugin-install', 'plugin-installer')).toBe(false);
  });

  it('excludes throwaway plugins named by test suites but not real plugin names', () => {
    const plugin = (title: string) =>
      isFixtureApproval({
        storageChannel: 'plugin-install',
        requestedBy: 'plugin-installer',
        title,
      });
    expect(plugin('Approve third-party plugin activation: broken-66503-20aea100-45ba')).toBe(true);
    expect(plugin('Approve third-party plugin activation: permfixture-e2e')).toBe(true);
    expect(plugin('Approve third-party plugin activation: binding-50460')).toBe(true);
    expect(plugin('Approve third-party plugin activation: acme-diagram-tools')).toBe(false);
    expect(plugin('Approve third-party plugin activation: exporter-2026')).toBe(false);
    expect(
      isFixtureApproval({
        storageChannel: 'slack',
        requestedBy: 'agent',
        title: 'Deploy build-12345',
      })
    ).toBe(false);
  });

  it('classifies approvals by kind and channel', () => {
    expect(classifyApproval({ kind: 'secret_mutation', storageChannel: 'terminal' })).toBe(
      'secret'
    );
    expect(classifyApproval({ kind: 'mission_gate', storageChannel: 'brief' })).toBe('planning');
    expect(classifyApproval({ kind: 'mission_gate', storageChannel: 'pipeline-approval' })).toBe(
      'pipeline_gate'
    );
    expect(classifyApproval({ kind: 'channel-approval', storageChannel: 'plugin-install' })).toBe(
      'plugin_install'
    );
    expect(classifyApproval({ kind: 'channel-approval', storageChannel: 'project-trust' })).toBe(
      'pipeline_gate'
    );
    expect(classifyApproval({ kind: 'channel-approval', storageChannel: 'telegram' })).toBe(
      'steering'
    );
    expect(classifyApproval({ kind: 'channel-approval', storageChannel: 'desktop' })).toBe('other');
  });

  it('derives resolution and human wait time from an approval record', () => {
    const decided = approvalToIntervention(
      approval({
        status: 'approved',
        decidedByType: 'human',
        decidedAt: '2026-09-20T02:00:00.000Z',
      })
    );
    expect(decided).toMatchObject({
      resolution: 'human',
      waitMs: 2 * 60 * 60 * 1000,
      category: 'steering',
    });
    expect(approvalToIntervention(approval({ status: 'pending' })).resolution).toBe('unresolved');
    expect(
      approvalToIntervention(
        approval({
          status: 'approved',
          decidedByType: 'ai_agent',
          decidedAt: '2026-09-20T00:01:00Z',
        })
      ).resolution
    ).toBe('agent');
    expect(
      approvalToIntervention(approval({ status: 'approved', decidedAt: '2026-09-20T00:01:00Z' }))
        .resolution
    ).toBe('unattributed');
    expect(approvalToIntervention(approval({ status: 'cancelled' })).resolution).toBe(
      'unattributed'
    );
  });

  it('counts policy auto-approvals as agent only when every decision was automatic', () => {
    const base = {
      kind: 'secret_mutation' as const,
      storageChannel: 'terminal',
      status: 'applied' as const,
      decidedByType: 'human' as const,
      decidedAt: '2026-09-20T00:00:02.000Z',
    };
    expect(
      approvalToIntervention(
        approval({
          ...base,
          workflow: workflow('Auto-approved local low-risk secret introduction'),
        })
      )
    ).toMatchObject({ category: 'secret', resolution: 'agent' });
    expect(
      approvalToIntervention(
        approval({ ...base, workflow: workflow('Auto-approved by policy', 'Reviewed by operator') })
      ).resolution
    ).toBe('human');
  });

  it('parses git logs and classifies merge, squash, and main-sync commits', () => {
    const log = [
      line(
        'a'.repeat(40),
        'p1 p2',
        'famaoai-creator',
        '2026-09-26T10:00:00+09:00',
        'Merge pull request #805 from x/y'
      ),
      line(
        'b'.repeat(40),
        'p3 p4',
        'dependabot[bot]',
        '2026-09-26T11:00:00+09:00',
        'Merge pull request #806 from deps'
      ),
      line(
        'c'.repeat(40),
        'p5 p6',
        'famaoai',
        '2026-09-26T12:00:00+09:00',
        "Merge remote-tracking branch 'origin/main' into agent/x"
      ),
      line(
        'd'.repeat(40),
        'p7',
        'famaoai',
        '2026-09-26T13:00:00+09:00',
        'feat: squash title (#807)'
      ),
      line('e'.repeat(40), 'p8', 'famaoai', '2026-09-26T14:00:00+09:00', 'chore: direct commit'),
      '',
    ].join('\n');
    const commits = parseGitLog(log);
    expect(commits).toHaveLength(5);
    expect(prMergeToIntervention(commits[0])).toMatchObject({
      resolution: 'human',
      ref: 'pr:#805',
    });
    expect(prMergeToIntervention(commits[1])).toMatchObject({
      resolution: 'agent',
      ref: 'pr:#806',
    });
    expect(prMergeToIntervention(commits[2])).toBeNull();
    expect(prMergeToIntervention(commits[3])).toMatchObject({
      resolution: 'unattributed',
      ref: 'pr:#807',
    });
    expect(prMergeToIntervention(commits[4])).toBeNull();
    expect(isMainSyncMerge(commits[2])).toBe(true);
    expect(isMainSyncMerge(commits[0])).toBe(false);
    expect(conflictToIntervention(commits[2])).toMatchObject({
      category: 'conflict',
      resolution: 'unattributed',
    });
  });

  it('treats planned and paused missions as currently waiting on a human', () => {
    expect(missionStateToIntervention('MSN-A', 'planned', '2026-09-26T00:00:00Z')).toMatchObject({
      category: 'planning',
      resolution: 'unresolved',
    });
    expect(missionStateToIntervention('MSN-B', 'paused', '')?.category).toBe('steering');
    expect(missionStateToIntervention('MSN-C', 'active', '')).toBeNull();
  });

  it('builds a windowed, time-ordered report and keeps mission waits as a snapshot', () => {
    const items: HumanIntervention[] = [
      {
        source: 'git',
        category: 'pr_merge',
        resolution: 'human',
        occurredAt: '2026-09-25T09:00:00+09:00',
        ref: 'pr:#2',
      },
      {
        source: 'git',
        category: 'pr_merge',
        resolution: 'human',
        occurredAt: '2026-08-01T00:00:00Z',
        ref: 'pr:#0',
      },
      {
        source: 'approval_store',
        category: 'secret',
        resolution: 'human',
        occurredAt: '2026-09-25T00:30:00Z',
        waitMs: 1000,
        ref: 'a',
      },
      {
        source: 'approval_store',
        category: 'secret',
        resolution: 'human',
        occurredAt: '2026-09-22T00:00:00Z',
        waitMs: 3000,
        ref: 'b',
      },
      {
        source: 'approval_store',
        category: 'other',
        resolution: 'human',
        occurredAt: 'not-a-date',
        ref: 'c',
      },
      {
        source: 'mission_state',
        category: 'planning',
        resolution: 'unresolved',
        occurredAt: '',
        ref: 'mission:MSN-X',
      },
    ];
    const report = buildHumanInterventionReport({
      items,
      since: '2026-09-01',
      generatedAt: '2026-09-27T00:00:00Z',
      excludedFixtures: 7,
    });
    expect(report.totals.total).toBe(4);
    expect(report.byCategory.pr_merge.total).toBe(1);
    expect(report.byCategory.secret.medianWaitMs).toBe(2000);
    expect(report.missionWaitsSnapshot).toBe(1);
    expect(report.items.map((item) => item.ref)).toEqual(['mission:MSN-X', 'b', 'pr:#2', 'a']);
    expect(report.warnings).toContain('1 item(s) without a parseable timestamp were skipped');
    const text = formatHumanInterventionReport(report);
    expect(text).toContain('Excluded test-fixture approvals: 7');
    expect(text).toContain('Current mission waits (planned/paused, not limited to the window): 1');
    expect(() =>
      buildHumanInterventionReport({
        items,
        since: '2 weeks ago',
        generatedAt: '',
        excludedFixtures: 0,
      })
    ).toThrow(/Invalid since/);
  });
});

describe('collectHumanInterventions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges approval, git, and mission sources and reports replay failures once', () => {
    mocks.listApprovalRequests.mockReturnValue([
      approval({
        id: 'real',
        status: 'approved',
        decidedByType: 'human',
        decidedAt: '2026-09-20T00:05:00Z',
      }),
      approval({ id: 'fx', storageChannel: 'wisdom-decision-ops-test' }),
    ]);
    const mainLog = line(
      'a'.repeat(40),
      'p1 p2',
      'famaoai',
      '2026-09-26T10:00:00Z',
      'Merge pull request #9 from x'
    );
    const syncLog = [
      line(
        'c'.repeat(40),
        'm1 m2',
        'famaoai',
        '2026-09-26T12:00:00Z',
        "Merge branch 'main' into a"
      ),
      line(
        'd'.repeat(40),
        'm3 m4',
        'famaoai',
        '2026-09-26T13:00:00Z',
        "Merge branch 'main' into b"
      ),
      line(
        'e'.repeat(40),
        'm5 m6',
        'famaoai',
        '2026-09-26T14:00:00Z',
        "Merge branch 'main' into c"
      ),
    ].join('\n');
    mocks.safeExecResult.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'log' && args.includes('--first-parent'))
        return { stdout: mainLog, stderr: '', status: 0 };
      if (args[0] === 'log') return { stdout: syncLog, stderr: '', status: 0 };
      const status = args.includes('m1') ? 1 : args.includes('m3') ? 0 : 129;
      return { stdout: '', stderr: '', status };
    });
    mocks.listMissionsInSearchDirs.mockReturnValue([
      { missionId: 'MSN-WAIT', missionPath: '/m/wait' },
      { missionId: 'MSN-BAD', missionPath: '/m/bad' },
    ]);
    mocks.loadStateAtPath.mockImplementation((statePath: string) =>
      statePath.includes('wait')
        ? { status: 'planned', history: [{ ts: '2026-09-01T00:00:00Z' }] }
        : null
    );

    const result = collectHumanInterventions({ since: '2026-09-01', repoRoot: '/repo' });

    expect(result.excludedFixtures).toBe(1);
    expect(result.items.map((item) => `${item.category}:${item.ref}`)).toEqual([
      'steering:approval:slack/real',
      'pr_merge:pr:#9',
      `conflict:commit:${'c'.repeat(12)}`,
      'planning:mission:MSN-WAIT',
    ]);
    expect(result.warnings).toEqual([
      PR_ATTRIBUTION_NOTE,
      '1 merge-tree replay(s) failed (git >= 2.38 required); conflicts may be undercounted',
      'unreadable mission state: MSN-BAD',
    ]);
  });

  it('keeps going when git is unavailable', () => {
    mocks.listApprovalRequests.mockReturnValue([]);
    mocks.safeExecResult.mockReturnValue({ stdout: '', stderr: 'not a git repo', status: 128 });
    mocks.listMissionsInSearchDirs.mockReturnValue([]);

    const result = collectHumanInterventions({ since: '2026-09-01', repoRoot: '/repo' });

    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([
      'git log on origin/main failed; PR merges not counted',
      'git log of local and origin branches failed; conflicts not counted',
    ]);
  });
});
