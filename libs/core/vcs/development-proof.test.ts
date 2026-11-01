import { describe, it, expect, vi } from 'vitest';
vi.mock('./external-vcs.js', () => ({
  governVcsCommand: (_o: string, _e: object, f: () => unknown) => f(),
}));
import { readVcsDevelopmentCiProof, type VcsDevelopmentPr } from './development-proof.js';
import type { VcsCommandRunner } from './git.js';
const pr: VcsDevelopmentPr = {
  repository: 'https://github.com/o/r',
  number: 1,
  url: 'https://github.com/o/r/pull/1',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  headBranch: 'agent/kyberion-development',
  baseBranch: 'main',
  state: 'open',
  draft: false,
};
function fixture(
  change: {
    strict?: boolean;
    app?: number;
    conclusion?: string;
    status?: string;
    workflowChanged?: boolean;
    localActionChanged?: boolean;
    rootConfigChanged?: boolean;
    missing?: boolean;
    truncated?: boolean;
  } = {}
): VcsCommandRunner {
  return (_cmd, args) => {
    let row: unknown;
    if (args[0] === 'repo') row = { nameWithOwner: 'o/r', url: pr.repository };
    else if (args[1].includes('/protection/'))
      row = { strict: change.strict !== false, checks: [{ context: 'CI', app_id: 1 }] };
    else if (args[1].includes('/rules/')) row = [];
    else if (args[1].includes('/git/trees/'))
      row = {
        truncated: false,
        tree: [
          {
            path: change.rootConfigChanged ? 'vitest.config.ts' : '.github',
            type: change.rootConfigChanged ? 'blob' : 'tree',
            sha:
              (change.localActionChanged || change.rootConfigChanged) &&
              args[1].endsWith(pr.headSha)
                ? 'd'.repeat(40)
                : 'c'.repeat(40),
          },
        ],
      };
    else if (args[1].includes('/check-runs'))
      row = {
        total_count: change.truncated ? 101 : change.missing ? 0 : 1,
        check_runs: change.missing
          ? []
          : [
              {
                name: 'CI',
                head_sha: pr.headSha,
                app: { id: change.app ?? 1, slug: 'github-actions' },
                status: change.status ?? 'completed',
                conclusion: change.conclusion ?? 'success',
                check_suite: { id: 2 },
              },
            ],
      };
    else if (args[1].includes('/actions/runs'))
      row = {
        total_count: 1,
        workflow_runs: [
          { head_sha: pr.headSha, check_suite_id: 2, path: '.github/workflows/ci.yml' },
        ],
      };
    else if (args[1].includes('/contents/'))
      row = {
        type: 'file',
        sha:
          change.workflowChanged && args[1].endsWith(pr.headSha) ? 'd'.repeat(40) : 'c'.repeat(40),
      };
    else return { status: 1, stdout: '', stderr: 'unexpected' };
    return { status: 0, stdout: JSON.stringify(row), stderr: '' };
  };
}
describe('server-derived CI provenance', () => {
  it('accepts unchanged base workflow and server-pinned App', () =>
    expect(readVcsDevelopmentCiProof(pr, {}, fixture()).state).toBe('success'));
  it.each([
    { app: 7 },
    { workflowChanged: true },
    { localActionChanged: true },
    { rootConfigChanged: true },
    { strict: false },
    { truncated: true },
  ])('rejects forged or incomplete authority %j', (change) =>
    expect(readVcsDevelopmentCiProof(pr, {}, fixture(change)).state).toBe('unverified')
  );
  it('missing check is pending', () =>
    expect(readVcsDevelopmentCiProof(pr, {}, fixture({ missing: true })).state).toBe('pending'));
  it('queued check is pending', () =>
    expect(readVcsDevelopmentCiProof(pr, {}, fixture({ status: 'queued' })).state).toBe('pending'));
  it('failed check requires repair', () =>
    expect(readVcsDevelopmentCiProof(pr, {}, fixture({ conclusion: 'failure' })).state).toBe(
      'failure'
    ));
});

import { ghPrQueued, ghRun } from './github.js';
describe('typed merge queue transport', () => {
  it('observes actual server queue membership', () => {
    const run: VcsCommandRunner = () => ({
      status: 0,
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { mergeQueueEntry: { id: 'queued' } } } },
      }),
      stderr: '',
    });
    expect(ghPrQueued({ owner: 'o', name: 'r', number: 1, hostname: 'github.com' }, run)).toBe(
      true
    );
  });
  it('rejects arbitrary GraphQL through generic read transport', () => {
    expect(() =>
      ghRun([
        'api',
        'graphql',
        '--hostname',
        'github.com',
        '-f',
        'query=mutation{deleteRepository}',
      ])
    ).toThrow('VCS_TYPED_VERB_REQUIRED');
  });
});
