/** A bounded VCS stage of the existing continuous mission owner, not another owner. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withLock } from '../foundation/lock-utils.js';
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { pathResolver, findMissionPath } from '../path-resolver.js';
import { missionPathOrNull } from '../mission-lookup.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { ExternalOperationApprovalRequired } from '../governance/external-operation.js';
import {
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from '../workforce/work-coordination.js';
import { loadState } from './mission-state.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { writeMissionNextTasks } from './mission-lifecycle-completion.js';
import { writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import { dispatchMissionWorkItems } from './mission-workitem-dispatch.js';
import type { MissionWorkItemDispatchOptions } from './mission-workitem-dispatch.js';
import {
  runPreparedVcsDevelopment,
  verifyPreparedWorkItemReview,
} from '../vcs/development-loop.js';
import {
  readVcsDevelopmentPr,
  readVcsDevelopmentCiProof,
  readVcsDevelopmentRepository,
} from '../vcs/development-proof.js';
import { gitRun, gitFetch } from '../vcs/git.js';
import { ghPrList } from '../vcs/github.js';
import { runVcsMutationWithWorktreeGovernance } from '../vcs/governance-host.js';
import { vcsHostInvocationId, type VcsHostMutation } from '../vcs/publication-host.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import type { MissionState } from './mission-types.js';
import {
  prepareMissionDevelopmentWorkspace,
  ensureMissionDevelopmentSourceWorkspace,
} from './mission-development-workspace.js';
import { validateTaskSourcePaths } from '../foundation/task-tool-grant-validation.js';
import { DEVELOPMENT_REVIEW_DIFF_MAX_BYTES } from '../vcs/development-review-content.js';
import { provisionMissionEntry, writeProvisionedText } from './mission-orchestration-journal.js';
import { runHardenedGitProbe } from '../shell/git-probe-hardening.js';
import { readTextFile } from '../foundation/text.js';
import {
  recordRequiredCiTaskEvidence,
  type RecordRequiredCiEvidence,
} from './mission-development-ci-evidence.js';

export interface MissionDevelopmentSpec {
  cwd: string;
  repository_url: string;
  source_edit_paths: string[];
  implementation_task_id: string;
  review_task_id: string;
  title: string;
  body_file: string;
  max_repairs?: number;
}
export interface MissionDevelopmentInput {
  missionId: string;
  development: MissionDevelopmentSpec;
  assertCurrent: () => void;
  signal?: AbortSignal;
}
export interface MissionDevelopmentResult {
  status: 'running' | 'pending_approval' | 'blocked' | 'completed';
  reason: string;
  evidence_refs: string[];
  allow_task_dispatch?: boolean;
  approval_request_id?: string;
  ci_verified?: boolean;
}
interface ContinuationState {
  version: 1;
  specification: string;
  repairs: number;
  pushed_head?: string;
  pr_number?: number;
  review_key?: string;
  pending_effect?: 'push' | 'pr_create';
  workspace_owned?: boolean;
  original_target_path?: string;
  fetched_revision?: string;
}
const branch = 'agent/kyberion-development';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closed = new Set(['completed', 'done', 'accepted', 'reviewed']);

/** Injectable domain dependencies retain the same production adapters and authority gates. */
export interface MissionDevelopmentDeps {
  load?: typeof loadState;
  items?: typeof listWorkItems;
  get?: typeof getWorkItem;
  update?: typeof updateWorkItem;
  tasks?: typeof loadMissionNextTaskObjectsAtPath;
  board?: typeof writeMissionNextTasks;
  artifact?: typeof writeDispatchArtifact;
  dispatch?: (state: MissionState, options: MissionWorkItemDispatchOptions) => Promise<unknown>;
  prs?: typeof ghPrList;
  pr?: typeof readVcsDevelopmentPr;
  ci?: typeof readVcsDevelopmentCiProof;
  repository?: typeof readVcsDevelopmentRepository;
  review?: typeof verifyPreparedWorkItemReview;
  reconcile?: typeof runPreparedVcsDevelopment;
  publish?: (mutation: VcsHostMutation) => ReturnType<typeof runVcsMutationWithWorktreeGovernance>;
  git?: typeof gitRun;
  missionPath?: typeof findMissionPath;
  workspace?: typeof prepareMissionDevelopmentWorkspace;
  sourceWorkspace?: typeof ensureMissionDevelopmentSourceWorkspace;
  recordCiEvidence?: RecordRequiredCiEvidence;
}

export async function advanceMissionDevelopment(
  input: MissionDevelopmentInput,
  deps: MissionDevelopmentDeps = {}
): Promise<MissionDevelopmentResult> {
  let ciVerified = false;
  const result = (
    status: MissionDevelopmentResult['status'],
    reason: string
  ): MissionDevelopmentResult => ({
    status,
    reason,
    evidence_refs: [`mission:${input.missionId}`],
    ...(ciVerified ? { ci_verified: true } : {}),
  });
  if (input.development.cwd !== '.')
    return result('blocked', 'Development cwd must be the dedicated owner runtime root');
  return withLock(
    `mission-development:${digest([pathResolver.rootDir(), input.development.cwd, branch])}`,
    async () => {
      const check = () => {
        if (input.signal?.aborted) throw new Error('Development turn aborted');
        input.assertCurrent();
      };
      try {
        check();
        const spec = input.development;
        const sourcePaths = validateTaskSourcePaths(spec.source_edit_paths);
        const maxRepairs = spec.max_repairs ?? 2;
        if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3)
          throw new Error('Development repair budget must be between zero and three');
        if (
          ![spec.implementation_task_id, spec.review_task_id].every((id) =>
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)
          ) ||
          spec.implementation_task_id === spec.review_task_id
        )
          throw new Error('Development requires distinct canonical task identities');
        const state = (deps.load ?? loadState)(input.missionId);
        if (!state) throw new Error('Development mission missing');
        const scope = currentScopeEnvelope()?.identity ?? resolveScopeContext();
        if (
          scope.tier !== state.tier ||
          (scope.tenant_slug ?? '') !== (state.tenant_slug ?? '') ||
          (scope.organization_id ?? '') !== (state.organization_id ?? '')
        )
          throw new Error('Development runtime differs from mission scope');
        if (['paused', 'failed', 'planned'].includes(state.status))
          return result('blocked', 'Activate the governed mission before development advancement');
        const dir = missionPathOrNull(deps.missionPath ?? findMissionPath, input.missionId);
        if (!dir) throw new Error('Development mission directory missing');
        let cwd = path.dirname(assertSafeRepositoryPath(pathResolver.rootResolve('package.json')));
        if ((deps.repository ?? readVcsDevelopmentRepository)({ cwd }).url !== spec.repository_url)
          throw new Error('Development repository differs from the reviewed plan');
        if (
          !/^evidence\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/u.test(spec.body_file) ||
          spec.body_file.split('/').some((part) => !part || part === '.' || part === '..')
        )
          throw new Error('Development body must be a scoped evidence Markdown artifact');
        const bodyFile = assertSafeRepositoryPath(path.resolve(dir, spec.body_file), {
          allowMissingLeaf: true,
        });
        if (!pathResolver.isPathInside(dir, bodyFile))
          throw new Error('PR body must stay inside the mission');
        const tasks =
          (deps.tasks ?? loadMissionNextTaskObjectsAtPath)(
            path.join(dir, 'NEXT_TASKS.json'),
            state.mission_id
          ) ?? [];
        const implTask = tasks.find((task) => task.task_id === spec.implementation_task_id);
        const reviewTask = tasks.find((task) => task.task_id === spec.review_task_id);
        if (!implTask || !reviewTask || reviewTask.review_target !== spec.implementation_task_id)
          throw new Error('Development task and independent review contract mismatch');
        const items = (deps.items ?? listWorkItems)({
          ...(state.tenant_slug ? { tenantSlugs: [state.tenant_slug] } : {}),
          ...(state.organization_id ? { organizationIds: [state.organization_id] } : {}),
        });
        const scoped = items.filter(
          (item) =>
            item.context?.mission_id === state.mission_id &&
            (item.context.tenant_slug ?? '') === (state.tenant_slug ?? '') &&
            (item.context.organization_id ?? '') === (state.organization_id ?? '')
        );
        const matches = scoped.filter(
          (item) => item.context?.task_id === spec.implementation_task_id
        );
        if (matches.length > 1) throw new Error('Ambiguous implementation WorkItem');
        const item = matches[0];
        if (!item)
          return {
            ...result('running', 'Register the canonical mission task WorkItems'),
            allow_task_dispatch: true,
          };
        const pin = digest({
          mission: state.mission_id,
          spec,
          scope: {
            tier: state.tier,
            tenant: state.tenant_slug,
            organization: state.organization_id,
          },
        });
        const previous = item.metadata?.mission_development;
        const progress: ContinuationState =
          previous === undefined
            ? {
                version: 1,
                specification: pin,
                repairs: 0,
                ...(typeof implTask.target_path === 'string'
                  ? { original_target_path: implTask.target_path }
                  : {}),
              }
            : (parseSafeJsonObjectValue(
                previous,
                'development continuation'
              ) as unknown as ContinuationState);
        if (
          progress.version !== 1 ||
          progress.specification !== pin ||
          !Number.isSafeInteger(progress.repairs) ||
          progress.repairs < 0 ||
          progress.repairs > maxRepairs ||
          (progress.fetched_revision !== undefined &&
            (typeof progress.fetched_revision !== 'string' ||
              !/^[a-f0-9]{64}$/u.test(progress.fetched_revision))) ||
          (progress.pending_effect !== undefined &&
            !['push', 'pr_create'].includes(progress.pending_effect)) ||
          (progress.review_key !== undefined &&
            (typeof progress.review_key !== 'string' ||
              !/^[a-f0-9]{64}$/u.test(progress.review_key))) ||
          (progress.pr_number !== undefined &&
            (!Number.isSafeInteger(progress.pr_number) || progress.pr_number < 1))
        )
          throw new Error('Development continuation or specification changed');
        const assertChild = () => {
          check();
          const fresh = (deps.get ?? getWorkItem)(item.item_id);
          if (
            !fresh ||
            fresh.context?.mission_id !== state.mission_id ||
            fresh.context.task_id !== spec.implementation_task_id ||
            (fresh.context.tenant_slug ?? '') !== (state.tenant_slug ?? '') ||
            (fresh.context.organization_id ?? '') !== (state.organization_id ?? '') ||
            fresh.context.project_id !== item.context?.project_id ||
            fresh.assignee_peer_id !== item.assignee_peer_id
          )
            throw new Error('Development WorkItem changed');
          return fresh;
        };
        const save = () => {
          const fresh = assertChild();
          (deps.update ?? updateWorkItem)({
            itemId: fresh.item_id,
            expectedVersion: fresh.version,
            metadata: { ...fresh.metadata, mission_development: progress },
          });
        };
        const dispatch = async (ids: string[]) => {
          assertChild();
          if (!deps.dispatch) {
            const bootstrap = await import('../reasoning/reasoning-bootstrap.js');
            bootstrap.prepareReasoningExecutionHost();
            await import('../mesh/a2a-bridge.js');
            await import('../agent/agent-prompt-approval.js');
          }
          await (deps.dispatch ?? dispatchMissionWorkItems)(state, {
            itemIds: ids,
            limit: 1,
            rounds: 1,
            statuses: ['ready', 'backlog'],
            finalStatus: 'done',
          });
          check();
        };
        const terminal = ['completed', 'archived'].includes(state.status);
        // A reviewed task-board row is not successful implementation acceptance.
        // The canonical dispatcher also leaves failed or pending outputs in review.
        if (item.status === 'review') {
          if (item.lease_id || item.current_attempt_id)
            return result('running', 'Existing implementation review attempt is still active');
          if (item.metadata?.last_independent_reviewer_status === 'refuted') {
            if (terminal)
              return result('blocked', 'Terminal mission has rejected implementation output');
            return queueRepair(input, state, item, progress, maxRepairs, save, deps, result, {
              kind: 'implementation_acceptance_failure',
              reviewer_status: 'refuted',
              reviewer_excerpt: String(item.metadata.last_independent_reviewer_excerpt ?? '').slice(
                0,
                4000
              ),
            });
          }
          return result('running', 'Waiting for canonical implementation acceptance');
        }
        const privateWorkspace = (deps.sourceWorkspace ?? ensureMissionDevelopmentSourceWorkspace)(
          state,
          spec.implementation_task_id,
          sourcePaths,
          () => {
            assertChild();
          },
          { create: !terminal, repositoryUrl: spec.repository_url }
        );
        const taskSourcePaths = privateWorkspace?.sourcePaths ?? sourcePaths;
        if (privateWorkspace) {
          cwd = privateWorkspace.cwd;
          if (!progress.workspace_owned) {
            progress.workspace_owned = true;
            save();
          }
          if (privateWorkspace.created)
            return result(
              'running',
              'Owner allocated the isolated task-owned development repository'
            );
        }
        const workspace = () =>
          (deps.workspace ?? prepareMissionDevelopmentWorkspace)(
            {
              cwd,
              sourcePaths,
              owned: progress.workspace_owned === true,
              commit:
                closed.has(String(implTask.status)) && ['done', 'review'].includes(item.status),
              taskId: spec.implementation_task_id,
              assertCurrent: () => {
                assertChild();
              },
              reserve: () => {
                progress.workspace_owned = true;
                save();
              },
            },
            undefined,
            cwd
          );
        if (!terminal && workspace() === 'advanced')
          return result(
            'running',
            'Owner advanced the candidate branch or exact-file commit stage'
          );
        if (!closed.has(String(implTask.status)) || !['done', 'review'].includes(item.status)) {
          if (terminal)
            return result('blocked', 'Terminal mission lacks completed implementation evidence');
          if (item.status === 'blocked') return pendingWorkItem(item, result);
          if (item.status === 'in_progress')
            return result('running', 'Existing implementation attempt is still active');
          const ancestors = implementationAncestors(tasks, spec.implementation_task_id);
          if (
            digest(implTask.source_edit_paths) !== digest(taskSourcePaths) ||
            implTask.source_edit_requires_approval !== false
          ) {
            check();
            (deps.board ?? writeMissionNextTasks)(dir, (rows) =>
              rows.map((row) =>
                row.task_id === spec.implementation_task_id
                  ? {
                      ...row,
                      source_edit_paths: taskSourcePaths,
                      source_edit_requires_approval: false,
                    }
                  : row
              )
            );
            const current = assertChild();
            (deps.update ?? updateWorkItem)({
              itemId: current.item_id,
              expectedVersion: current.version,
              metadata: { ...current.metadata, development_source_paths: taskSourcePaths },
            });
          }
          await dispatch(
            scoped
              .filter((candidate) => ancestors.has(String(candidate.context?.task_id)))
              .map((candidate) => candidate.item_id)
          );
          return result(
            'running',
            'One canonical prerequisite or implementation WorkItem advanced'
          );
        }
        const read = (args: string[]) => {
          const value = (deps.git ?? gitRun)(args, cwd);
          if (value.status !== 0 || value.error)
            throw new Error('Development repository read failed');
          return value.stdout.trim();
        };
        if (read(['branch', '--show-current']) !== branch || read(['status', '--porcelain']))
          return result(
            'blocked',
            'Prepare a clean committed development branch before publication'
          );
        const head = read(['rev-parse', 'HEAD']);
        if (!/^[a-f0-9]{40,64}$/iu.test(head)) throw new Error('Invalid development commit');
        const repository = (deps.repository ?? readVcsDevelopmentRepository)({ cwd });
        if (repository.url !== spec.repository_url)
          throw new Error('Development repository differs from the reviewed plan');
        const refs = progress.pr_number
          ? []
          : (deps.prs ?? ghPrList)({ cwd, state: 'open', head: branch, limit: 100 });
        if (refs.length > 1) throw new Error('Ambiguous development PR');
        if (!progress.pr_number && refs[0]) {
          if (refs[0].headRefOid !== head)
            throw new Error('Existing PR belongs to another development revision');
          progress.pr_number = refs[0].number;
          progress.pending_effect = undefined;
          save();
        }
        const publish =
          deps.publish ??
          ((mutation: VcsHostMutation) =>
            runVcsMutationWithWorktreeGovernance(
              mutation,
              vcsHostInvocationId(mutation),
              () => {}
            ));
        const effect = (mutation: VcsHostMutation) => {
          assertChild();
          let published;
          try {
            published = publish(mutation);
          } catch (error) {
            if (error instanceof ExternalOperationApprovalRequired) {
              progress.pending_effect = undefined;
              save();
            }
            throw error;
          }
          check();
          if (published.status !== 0 || published.error)
            throw new Error('Publication effect uncertain');
        };
        if (!progress.pr_number) {
          if (terminal) return result('blocked', 'Terminal mission has no recorded development PR');
          if (progress.pending_effect)
            return result(
              'blocked',
              'Prior publication effect is uncertain; reconcile its receipt before retrying'
            );
          if (progress.pushed_head !== head) {
            progress.pending_effect = 'push';
            save();
            effect({
              operation: 'push',
              params: { cwd, remote: 'origin', ref: branch, setUpstream: true },
            });
            progress.pushed_head = head;
            progress.pending_effect = undefined;
            save();
            return result('running', 'Development commit pushed through the governed VCS host');
          }
          if (!safeExistsSync(bodyFile)) {
            assertChild();
            writeProvisionedText({
              missionId: state.mission_id,
              filePath: bodyFile,
              targetPath: spec.body_file,
              missionPathHint: dir,
              provisioned: provisionMissionEntry(
                [
                  `# ${spec.title}`,
                  '',
                  `Mission: ${state.mission_id}`,
                  '',
                  'Implements the approved development task. Independent revision review and required CI are enforced before merge.',
                  '',
                  'Approved source scope:',
                  ...sourcePaths.map((name) => `- ${name}`),
                  '',
                  `Implementation evidence: ${spec.implementation_task_id}`,
                  '',
                ].join('\n')
              ),
            });
          }
          progress.pending_effect = 'pr_create';
          save();
          effect({
            operation: 'pr_create',
            params: { cwd, title: spec.title, bodyFile, head: branch, base: 'main' },
          });
          progress.pending_effect = undefined;
          save();
          return result(
            'running',
            'PR creation accepted; next turn resolves actual remote PR identity'
          );
        }
        const ref = String(progress.pr_number);
        const pr = (deps.pr ?? readVcsDevelopmentPr)(ref, { cwd });
        if (
          pr.repository !== spec.repository_url ||
          pr.headBranch !== branch ||
          pr.baseBranch !== 'main'
        )
          return result('blocked', 'Remote PR and committed implementation differ');
        if (pr.headSha !== head) {
          if (terminal || pr.state !== 'open' || progress.pending_effect)
            return result('blocked', 'Remote revision differs or prior push is uncertain');
          progress.pending_effect = 'push';
          save();
          effect({
            operation: 'push',
            params: { cwd, remote: 'origin', ref: branch, setUpstream: true },
          });
          progress.pushed_head = head;
          progress.pending_effect = undefined;
          save();
          return result(
            'running',
            'Repaired revision pushed; current CI and independent review must run again'
          );
        }
        const ci = (deps.ci ?? readVcsDevelopmentCiProof)(pr, { cwd });
        if (ci.state === 'pending')
          return result('running', 'Waiting for required CI; no repair attempt consumed');
        if (ci.state === 'failure') {
          if (terminal || pr.state !== 'open')
            return result(
              'blocked',
              'Post-publication CI failed; preserve merge evidence for operator recovery'
            );
          return queueRepair(input, state, item, progress, maxRepairs, save, deps, result, {
            kind: 'ci_failure',
            head_sha: pr.headSha,
            required_checks: ci.requiredChecks,
            reasons: ci.reasons,
          });
        }
        if (ci.state !== 'success') return result('blocked', 'CI provenance is unverified');
        const qa = await recordRequiredCiTaskEvidence(
          {
            state,
            missionPath: dir,
            tasks,
            items: scoped,
            pr,
            ci,
            assertCurrent: () => {
              assertChild();
            },
          },
          deps.recordCiEvidence
        );
        ciVerified = qa.verified;
        if (qa.advanced)
          return result(
            'running',
            'Actual required CI recorded as the standard QA contract evidence; local commands were not run'
          );
        const prepared = {
          cwd,
          ref,
          workItemId: item.item_id,
          reviewTaskId: spec.review_task_id,
          dryRun: false,
          requireSourceDiff: true,
        };
        const review = (deps.review ?? verifyPreparedWorkItemReview)(prepared, pr, ci, {
          missionGate: false,
        });
        if (!review.ok) {
          if (terminal || pr.state !== 'open')
            return result('blocked', 'Published revision lacks its independent review proof');
          const reviewerItems = scoped.filter(
            (candidate) => candidate.context?.task_id === spec.review_task_id
          );
          if (reviewerItems.length !== 1)
            return result('blocked', 'Register exactly one independent review WorkItem');
          const reviewer = reviewerItems[0];
          const key = digest([pr.repository, pr.headSha, pr.baseSha, ci.policyDigest]);
          if (progress.review_key !== key) {
            check();
            const codeDiff = runHardenedGitProbe(
              ['diff', '--binary', '--no-ext-diff', '--no-textconv', pr.baseSha, pr.headSha, '--'],
              { cwd, maxOutputMB: 1, timeoutMs: 30_000 },
              deps.git ? (_command, args) => deps.git!(args, cwd) : undefined
            );
            if (codeDiff.status !== 0 || codeDiff.error) {
              if (progress.fetched_revision === key)
                throw new Error(
                  'Immutable source diff remains unavailable after its bounded fetch'
                );
              progress.fetched_revision = key;
              save();
              assertChild();
              const fetched = gitFetch(
                cwd,
                { remote: spec.repository_url, ref: pr.baseSha },
                deps.git ? (_command, args) => deps.git!(args, cwd) : undefined
              );
              if (fetched.status !== 0 || fetched.error)
                throw new Error('Pinned repository baseline fetch failed');
              return result(
                'running',
                'Fetched the pinned repository baseline; immutable diff is rechecked next turn'
              );
            }
            if (
              !codeDiff.stdout ||
              Buffer.byteLength(codeDiff.stdout) > DEVELOPMENT_REVIEW_DIFF_MAX_BYTES
            )
              throw new Error(
                'Current immutable source diff is unavailable or exceeds the bounded review size'
              );
            const relative = `evidence/development/${spec.implementation_task_id}/revision.json`;
            (deps.artifact ?? writeDispatchArtifact)(
              path.join(dir, relative),
              {
                kind: 'vcs-development-revision',
                version: 1,
                repository: pr.repository,
                head_sha: pr.headSha,
                base_sha: pr.baseSha,
                head_branch: pr.headBranch,
                base_branch: pr.baseBranch,
                work_item_id: item.item_id,
                ci_policy_sha256: ci.policyDigest,
                code_diff: codeDiff.stdout,
                code_diff_sha256: createHash('sha256').update(codeDiff.stdout).digest('hex'),
              },
              { missionId: state.mission_id, missionPath: dir }
            );
            (deps.board ?? writeMissionNextTasks)(dir, (rows) =>
              rows.map((row) =>
                row.task_id === spec.implementation_task_id
                  ? { ...row, target_path: relative }
                  : row.task_id === spec.review_task_id
                    ? {
                        ...row,
                        status: 'planned',
                        artifact_review_receipt: undefined,
                        artifact_review_profile: undefined,
                        description: `${String(row.description ?? '')}\nReview the actual repository diff at the head/base SHA and the CI policy bound in ${relative}.`,
                      }
                    : row
              )
            );
            (deps.update ?? updateWorkItem)({
              itemId: reviewer.item_id,
              expectedVersion: reviewer.version,
              status: 'ready',
            });
            progress.review_key = key;
            save();
            return result(
              'running',
              'Current revision manifest prepared for the independent review executor'
            );
          }
          if (reviewer.status === 'blocked') return pendingWorkItem(reviewer, result);
          if (reviewer.status === 'done' || reviewer.status === 'review')
            return queueRepair(input, state, item, progress, maxRepairs, save, deps, result, {
              kind: 'independent_review',
              head_sha: pr.headSha,
              review_task_id: spec.review_task_id,
              receipt_ref: reviewTask.artifact_review_receipt,
              findings: reviewTask.review_findings ?? [],
              admission_reason: review.reason,
            });
          const reviewAncestors = implementationAncestors(tasks, spec.review_task_id);
          await dispatch(
            scoped
              .filter(
                (candidate) =>
                  reviewAncestors.has(String(candidate.context?.task_id)) &&
                  ['ready', 'backlog'].includes(candidate.status)
              )
              .map((candidate) => candidate.item_id)
          );
          return result(
            'running',
            'Independent revision review advanced through the existing executor'
          );
        }
        // Artifact receipts only validate completed/profiled review rows. The
        // owner must also finish every pre-publication contract before allowing
        // reconciliation to perform an external merge.
        const qualityTasks = tasks.filter(
          (task) =>
            task.task_id !== spec.implementation_task_id &&
            task.task_id !== spec.review_task_id &&
            !['delivery', 'retrospective'].includes(String(task.phase))
        );
        const qualityItems: WorkItem[] = [];
        for (const task of qualityTasks) {
          const candidates = scoped.filter(
            (candidate) => candidate.context?.task_id === task.task_id
          );
          if (candidates.length !== 1)
            return result(
              'blocked',
              'Register exactly one WorkItem for every pre-publication quality contract'
            );
          const candidate = candidates[0];
          if (candidate.metadata?.last_independent_reviewer_status === 'refuted')
            return result(
              'blocked',
              `Pre-publication quality contract ${String(task.task_id)} was refuted; its scoped review evidence requires resolution`
            );
          if (candidate.metadata?.awaiting_approval === true)
            return pendingWorkItem(candidate, result);
          if (
            candidate.lease_id ||
            candidate.attempts?.some((attempt) => attempt.status === 'running')
          )
            return result('running', 'Existing pre-publication quality attempt is still active');
          if (closed.has(String(task.status)) && candidate.status === 'done') continue;
          if (terminal)
            return result(
              'blocked',
              'Terminal mission has unfinished pre-publication quality contracts'
            );
          if (candidate.status === 'blocked') return pendingWorkItem(candidate, result);
          if (
            candidate.status === 'in_progress' ||
            candidate.lease_id ||
            candidate.current_attempt_id
          )
            return result('running', 'Existing pre-publication quality attempt is still active');
          if (!['ready', 'backlog'].includes(candidate.status))
            return result('running', 'Waiting for canonical pre-publication quality acceptance');
          qualityItems.push(candidate);
        }
        if (qualityItems.length) {
          await dispatch(qualityItems.map((candidate) => candidate.item_id));
          return result(
            'running',
            'Remaining mission quality contracts advanced before publication'
          );
        }
        assertChild();
        const verified = (deps.reconcile ?? runPreparedVcsDevelopment)(prepared, (mutation) => {
          assertChild();
          return publish(mutation);
        });
        check();
        if (
          verified.status === 'merged' &&
          /^[a-f0-9]{40,64}$/iu.test(verified.knownMergeCommitSha ?? '')
        )
          return {
            ...result('completed', 'Immutable merge commit and required CI verified'),
            evidence_refs: [
              `mission:${state.mission_id}`,
              pr.url,
              `commit:${verified.knownMergeCommitSha}`,
            ],
          };
        if (verified.status === 'merged')
          return result('blocked', 'Merge verification lacks its immutable commit receipt');
        return result(
          ['blocked', 'post_merge_failed', 'post_merge_unverified'].includes(verified.status)
            ? 'blocked'
            : 'running',
          verified.nextAction
        );
      } catch (error) {
        if (error instanceof ExternalOperationApprovalRequired && error.approval.requestId)
          return {
            ...result('pending_approval', 'Exact external-operation approval required'),
            approval_request_id: error.approval.requestId,
          };
        return result(
          'blocked',
          error instanceof Error ? error.message : 'Development continuation refused'
        );
      }
    }
  );
}

function implementationAncestors(
  tasks: Array<Record<string, unknown>>,
  implementation: string
): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    const row = tasks.find((task) => task.task_id === id);
    if (Array.isArray(row?.dependencies))
      for (const dependency of row.dependencies)
        if (typeof dependency === 'string') visit(dependency);
  };
  visit(implementation);
  return ids;
}
function pendingWorkItem(
  item: WorkItem,
  result: (status: MissionDevelopmentResult['status'], reason: string) => MissionDevelopmentResult
): MissionDevelopmentResult {
  return item.metadata?.awaiting_approval === true &&
    typeof item.metadata.approval_request_id === 'string'
    ? {
        ...result('pending_approval', 'Canonical WorkItem is waiting for its exact tool approval'),
        approval_request_id: item.metadata.approval_request_id,
      }
    : result('blocked', 'Canonical WorkItem is blocked; inspect its scoped attempt evidence');
}
function queueRepair(
  input: MissionDevelopmentInput,
  state: MissionState,
  item: WorkItem,
  progress: ContinuationState,
  limit: number,
  save: () => void,
  deps: MissionDevelopmentDeps,
  result: (status: MissionDevelopmentResult['status'], reason: string) => MissionDevelopmentResult,
  observations: Record<string, unknown>
): MissionDevelopmentResult {
  if (progress.repairs >= limit) return result('blocked', 'Development repair budget exhausted');
  input.assertCurrent();
  progress.repairs += 1;
  progress.pushed_head = undefined;
  progress.review_key = undefined;
  save();
  const current = (deps.get ?? getWorkItem)(item.item_id);
  if (!current) throw new Error('Repair WorkItem disappeared');
  const dir = missionPathOrNull(deps.missionPath ?? findMissionPath, state.mission_id);
  if (!dir) throw new Error('Repair mission disappeared');
  if (Buffer.byteLength(JSON.stringify(observations)) > 8192)
    throw new Error('Repair observations exceed the bounded model context');
  const evidence = path.join(
    dir,
    `evidence/development/${input.development.implementation_task_id}/repair-${progress.repairs}.json`
  );
  (deps.artifact ?? writeDispatchArtifact)(
    evidence,
    { mission_id: state.mission_id, work_item_id: item.item_id, observations },
    { missionId: state.mission_id, missionPath: dir }
  );
  const evidenceHash = createHash('sha256').update(readTextFile(evidence)).digest('hex');
  (deps.update ?? updateWorkItem)({
    itemId: current.item_id,
    expectedVersion: current.version,
    status: 'ready',
    metadata: {
      ...current.metadata,
      development_repair_evidence: pathResolver.toRepoRelative(evidence),
      development_repair_sha256: evidenceHash,
    },
  });
  (deps.board ?? writeMissionNextTasks)(dir, (rows) =>
    rows.map((row) =>
      row.task_id === input.development.implementation_task_id
        ? { ...row, status: 'planned', target_path: progress.original_target_path }
        : row
    )
  );
  return result('running', 'Repair queued on the original claimed WorkItem executor');
}
