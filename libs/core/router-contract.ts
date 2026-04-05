import { classifySurfaceQueryIntent, extractSurfaceKnowledgeQuery, extractSurfaceWebSearchQuery } from './surface-query.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';

export interface SurfaceIntentResolution {
  intentId?: string;
  shape?: string;
  queryType?: 'weather' | 'location' | 'web_search' | 'knowledge_search';
  queryText?: string;
  browserCommandKind?: 'open_site' | 'browser_step';
}

export function resolveSurfaceIntent(utterance: string): SurfaceIntentResolution {
  const packet = resolveIntentResolutionPacket(utterance);
  const selectedIntentId = packet.selected_intent_id;

  if (selectedIntentId === 'knowledge-query') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      queryType: 'knowledge_search',
      queryText: extractSurfaceKnowledgeQuery(utterance) || utterance.trim(),
    };
  }

  if (selectedIntentId === 'live-query') {
    const queryType = classifySurfaceQueryIntent(utterance);
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
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
      browserCommandKind: 'open_site',
    };
  }

  if (selectedIntentId === 'browser-step') {
    return {
      intentId: selectedIntentId,
      shape: packet.selected_resolution?.shape,
      browserCommandKind: 'browser_step',
    };
  }

  return {
    intentId: selectedIntentId,
    shape: packet.selected_resolution?.shape,
  };
}
