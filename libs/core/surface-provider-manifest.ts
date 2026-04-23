import { getSurfaceProviderManifestRecord, listSurfaceProviderManifestRecords } from './surface-provider-policy.js';

import type { SurfaceAsyncChannel } from './channel-surface-types.js';

export interface SurfaceProviderManifest {
  id: SurfaceAsyncChannel;
  displayName: string;
  agentId: string;
  channel: string;
  interactionMode: 'threaded' | 'session' | 'live';
  capabilities: {
    reply: boolean;
    edit: boolean;
    react: boolean;
    notify: boolean;
    asyncRequest: boolean;
    responding: boolean;
  };
  delivery: {
    directReply: 'outbox' | 'notification' | 'none';
    supportsOutbox: boolean;
    supportsNotifications: boolean;
  };
}

export function listSurfaceProviderManifests(): SurfaceProviderManifest[] {
  return listSurfaceProviderManifestRecords().map((record) => ({
    id: record.id,
    displayName: record.displayName,
    agentId: record.agentId,
    channel: record.channel,
    interactionMode: record.interactionMode,
    capabilities: {
      reply: Boolean(record.capabilities.reply),
      edit: Boolean(record.capabilities.edit),
      react: Boolean(record.capabilities.react),
      notify: Boolean(record.capabilities.notify),
      asyncRequest: Boolean(record.capabilities.asyncRequest),
      responding: Boolean(record.capabilities.responding),
    },
    delivery: record.delivery,
  }));
}

export function getSurfaceProviderManifest(surface: SurfaceAsyncChannel): SurfaceProviderManifest {
  return listSurfaceProviderManifests().find((entry) => entry.id === surface)!;
}
