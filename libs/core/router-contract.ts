import {
  classifySurfaceQueryIntent,
  extractSurfaceKnowledgeQuery,
  extractSurfaceWebSearchQuery,
} from './surface-query.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { recordConfigFallback } from './config-fallback-registry.js';
import { recordUnhandledIntent } from './unhandled-intent-registry.js';

export interface SurfaceIntentResolution {
  intentId?: string;
  shape?: string;
  routeFamily?: 'direct_reply' | 'browser_session' | 'task_session' | 'mission' | 'pipeline';
  queryType?: 'weather' | 'location' | 'web_search' | 'knowledge_search';
  queryText?: string;
  browserCommandKind?: 'open_site' | 'browser_step';
  pipelineId?: string;
  missionAction?:
    | 'create'
    | 'classify'
    | 'workflow'
    | 'compose_team'
    | 'prewarm_team'
    | 'delegate_task'
    | 'review_output'
    | 'handoff'
    | 'distill'
    | 'close'
    | 'inspect_state';
}

interface IntentRoutingMap {
  pipeline_intent_map: Record<string, string>;
  mission_intent_action_map: Record<string, NonNullable<SurfaceIntentResolution['missionAction']>>;
  direct_intent_commands: Record<string, { command: string; args: string[] }>;
}

let _cachedRoutingMap: IntentRoutingMap | null = null;

function loadIntentRoutingMap(): IntentRoutingMap {
  if (_cachedRoutingMap) return _cachedRoutingMap;
  try {
    const filePath = pathResolver.knowledge('product/governance/intent-routing-map.json');
    _cachedRoutingMap = JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as IntentRoutingMap;
  } catch (err) {
    const defaults = {
      pipeline_intent_map: {},
      mission_intent_action_map: {},
      direct_intent_commands: {},
    };
    recordConfigFallback({
      knowledgePath: 'product/governance/intent-routing-map.json',
      error: err,
      defaults,
    });
    _cachedRoutingMap = defaults;
  }
  return _cachedRoutingMap;
}

function routeFamilyForIntent(
  intentId?: string,
  shape?: string
): SurfaceIntentResolution['routeFamily'] {
  if (shape === 'pipeline') return 'pipeline';
  if (shape === 'mission') return 'mission';
  if (shape === 'browser_session') return 'browser_session';
  if (shape === 'task_session') return 'task_session';
  if (
    shape === 'direct_reply' ||
    intentId === 'knowledge-query' ||
    intentId === 'query-knowledge' ||
    intentId === 'live-query'
  ) {
    return 'direct_reply';
  }
  return undefined;
}

export function resolveDirectIntentCommand(
  intentId?: string
): { command: string; args: string[] } | null {
  if (!intentId) return null;
  const { direct_intent_commands } = loadIntentRoutingMap();
  return direct_intent_commands[intentId] ?? null;
}

export function resolveSurfaceIntent(utterance: string): SurfaceIntentResolution {
  const packet = resolveIntentResolutionPacket(utterance);
  const selectedIntentId = packet.selected_intent_id;
  const { pipeline_intent_map, mission_intent_action_map } = loadIntentRoutingMap();

  if (!selectedIntentId) {
    recordUnhandledIntent({ missType: 'unrecognized', utterance });
  }

  if (selectedIntentId === 'knowledge-query' || selectedIntentId === 'query-knowledge') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(
        selectedIntentId,
        packet.selected_resolution?.shape || 'direct_reply'
      ),
      queryType: 'knowledge_search',
      queryText: extractSurfaceKnowledgeQuery(utterance) || utterance.trim(),
    };
  }

  if (selectedIntentId === 'live-query') {
    const queryType = classifySurfaceQueryIntent(utterance);
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(
        selectedIntentId,
        packet.selected_resolution?.shape || 'direct_reply'
      ),
      queryType: queryType || 'web_search',
      queryText:
        queryType === 'knowledge_search'
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
      routeFamily: routeFamilyForIntent(
        selectedIntentId,
        packet.selected_resolution?.shape || 'browser_session'
      ),
      browserCommandKind: 'open_site',
    };
  }

  if (selectedIntentId === 'browser-step') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(
        selectedIntentId,
        packet.selected_resolution?.shape || 'browser_session'
      ),
      browserCommandKind: 'browser_step',
    };
  }

  if (selectedIntentId && pipeline_intent_map[selectedIntentId]) {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(selectedIntentId, 'pipeline'),
      pipelineId: pipeline_intent_map[selectedIntentId],
    };
  }

  if (selectedIntentId && mission_intent_action_map[selectedIntentId]) {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      routeFamily: routeFamilyForIntent(
        selectedIntentId,
        packet.selected_resolution?.shape || 'mission'
      ),
      missionAction: mission_intent_action_map[selectedIntentId],
    };
  }

  const shape = packet.selected_resolution?.shape;
  const routeFamily = routeFamilyForIntent(selectedIntentId, shape);

  // 'direct_reply'-routed intents are handled by the orchestrator without a pipeline/mission entry — not a gap.
  if (selectedIntentId && routeFamily !== 'direct_reply') {
    recordUnhandledIntent({ missType: 'unrouted', intentId: selectedIntentId, shape, utterance });
  }

  return {
    intentId: selectedIntentId,
    shape,
    routeFamily,
  };
}
