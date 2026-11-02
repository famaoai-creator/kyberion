/** Read-only publication proof for the existing mission phase gates. */
import { createHash } from 'node:crypto';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { listWorkItems } from '../workforce/work-coordination.js';
import { pathResolver } from '../path-resolver.js';
import { loadState } from './mission-state.js';
import { ensureMissionDevelopmentSourceWorkspace } from './mission-development-workspace.js';
import { readVcsDevelopmentRepository } from '../vcs/development-proof.js';
import { readVcsDevelopmentPr, readVcsDevelopmentCiProof } from '../vcs/development-proof.js';
import { runHardenedGitProbe } from '../shell/git-probe-hardening.js';
import { hasCurrentRequiredCiEvidence } from './mission-development-ci-proof.js';
import { findMissionPath } from '../path-resolver.js';
import { missionPathOrNull } from '../mission-lookup.js';
import { runPreparedVcsDevelopment } from '../vcs/development-loop.js';
import type { MissionDevelopmentSpec } from './mission-development-continuation.js';

export async function verifyMissionDevelopmentPublication(
  missionId: string,
  development: MissionDevelopmentSpec,
  mode: 'review' | 'publication' | 'ci' = 'publication',
  deps: {
    repository?: typeof readVcsDevelopmentRepository;
    reconcile?: typeof runPreparedVcsDevelopment;
    sourceWorkspace?: typeof ensureMissionDevelopmentSourceWorkspace;
    pr?: typeof readVcsDevelopmentPr;
    ci?: typeof readVcsDevelopmentCiProof;
    head?: (cwd: string) => string;
  } = {}
): Promise<{ ok: boolean; reason?: string; waiting?: boolean }> {
  try {
    if (development.cwd !== '.')
      throw new Error('Development scope requires its dedicated owner root');
    const state = loadState(missionId);
    if (!state) throw new Error('Development mission missing');
    const identity = currentScopeEnvelope()?.identity ?? resolveScopeContext();
    if (
      identity.tier !== state.tier ||
      (identity.tenant_slug ?? '') !== (state.tenant_slug ?? '') ||
      (identity.organization_id ?? '') !== (state.organization_id ?? '')
    )
      throw new Error('Development gate runtime scope differs from mission');
    const items = listWorkItems({
      ...(state.tenant_slug ? { tenantSlugs: [state.tenant_slug] } : {}),
      ...(state.organization_id ? { organizationIds: [state.organization_id] } : {}),
    }).filter(
      (item) =>
        item.context?.mission_id === state.mission_id &&
        item.context.task_id === development.implementation_task_id
    );
    if (items.length !== 1)
      throw new Error('Development gate requires one canonical implementation WorkItem');
    const item = items[0];
    const progress = item.metadata?.mission_development;
    if (!progress || typeof progress !== 'object' || Array.isArray(progress))
      throw new Error('Development continuation proof missing');
    const stored = progress as Record<string, unknown>;
    const specification = createHash('sha256')
      .update(
        JSON.stringify({
          mission: state.mission_id,
          spec: development,
          scope: {
            tier: state.tier,
            tenant: state.tenant_slug,
            organization: state.organization_id,
          },
        })
      )
      .digest('hex');
    if (
      stored.version !== 1 ||
      stored.specification !== specification ||
      !Number.isSafeInteger(stored.pr_number) ||
      Number(stored.pr_number) < 1
    )
      throw new Error('Development gate specification or PR identity changed');
    const privateWorkspace = (deps.sourceWorkspace ?? ensureMissionDevelopmentSourceWorkspace)(
      state,
      development.implementation_task_id,
      development.source_edit_paths,
      () => {
        throw new Error('Read-only development gate cannot allocate a workspace');
      },
      { create: false }
    );
    const cwd = privateWorkspace?.cwd ?? pathResolver.rootDir();
    if (
      (deps.repository ?? readVcsDevelopmentRepository)({ cwd }).url !== development.repository_url
    )
      throw new Error('Development gate repository drift');
    if (mode === 'ci') {
      const pr = (deps.pr ?? readVcsDevelopmentPr)(String(stored.pr_number), { cwd });
      const head = deps.head
        ? deps.head(cwd)
        : (() => {
            const value = runHardenedGitProbe(['rev-parse', '--verify', '--quiet', 'HEAD'], {
              cwd,
            });
            if (value.status !== 0 || value.error)
              throw new Error('CI evidence source commit is unavailable');
            return value.stdout.trim();
          })();
      const ci = (deps.ci ?? readVcsDevelopmentCiProof)(pr, { cwd });
      if (
        pr.repository === development.repository_url &&
        pr.headBranch === 'agent/kyberion-development' &&
        pr.baseBranch === 'main' &&
        pr.headSha === head &&
        (ci.state === 'pending' || ci.state === 'failure')
      )
        return {
          ok: false,
          waiting: true,
          reason: 'Required CI changed; the next owner turn will wait or repair',
        };
      const dir = missionPathOrNull(findMissionPath, state.mission_id);
      const ok = Boolean(
        dir &&
        pr.repository === development.repository_url &&
        pr.headBranch === 'agent/kyberion-development' &&
        pr.baseBranch === 'main' &&
        pr.headSha === head &&
        ci.state === 'success' &&
        ci.requiredChecks.length > 0 &&
        /^[a-f0-9]{64}$/iu.test(ci.policyDigest) &&
        hasCurrentRequiredCiEvidence(state, dir, pr, ci)
      );
      return {
        ok,
        ...(ok
          ? {}
          : {
              reason:
                'Current required CI and its canonical QA evidence do not match this revision',
            }),
      };
    }
    if (mode === 'review') {
      const dir = missionPathOrNull(findMissionPath, state.mission_id);
      if (!dir) throw new Error('Development review mission directory is missing');
      const { validateMissionArtifactReviewGate } = await import('./mission-governance.js');
      const review = validateMissionArtifactReviewGate({ missionId, missionPath: dir });
      if (!review.ok)
        return {
          ok: false,
          reason: review.reason ?? 'Independent artifact review proof unavailable',
        };
    }
    const proof = (deps.reconcile ?? runPreparedVcsDevelopment)(
      {
        cwd,
        ref: String(stored.pr_number),
        workItemId: item.item_id,
        reviewTaskId: development.review_task_id,
        requireSourceDiff: true,
        dryRun: true,
      },
      () => {
        throw new Error('Read-only development proof cannot publish');
      }
    );
    const merged =
      proof.status === 'merged' && /^[a-f0-9]{40,64}$/iu.test(proof.knownMergeCommitSha ?? '');
    const ok = mode === 'review' ? proof.status === 'ready' || merged : merged;
    return { ok, ...(ok ? {} : { reason: proof.nextAction }) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Development proof unavailable',
    };
  }
}
