import { frontDeskExecutionArtifactPath } from './front-desk-execution-artifact.js';
/** Viewer-authorized, readback-verified projection. This module cannot execute work. */
import { t } from '../t.js';
import type { SupportedLocale } from '../locale-normalize.js';
import { createHash } from 'node:crypto';
import { safeExistsSync, safeLstat, safeReadFile } from '../secure-io.js';
import { getWorkItem } from '../workforce/work-coordination.js';
import { currentDotActions } from '../dot/dot-dispatch.js';
import { listDotCharters } from '../dot/dot-charter.js';
import { readDotWorkResults } from '../dot/dot-executor-reports.js';
import type { FrontDeskArtifactVerification } from '../dot/dot-state-paths.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';
import {
  getFrontDeskExecutionMapping,
  frontDeskExecutionViewerMatches,
  frontDeskExecutionExpectedContent,
  type FrontDeskExecutionBinding,
  type FrontDeskExecutionProjection,
} from './front-desk-execution-contract.js';

export function projectFrontDeskExecution(
  viewer: SurfaceViewerScope,
  binding: FrontDeskExecutionBinding,
  options: { rootDir?: string; locale?: SupportedLocale } = {}
): FrontDeskExecutionProjection | undefined {
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping || !frontDeskExecutionViewerMatches(viewer, mapping)) return undefined;
  const item = getWorkItem(binding.work_item_id);
  if (!item) {
    const action = currentDotActions(mapping.dotId, options).find(
      (row) =>
        row.front_desk_execution?.work_item_id === binding.work_item_id &&
        row.front_desk_execution.config_digest === binding.config_digest
    );
    if (action && ['refused', 'declined', 'shadow'].includes(action.status))
      return {
        status: 'blocked',
        text: t(
          'front_desk:execution_not_executed',
          { reason: action.reason ?? action.status },
          options.locale
        ),
        reportId: 'front-desk-report-' + binding.work_item_id + '-' + action.status,
      };
    return {
      status: 'awaiting_approval',
      text: t('front_desk:execution_awaiting_approval', {}, options.locale),
    };
  }
  const bound = item.metadata?.front_desk_execution as FrontDeskExecutionBinding | undefined;
  if (
    !bound ||
    (Object.keys(binding) as Array<keyof FrontDeskExecutionBinding>).some(
      (key) => binding[key] !== bound[key]
    )
  )
    return undefined;
  const tenant = mapping.viewer.tenantSlugs === 'all' ? undefined : mapping.viewer.tenantSlugs[0];
  const org =
    mapping.viewer.organizationIds === 'all' ? undefined : mapping.viewer.organizationIds[0];
  const project = mapping.viewer.projectIds === 'all' ? undefined : mapping.viewer.projectIds[0];
  if (
    item.context?.tenant_slug !== tenant ||
    item.context?.organization_id !== org ||
    item.context?.project_id !== (project ?? 'default')
  )
    return undefined;
  if (item.status === 'ready')
    return { status: 'queued', text: t('front_desk:execution_queued', {}, options.locale) };
  if (item.status === 'in_progress')
    return { status: 'running', text: t('front_desk:execution_running', {}, options.locale) };
  const charter = listDotCharters().find(
    (value) => value.charter.dot_id === mapping.dotId
  )?.charter;
  if (
    !charter ||
    charter.scope.tenant_slug !== tenant ||
    charter.scope.organization_id !== org ||
    charter.scope.project_id !== project
  )
    return undefined;
  const attempt = item.current_attempt_id ?? item.attempts?.at(-1)?.run_id;
  const result = readDotWorkResults(charter, options)
    .filter(
      (row) =>
        row.work_item_id === item.item_id &&
        row.action_ref === item.metadata?.action_ref &&
        row.attempt_id === attempt
    )
    .at(-1);
  if (!result)
    return { status: 'uncertain', text: t('front_desk:execution_unverified', {}, options.locale) };
  const reportId =
    'front-desk-report-' +
    createHash('sha256')
      .update([item.item_id, attempt, result.status, result.completed_at].join(':'))
      .digest('hex');
  if (item.status !== 'done' || result.status !== 'done')
    return {
      status: 'blocked',
      text: t('front_desk:execution_blocked', { reason: result.summary }, options.locale),
      reportId,
    };
  const evidence: FrontDeskArtifactVerification | undefined = result.front_desk_verification;
  const expectedPath = frontDeskExecutionArtifactPath(binding, mapping);
  try {
    if (
      !evidence ||
      evidence.request_digest !== binding.request_digest ||
      evidence.revision !== binding.revision ||
      evidence.artifact_path !== expectedPath ||
      !safeExistsSync(expectedPath) ||
      !safeLstat(expectedPath).isFile()
    )
      throw new Error('evidence missing');
    const content = safeReadFile(expectedPath, { encoding: 'utf8' });
    if (
      createHash('sha256').update(content).digest('hex') !== evidence.sha256 ||
      content !==
        frontDeskExecutionExpectedContent(binding, mapping, 'concierge-' + binding.conversation_key)
    )
      throw new Error('readback differs');
    return {
      status: 'work_completed',
      text: t('front_desk:execution_completed', { path: expectedPath }, options.locale),
      reportId,
      artifactPath: expectedPath,
    };
  } catch {
    return {
      status: 'uncertain',
      text: t('front_desk:execution_unverified', {}, options.locale),
      reportId: reportId + '-unverified',
    };
  }
}
