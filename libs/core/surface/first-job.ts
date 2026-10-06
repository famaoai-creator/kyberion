/** Bounded diagnostic read model. This module never dispatches or invokes a model. */
import { t } from '../t.js';
import { isFirstJobDiagnosticMapping } from './first-job-admission.js';
import { normalizeLocale, type SupportedLocale } from '../locale-normalize.js';
import { narrowSurfaceViewerScope, type SurfaceViewerScope } from './surface-mutation-guard.js';
import {
  loadFrontDeskExecutionPolicy,
  frontDeskExecutionViewerMatches,
  frontDeskMappingDigest,
  FRONT_DESK_RECEIPT_COMMAND,
  frontDeskArtifactRevisionCommand,
  type FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';
import {
  conversationRef,
  readConversationHistory,
  readFrontDeskConversationWork,
  type FrontDeskConversationWorkTask,
} from './front-desk-conversation-store.js';
import type { ConversationHistoryMessage } from './front-desk-conversation-history.js';
import type { FirstJobReadRequest } from './first-job-contract.js';

export type FirstJobReadinessStatus =
  | 'diagnostic_mapping_ready'
  | 'mapping_missing'
  | 'mapping_mismatch'
  | 'mapping_ambiguous'
  | 'mapping_unavailable'
  | 'mapping_changed';
export interface FirstJobSnapshot {
  ok: true;
  readiness: { ready: boolean; status: FirstJobReadinessStatus };
  scope?: { tenant: string; organizationId?: string; projectId?: string; tier: 'public' };
  sessionId?: string;
  messages: ConversationHistoryMessage[];
  pending: number;
  tasks: FrontDeskConversationWorkTask[];
  next_action: { kind: 'inspect_setup'; href: '/first-job' };
}
export const FIRST_JOB_NEXT_ACTION = { kind: 'inspect_setup', href: '/first-job' } as const;
export type FirstJobResolution =
  | { ready: true; status: 'diagnostic_mapping_ready'; viewer: SurfaceViewerScope }
  | { ready: false; status: Exclude<FirstJobReadinessStatus, 'diagnostic_mapping_ready'> };

/** Keep the authenticated identity. A mapping may only narrow existing allowed sets. */
function mappedViewer(
  authenticated: SurfaceViewerScope,
  mapping: FrontDeskExecutionMapping
): SurfaceViewerScope | undefined {
  const required = mapping.viewer;
  if (
    required.principalId !== authenticated.principalId ||
    required.memberId !== authenticated.memberId ||
    required.source !== authenticated.source ||
    required.role !== authenticated.role ||
    required.tierAccess.length !== 1 ||
    required.tierAccess[0] !== 'public' ||
    required.tenantSlugs === 'all' ||
    required.tenantSlugs.length !== 1
  )
    return undefined;
  const tenantOnly = required.organizationIds === 'all' && required.projectIds === 'all';
  if (
    tenantOnly
      ? authenticated.organizationIds !== 'all' || authenticated.projectIds !== 'all'
      : [required.organizationIds, required.projectIds].some(
          (scope) => scope === 'all' || scope.length !== 1
        )
  )
    return undefined;
  try {
    const scope = narrowSurfaceViewerScope(authenticated, {
      tenant: required.tenantSlugs[0],
      ...(tenantOnly
        ? {}
        : { organizationId: required.organizationIds[0], projectId: required.projectIds[0] }),
    });
    const viewer: SurfaceViewerScope = { ...authenticated, ...scope, tierAccess: ['public'] };
    return frontDeskExecutionViewerMatches(viewer, mapping) ? viewer : undefined;
  } catch {
    return undefined;
  }
}
export function resolveFirstJobViewer(authenticated: SurfaceViewerScope): FirstJobResolution {
  if (
    authenticated.source !== 'loopback' ||
    authenticated.role !== 'localadmin' ||
    !authenticated.principalId?.trim() ||
    !authenticated.tierAccess.includes('public')
  )
    return { ready: false, status: 'mapping_mismatch' };
  const mappings = loadFrontDeskExecutionPolicy().mappings;
  if (mappings.length === 0) return { ready: false, status: 'mapping_missing' };
  const candidates = mappings.flatMap((mapping) => {
    const viewer = mappedViewer(authenticated, mapping);
    return viewer ? [{ mapping, viewer }] : [];
  });
  if (candidates.length === 0) return { ready: false, status: 'mapping_mismatch' };
  if (candidates.length !== 1) return { ready: false, status: 'mapping_ambiguous' };
  try {
    const { mapping } = candidates[0];
    frontDeskMappingDigest(mapping);
    if (!isFirstJobDiagnosticMapping(mapping)) throw new Error('diagnostic_charter_unavailable');
  } catch {
    return { ready: false, status: 'mapping_unavailable' };
  }
  return { ready: true, status: 'diagnostic_mapping_ready', viewer: candidates[0].viewer };
}
function diagnosticCommand(task: FrontDeskConversationWorkTask): string {
  return task.artifact?.parentRequestId
    ? frontDeskArtifactRevisionCommand(task.artifact.format)
    : FRONT_DESK_RECEIPT_COMMAND;
}
function diagnosticStatus(task: FrontDeskConversationWorkTask, locale?: SupportedLocale): string {
  switch (task.executionStatus) {
    case 'queued':
      return t('front_desk:execution_queued', undefined, locale);
    case 'awaiting_approval':
      return t('front_desk:execution_awaiting_approval', undefined, locale);
    case 'running':
      return t('front_desk:execution_running', undefined, locale);
    case 'blocked':
      return t('front_desk:execution_blocked', { reason: '' }, locale).trim();
    case 'cancel_requested':
      return t('front_desk:execution_cancel_requested', undefined, locale);
    case 'work_completed':
      return t('front_desk:work_home_status_work_completed', undefined, locale);
    default:
      return t('front_desk:execution_unverified', undefined, locale);
  }
}
export function firstJobUnavailableSnapshot(status: FirstJobReadinessStatus): FirstJobSnapshot {
  return {
    ok: true,
    readiness: { ready: false, status },
    messages: [],
    pending: 0,
    tasks: [],
    next_action: FIRST_JOB_NEXT_ACTION,
  };
}
/** No locks, transcript publications, execution intake, or restored approval actions. */
export function readFirstJobSnapshot(
  authenticated: SurfaceViewerScope,
  input: FirstJobReadRequest = {}
): FirstJobSnapshot {
  const locale = normalizeLocale(input.locale) ?? undefined;
  if (input.locale !== undefined && (!locale || input.locale.length > 32))
    throw new Error('first_job_invalid_locale');
  const resolution = resolveFirstJobViewer(authenticated);
  if (resolution.ready === false)
    return firstJobUnavailableSnapshot(input.session_id ? 'mapping_changed' : resolution.status);
  const viewer = resolution.viewer;
  const ref = conversationRef(viewer);
  if (input.session_id && input.session_id !== ref.sessionId)
    return firstJobUnavailableSnapshot('mapping_changed');
  const history = readConversationHistory(viewer, { readOnly: true });
  const work = readFrontDeskConversationWork(viewer, locale);
  // Never echo arbitrary legacy input or raw execution summaries. Typed diagnostic
  // rows are sufficient to reconstruct this fixed protocol's display history.
  const tasks = work.tasks
    .filter((task) => task.artifact)
    .map(({ resultExcerpt: _omit, ...task }) => ({
      ...task,
      title: diagnosticCommand(task),
    }));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const messages: ConversationHistoryMessage[] = history.messages.flatMap((message) => {
    const task = message.artifact
      ? byId.get(message.artifact.requestId)
      : byId.get(message.id.replace(/-(user|secretary)$/, ''));
    if (!task) return [];
    return [
      {
        ...message,
        text:
          message.role === 'user'
            ? diagnosticCommand(task)
            : message.artifact
              ? diagnosticStatus(task, locale)
              : task.artifact?.parentRequestId
                ? t(
                    'front_desk:artifact_revision_acknowledged',
                    { revision: task.artifact.revision },
                    locale
                  )
                : t('front_desk:execution_acknowledged', undefined, locale),
      },
    ];
  });
  return {
    ok: true,
    readiness: { ready: true, status: 'diagnostic_mapping_ready' },
    scope: {
      tenant: viewer.tenantSlugs[0],
      ...(viewer.organizationIds === 'all' ? {} : { organizationId: viewer.organizationIds[0] }),
      ...(viewer.projectIds === 'all' ? {} : { projectId: viewer.projectIds[0] }),
      tier: 'public',
    },
    sessionId: history.sessionId,
    messages,
    pending: tasks.filter((task) => task.turnState === 'pending' || task.turnState === 'uncertain')
      .length,
    tasks,
    next_action: FIRST_JOB_NEXT_ACTION,
  };
}
