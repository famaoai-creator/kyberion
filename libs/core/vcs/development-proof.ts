/** Promotion facts read through the canonical, read-only gh transport. No
 * caller-supplied check names or pass flags are accepted as CI authority. */
import { safeExecResult } from '../secure-io.js';
import { computeApprovalPayloadHash } from '../governance/approval-store.js';
import {
  diagnoseGhResult,
  ghMust,
  ghPrView,
  ghPrQueued,
  ghRun,
  type GhCallOptions,
} from './github.js';
import type { VcsCommandRunner } from './git.js';

export interface VcsDevelopmentRevision {
  repository: string;
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
}
export interface VcsDevelopmentPr extends VcsDevelopmentRevision {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergeCommitSha?: string;
  queued?: boolean;
}
export interface VcsDevelopmentCiProof {
  state: 'success' | 'pending' | 'failure' | 'unverified';
  policyDigest: string;
  requiredChecks: string[];
  reasons: string[];
}
const sha = /^[a-f0-9]{40,64}$/i;
interface PrRow {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeCommit?: { oid: string };
  autoMergeRequest?: unknown;
  mergeQueueEntry?: unknown;
}
interface RequiredCheck {
  context: string;
  app_id: number;
  integration_id: number;
}
interface Rule {
  type: string;
  parameters: {
    strict_required_status_checks_policy: boolean;
    required_status_checks: RequiredCheck[];
  };
}
interface Check {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string;
  app: { id: number; slug: string };
  check_suite: { id: number };
}
interface Workflow {
  head_sha: string;
  check_suite_id: number;
  path: string;
}
interface Metadata {
  strict: boolean;
  checks: RequiredCheck[];
  contexts: string[];
  total_count: number;
  check_runs: Check[];
  workflow_runs: Workflow[];
  type: string;
  sha: string;
  tree: Array<{ path: string; sha: string; type: string }>;
  truncated: boolean;
}

export function readVcsDevelopmentPr(
  ref: string,
  options: GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): VcsDevelopmentPr {
  const row = ghPrView(
    {
      ...options,
      ref,
      fields:
        'number,url,state,isDraft,headRefOid,baseRefOid,headRefName,baseRefName,mergedAt,mergeCommit,autoMergeRequest',
    },
    run
  ) as unknown as PrRow;
  const repository = readVcsDevelopmentRepository(options, run);
  if (
    !Number.isInteger(row.number) ||
    row.number <= 0 ||
    row.url !== `${repository.url}/pull/${row.number}` ||
    !sha.test(row.headRefOid) ||
    !sha.test(row.baseRefOid) ||
    !row.headRefName ||
    !row.baseRefName ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(row.state)
  )
    throw new Error('[VCS_DEVELOPMENT_SNAPSHOT] Invalid current PR revision');
  return {
    repository: repository.url,
    headSha: row.headRefOid,
    baseSha: row.baseRefOid,
    headBranch: row.headRefName,
    baseBranch: row.baseRefName,
    number: row.number,
    url: row.url,
    state: row.state.toLowerCase() as VcsDevelopmentPr['state'],
    queued:
      row.state === 'OPEN' &&
      (Boolean(row.autoMergeRequest) ||
        ghPrQueued(
          {
            ...options,
            owner: repository.slug.split('/')[0],
            name: repository.slug.split('/')[1],
            number: row.number,
            hostname: repository.host,
          },
          run
        )),
    draft: row.isDraft === true,
    ...(sha.test(row.mergeCommit?.oid ?? '') ? { mergeCommitSha: row.mergeCommit.oid } : {}),
  };
}
export function readVcsDevelopmentRepository(
  options: GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): { url: string; slug: string; host: string } {
  const row = JSON.parse(ghMust(['repo', 'view', '--json', 'nameWithOwner,url'], options, run)) as {
    url: string;
    nameWithOwner: string;
  };
  const url = new URL(String(row.url));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[\w.-]+\/[\w.-]+$/.test(row.nameWithOwner) ||
    url.pathname.replace(/^\//, '').replace(/\/$/, '') !== row.nameWithOwner
  )
    throw new Error('[VCS_DEVELOPMENT_REPOSITORY] Verified repository required');
  return { url: `${url.origin}/${row.nameWithOwner}`, slug: row.nameWithOwner, host: url.host };
}

/** Owner-administered branch requirements, actual App identity and immutable
 * base workflow bytes form the policy floor. A workflow edited by the PR may
 * not manufacture its own successful same-name check. */
export function readVcsDevelopmentCiProof(
  pr: VcsDevelopmentPr,
  options: GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): VcsDevelopmentCiProof {
  const repo = readVcsDevelopmentRepository(options, run);
  if (repo.url !== pr.repository)
    throw new Error('[VCS_DEVELOPMENT_REPOSITORY] PR repository changed');
  const api = <T = Metadata>(suffix: string, missingAllowed = false): T => {
    const result = ghRun(
      ['api', `repos/${repo.slug}/${suffix}`, '--hostname', repo.host],
      options,
      run
    );
    if (result.status !== 0 || result.error) {
      if (missingAllowed && diagnoseGhResult(result).status === 'missing_resource')
        return null as T;
      throw new Error(
        '[VCS_DEVELOPMENT_CI] Cannot verify current CI requirements or check provenance'
      );
    }
    return JSON.parse(result.stdout);
  };
  try {
    const classic = api(
      `branches/${encodeURIComponent(pr.baseBranch)}/protection/required_status_checks`,
      true
    );
    const rules = api<Rule[]>(`rules/branches/${encodeURIComponent(pr.baseBranch)}`, true) ?? [];
    if (!Array.isArray(rules)) throw new Error('Invalid rules');
    const strict =
      classic?.strict === true ||
      rules.some(
        (rule: Rule) =>
          rule.type === 'required_status_checks' &&
          rule.parameters?.strict_required_status_checks_policy === true
      );
    if (!strict)
      return {
        state: 'unverified',
        policyDigest: '',
        requiredChecks: [],
        reasons: [
          'Enable strict server-required checks so concurrent base updates cannot bypass verification',
        ],
      };
    const required: Array<{ name: string; appId?: number }> = [];
    for (const check of classic?.checks ?? [])
      required.push({
        name: check.context,
        ...(Number.isInteger(check.app_id) && check.app_id > 0 ? { appId: check.app_id } : {}),
      });
    if (!classic?.checks?.length)
      for (const name of classic?.contexts ?? []) required.push({ name });
    for (const rule of rules)
      if (rule.type === 'required_status_checks')
        for (const check of rule.parameters?.required_status_checks ?? [])
          required.push({
            name: check.context,
            ...(Number.isInteger(check.integration_id) && check.integration_id > 0
              ? { appId: check.integration_id }
              : {}),
          });
    const unique = [
      ...new Map(required.map((check) => [JSON.stringify(check), check])).values(),
    ].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : (a.appId ?? 0) - (b.appId ?? 0)
    );
    if (
      !unique.length ||
      unique.some((check) => typeof check.name !== 'string' || !check.name.trim()) ||
      new Set(unique.map((check) => check.name)).size !== unique.length
    )
      return {
        state: 'unverified',
        policyDigest: '',
        requiredChecks: [],
        reasons: ['Configure unambiguous server-required CI checks before autonomous promotion'],
      };
    const policyDigest = computeApprovalPayloadHash({
      repository: repo.url,
      base: pr.baseBranch,
      required: unique,
      strict,
      verificationPolicy: 'github-scripts-and-root-files-v1',
    });
    const base = { policyDigest, requiredChecks: unique.map((check) => check.name) };
    const beforeTree = api(`git/trees/${pr.baseSha}`),
      afterTree = api(`git/trees/${pr.headSha}`);
    if (
      !Array.isArray(beforeTree.tree) ||
      !Array.isArray(afterTree.tree) ||
      beforeTree.truncated ||
      afterTree.truncated
    )
      throw new Error('Incomplete verification source tree');
    // Root configuration can replace the runner, install hooks or test selection.
    // Pin all root blobs as well as the two executable verification trees.
    const protectedPaths = new Set([
      '.github',
      'scripts',
      ...beforeTree.tree.filter((row) => row.type !== 'tree').map((row) => row.path),
      ...afterTree.tree.filter((row) => row.type !== 'tree').map((row) => row.path),
    ]);
    for (const name of protectedPaths) {
      const before = beforeTree.tree.find((row) => row.path === name),
        after = afterTree.tree.find((row) => row.path === name);
      if (before?.sha !== after?.sha || before?.type !== after?.type)
        return {
          ...base,
          state: 'unverified',
          reasons: [`Trusted verification source changed: ${name}`],
        };
    }

    const checks = api(`commits/${pr.headSha}/check-runs?per_page=100&filter=latest`);
    if (
      !Array.isArray(checks.check_runs) ||
      checks.total_count > checks.check_runs.length ||
      checks.check_runs.length >= 100
    )
      throw new Error('Truncated check evidence');
    const runs = api(`actions/runs?head_sha=${pr.headSha}&per_page=100`);
    if (
      !Array.isArray(runs.workflow_runs) ||
      runs.total_count > runs.workflow_runs.length ||
      runs.workflow_runs.length >= 100
    )
      throw new Error('Truncated workflow evidence');
    let pending = false,
      failed = false,
      unverified = false;
    const reasons: string[] = [];
    for (const requiredCheck of unique) {
      const matches: Check[] = checks.check_runs.filter(
        (check: Check) => check.name === requiredCheck.name
      );
      if (!matches.length) {
        pending = true;
        reasons.push(`Waiting for ${requiredCheck.name}`);
        continue;
      }
      const check = matches[0];
      if (
        matches.length !== 1 ||
        check.head_sha !== pr.headSha ||
        (requiredCheck.appId !== undefined && check.app?.id !== requiredCheck.appId)
      ) {
        unverified = true;
        reasons.push(`Check identity is not verified: ${requiredCheck.name}`);
        continue;
      }
      if (check.status !== 'completed') {
        pending = true;
        reasons.push(`Waiting for ${requiredCheck.name}`);
        continue;
      }
      if (check.app?.slug === 'github-actions') {
        const workflow = runs.workflow_runs.find(
          (row: Workflow) =>
            row.head_sha === pr.headSha && row.check_suite_id === check.check_suite?.id
        );
        const workflowPath = String(workflow?.path ?? '').split('@')[0];
        if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflowPath)) {
          unverified = true;
          reasons.push(`Workflow origin missing: ${requiredCheck.name}`);
          continue;
        }
        const encoded = workflowPath.split('/').map(encodeURIComponent).join('/');
        const before = api(`contents/${encoded}?ref=${pr.baseSha}`),
          after = api(`contents/${encoded}?ref=${pr.headSha}`);
        if (
          before.type !== 'file' ||
          after.type !== 'file' ||
          !sha.test(before.sha) ||
          before.sha !== after.sha
        ) {
          unverified = true;
          reasons.push(`Caller workflow changed: ${requiredCheck.name}`);
          continue;
        }
      } else if (requiredCheck.appId === undefined) {
        unverified = true;
        reasons.push(`A server-pinned check App is required: ${requiredCheck.name}`);
        continue;
      }
      if (check.conclusion !== 'success') {
        failed = true;
        reasons.push(`Failed required check: ${requiredCheck.name} (${String(check.conclusion)})`);
      }
    }
    return {
      ...base,
      state: unverified ? 'unverified' : failed ? 'failure' : pending ? 'pending' : 'success',
      reasons,
    };
  } catch {
    return {
      state: 'unverified',
      policyDigest: '',
      requiredChecks: [],
      reasons: ['Cannot verify complete server CI requirements and immutable check provenance'],
    };
  }
}

/** Squash promotion must retain the original reviewed baseline as its one parent.
 * Never use the moving PR baseRefOid to authenticate post-merge CI sources. */
export function readVcsDevelopmentMergedCiProof(
  pr: VcsDevelopmentPr,
  options: GhCallOptions,
  run: VcsCommandRunner = safeExecResult
): VcsDevelopmentCiProof {
  const unavailable = (): VcsDevelopmentCiProof => ({
    state: 'unverified',
    policyDigest: '',
    requiredChecks: [],
    reasons: ['Original reviewed baseline is not the verified squash merge parent'],
  });
  if (!pr.mergeCommitSha || !sha.test(pr.baseSha)) return unavailable();
  try {
    const repo = readVcsDevelopmentRepository(options, run);
    if (repo.url !== pr.repository) return unavailable();
    const commit = JSON.parse(
      ghMust(
        ['api', `repos/${repo.slug}/commits/${pr.mergeCommitSha}`, '--hostname', repo.host],
        options,
        run
      )
    ) as { sha: string; parents: Array<{ sha: string }> };
    if (
      commit.sha !== pr.mergeCommitSha ||
      !Array.isArray(commit.parents) ||
      commit.parents.length !== 1 ||
      commit.parents[0].sha !== pr.baseSha
    )
      return unavailable();
    return readVcsDevelopmentCiProof({ ...pr, headSha: pr.mergeCommitSha }, options, run);
  } catch {
    return unavailable();
  }
}
