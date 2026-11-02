/** Read-only bindings between canonical QA evidence and current required CI. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { readTextFile } from '../foundation/text.js';
import { safeExistsSync } from '../secure-io.js';
import { loadMissionWorkflowCatalog } from './mission-workflow-catalog.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { listWorkItems, type WorkItem } from '../workforce/work-coordination.js';
import type { MissionState } from './mission-types.js';
import type { VcsDevelopmentPr, VcsDevelopmentCiProof } from '../vcs/development-proof.js';

const closed = new Set(['done', 'completed', 'accepted', 'reviewed']);
export function standardTestContract(
  state: MissionState,
  tasks: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (state.process_template?.workflow_id !== 'code-change-aidlc') return;
  const template = loadMissionWorkflowCatalog().templates.find(
    (entry) => entry.id === 'code-change-aidlc'
  );
  const phase = template?.phases.find((entry) => typeof entry !== 'string' && entry.id === 'test');
  const contract =
    phase && typeof phase !== 'string'
      ? phase.default_tasks?.find((entry) => entry.task_id_suffix === 'test-run')
      : undefined;
  const task = tasks.find((entry) => entry.task_id === 'test-test-run');
  if (
    !contract ||
    !task ||
    task.origin !== 'process_template' ||
    task.phase !== 'test' ||
    task.deliverable !== contract.deliverable ||
    JSON.stringify(task.acceptance_criteria) !== JSON.stringify(contract.acceptance_criteria)
  )
    return;
  return task;
}
export function isRequiredCiEvidenceCurrent(
  item: WorkItem,
  report: string,
  pr: VcsDevelopmentPr,
  ci: VcsDevelopmentCiProof
): boolean {
  if (
    item.status !== 'done' ||
    item.metadata?.verification_source !== 'required_ci_verifier' ||
    item.metadata.ci_head_sha !== pr.headSha ||
    item.metadata.ci_policy_sha256 !== ci.policyDigest ||
    !safeExistsSync(report)
  )
    return false;
  const bytes = readTextFile(report, { maxSizeMB: 0.0625, label: 'required CI report' });
  return createHash('sha256').update(bytes).digest('hex') === item.metadata.ci_report_sha256;
}
export function hasCurrentRequiredCiEvidence(
  state: MissionState,
  missionPath: string,
  pr: VcsDevelopmentPr,
  ci: VcsDevelopmentCiProof
): boolean {
  const tasks =
    loadMissionNextTaskObjectsAtPath(path.join(missionPath, 'NEXT_TASKS.json'), state.mission_id) ??
    [];
  const task = standardTestContract(state, tasks);
  if (!task || !closed.has(String(task.status))) return false;
  const items = listWorkItems({
    ...(state.tenant_slug ? { tenantSlugs: [state.tenant_slug] } : {}),
    ...(state.organization_id ? { organizationIds: [state.organization_id] } : {}),
  }).filter(
    (item) =>
      item.context?.mission_id === state.mission_id && item.context.task_id === 'test-test-run'
  );
  return (
    items.length === 1 &&
    isRequiredCiEvidenceCurrent(items[0], path.join(missionPath, 'evidence/test-report.md'), pr, ci)
  );
}
