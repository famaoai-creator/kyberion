import { classifySurfaceQueryIntent, extractSurfaceKnowledgeQuery, extractSurfaceWebSearchQuery } from './surface-query.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';

export interface SurfaceIntentResolution {
  intentId?: string;
  shape?: string;
  routeFamily?: 'direct_reply' | 'browser_session' | 'task_session' | 'mission' | 'pipeline';
  queryType?: 'weather' | 'location' | 'web_search' | 'knowledge_search';
  queryText?: string;
  browserCommandKind?: 'open_site' | 'browser_step';
  pipelineId?: string;
  missionAction?: 'create' | 'classify' | 'workflow' | 'compose_team' | 'prewarm_team' | 'delegate_task' | 'review_output' | 'handoff' | 'distill' | 'close' | 'inspect_state';
}

function routeFamilyForIntent(intentId?: string, shape?: string): SurfaceIntentResolution['routeFamily'] {
  if (shape === 'pipeline') return 'pipeline';
  if (shape === 'mission') return 'mission';
  if (shape === 'browser_session') return 'browser_session';
  if (shape === 'task_session') return 'task_session';
  if (shape === 'direct_reply' || intentId === 'knowledge-query' || intentId === 'query-knowledge' || intentId === 'live-query') {
    return 'direct_reply';
  }
  return undefined;
}

const PIPELINE_INTENT_MAP: Record<string, string> = {
  'check-kyberion-baseline': 'baseline-check',
  'check-kyberion-vital': 'vital-check',
  'diagnose-kyberion-system': 'system-diagnostics',
  'run-system-upgrade-check': 'system-upgrade-check',
  'verify-environment-readiness': 'baseline-check',
  'inspect-environment-readiness': 'baseline-check',
  'inspect-runtime-supervisor': 'system-diagnostics',
  'verify-audit-chain': 'system-diagnostics',
};

const MISSION_INTENT_ACTION_MAP: Record<string, NonNullable<SurfaceIntentResolution['missionAction']>> = {
  'create-mission': 'create',
  'classify-mission': 'classify',
  'select-mission-workflow': 'workflow',
  'compose-mission-team': 'compose_team',
  'prewarm-mission-team': 'prewarm_team',
  'delegate-mission-task': 'delegate_task',
  'review-worker-output': 'review_output',
  'handoff-mission': 'handoff',
  'distill-mission': 'distill',
  'close-mission': 'close',
  'inspect-mission-state': 'inspect_state',
};

export function resolveSurfaceIntent(utterance: string): SurfaceIntentResolution {
  const packet = resolveIntentResolutionPacket(utterance);
  const selectedIntentId = packet.selected_intent_id;

  if (selectedIntentId === 'knowledge-query' || selectedIntentId === 'query-knowledge') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape || 'direct_reply'),
      queryType: 'knowledge_search',
      queryText: extractSurfaceKnowledgeQuery(utterance) || utterance.trim(),
    };
  }

  if (selectedIntentId === 'live-query') {
    const queryType = classifySurfaceQueryIntent(utterance);
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape || 'direct_reply'),
      queryType: queryType || 'web_search',
      queryText: queryType === 'knowledge_search'
        ? extractSurfaceKnowledgeQuery(utterance) || utterance.trim()
        : queryType === 'web_search'
          ? extractSurfaceWebSearchQuery(utterance) || utterance.trim()
          : utterance.trim(),
    };
  }

  if (selectedIntentId === 'open-site') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape || 'browser_session'),
      browserCommandKind: 'open_site',
    };
  }

  if (selectedIntentId === 'browser-step') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape || 'browser_session'),
      browserCommandKind: 'browser_step',
    };
  }

  if (selectedIntentId && PIPELINE_INTENT_MAP[selectedIntentId]) {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape || 'pipeline'),
      pipelineId: PIPELINE_INTENT_MAP[selectedIntentId],
    };
  }

  if (selectedIntentId && MISSION_INTENT_ACTION_MAP[selectedIntentId]) {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape || 'mission'),
      missionAction: MISSION_INTENT_ACTION_MAP[selectedIntentId],
    };
  }

  return {
    intentId: selectedIntentId,
    shape: packet.selected_resolution?.shape,
    routeFamily: routeFamilyForIntent(selectedIntentId, packet.selected_resolution?.shape),
  };
}
