/** Deterministic required-CI verification for the standard code-change QA contract. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { readTextFile } from '../foundation/text.js';
import { safeExistsSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  standardTestContract,
  isRequiredCiEvidenceCurrent,
} from './mission-development-ci-proof.js';
import { writeProvisionedText, provisionMissionEntry } from './mission-orchestration-journal.js';
import { getWorkItem, updateWorkItem, type WorkItem } from '../workforce/work-coordination.js';
import type { MissionState } from './mission-types.js';
import type { VcsDevelopmentPr, VcsDevelopmentCiProof } from '../vcs/development-proof.js';

export type RecordRequiredCiEvidence = (
  missionId: string,
  taskId: string,
  note: string,
  evidence: string[]
) => Promise<void>;
const closed = new Set(['done', 'completed', 'accepted', 'reviewed']);
export async function recordRequiredCiTaskEvidence(
  input: {
    state: MissionState;
    missionPath: string;
    tasks: Array<Record<string, unknown>>;
    items: WorkItem[];
    pr: VcsDevelopmentPr;
    ci: VcsDevelopmentCiProof;
    assertCurrent: () => void;
  },
  record: RecordRequiredCiEvidence = async (missionId, taskId, note, evidence) => {
    const { missionSystem } = await import('./mission-system.js');
    await missionSystem.recordEvidence(
      missionId,
      taskId,
      note,
      evidence,
      'tester',
      'component:vcs-required-ci',
      'service'
    );
  }
): Promise<{ advanced: boolean; verified: boolean }> {
  const { state, missionPath, tasks, items, pr, ci } = input;
  const task = standardTestContract(state, tasks);
  if (
    !task ||
    ci.state !== 'success' ||
    !ci.requiredChecks.length ||
    !/^[a-f0-9]{64}$/iu.test(ci.policyDigest)
  )
    return { advanced: false, verified: false };
  if (
    Array.isArray(task.dependencies) &&
    task.dependencies.some(
      (id) => !closed.has(String(tasks.find((row) => row.task_id === id)?.status))
    )
  )
    return { advanced: false, verified: false };
  const candidates = items.filter((item) => item.context?.task_id === 'test-test-run');
  if (candidates.length !== 1) return { advanced: false, verified: false };
  const item = candidates[0];
  const report = path.join(missionPath, 'evidence/test-report.md');
  if (closed.has(String(task.status)) && isRequiredCiEvidenceCurrent(item, report, pr, ci))
    return { advanced: false, verified: true };
  if (
    !['ready', 'backlog', 'done'].includes(item.status) ||
    item.lease_id ||
    item.metadata?.awaiting_approval
  )
    return { advanced: false, verified: false };
  input.assertCurrent();
  const previous = safeExistsSync(report)
    ? readTextFile(report, { maxSizeMB: 0.0625, label: 'existing verification report' })
    : '';
  const body = [
    '# Required CI verification',
    '',
    `Mission: ${state.mission_id}`,
    `Source PR: ${pr.url}`,
    `Head SHA: ${pr.headSha}`,
    `Base SHA: ${pr.baseSha}`,
    `CI policy SHA-256: ${ci.policyDigest}`,
    '',
    'Result: all server-required checks succeeded with verified workflow/App provenance.',
    ...ci.requiredChecks.map((name) => `- ${name}`),
    '',
    'This component observed actual remote CI. It did not run local test commands or impersonate the assigned model tester.',
    '',
    ...(previous && !previous.startsWith('# Required CI verification')
      ? ['## Existing verification evidence', previous]
      : []),
  ].join('\n');
  if (Buffer.byteLength(body) > 64 * 1024)
    throw new Error('Required CI report exceeds its bounded evidence size');
  writeProvisionedText({
    missionId: state.mission_id,
    filePath: report,
    targetPath: 'evidence/test-report.md',
    missionPathHint: missionPath,
    provisioned: provisionMissionEntry(body),
  });
  await record(
    state.mission_id,
    'test-test-run',
    `Required CI observed for immutable head ${pr.headSha}, policy ${ci.policyDigest}; local commands not run.`,
    [pathResolver.toRepoRelative(report), pr.url]
  );
  input.assertCurrent();
  const fresh = getWorkItem(item.item_id);
  if (
    !fresh ||
    fresh.version !== item.version ||
    fresh.context?.mission_id !== state.mission_id ||
    fresh.context.task_id !== 'test-test-run'
  )
    throw new Error('QA WorkItem changed during deterministic CI verification');
  updateWorkItem({
    itemId: fresh.item_id,
    expectedVersion: fresh.version,
    status: 'done',
    metadata: {
      ...fresh.metadata,
      verification_source: 'required_ci_verifier',
      verification_actor: 'component:vcs-required-ci',
      ci_head_sha: pr.headSha,
      ci_policy_sha256: ci.policyDigest,
      ci_report_sha256: createHash('sha256').update(body).digest('hex'),
      ci_report_ref: pathResolver.toRepoRelative(report),
    },
  });
  return { advanced: true, verified: true };
}
