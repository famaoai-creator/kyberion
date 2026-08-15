import {
  getSurfaceProviderManifestRecord,
  listSurfaceProviderManifestRecords,
} from './surface-provider-policy.js';

import type { SurfaceAsyncChannel } from './channel-surface-types.js';
import type { TierLevel } from './types.js';

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
  scopePolicy?: {
    processScope: 'system' | 'tenant-service';
    scopeMode: 'system' | 'server-bound-tenant' | 'viewer-derived' | 'request-derived';
    allowedTiers: TierLevel[];
    requiresChannelBindingForCustomerMode: boolean;
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
    ...(record.scope_policy
      ? {
          scopePolicy: {
            processScope: record.scope_policy.process_scope,
            scopeMode: record.scope_policy.scope_mode,
            allowedTiers: [...record.scope_policy.allowed_tiers],
            requiresChannelBindingForCustomerMode:
              record.scope_policy.requires_channel_binding_for_customer_mode,
          },
        }
      : {}),
  }));
}

export function getSurfaceProviderManifest(surface: SurfaceAsyncChannel): SurfaceProviderManifest {
  return listSurfaceProviderManifests().find((entry) => entry.id === surface)!;
}
