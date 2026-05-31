import { pathResolver } from './path-resolver.js';
import { getSurfaceProviderManifestCatalogEntry, listSurfaceProviderManifestCatalogEntries } from './surface-provider-manifest-catalog.js';
import { listSurfaceProviderManifests } from './surface-provider-manifest.js';

import type { SurfaceAsyncChannel } from './channel-surface-types.js';

export interface ChannelDirectoryEntry {
  channel: SurfaceAsyncChannel;
  displayName: string;
  agentId: string;
  interactionMode: 'threaded' | 'session' | 'live';
  directReply: 'outbox' | 'notification' | 'none';
  status: string;
  summary?: string;
  manifestPath: string;
  policyPath?: string;
  coordinationRoot: string;
  requestDir: string;
  notificationDir: string;
  outboxDir?: string;
}

function coordinationRootFor(channel: SurfaceAsyncChannel): string {
  return channel === 'presence'
    ? 'active/shared/runtime/presence'
    : `active/shared/coordination/channels/${channel}`;
}

function requestDirFor(channel: SurfaceAsyncChannel): string {
  return `${coordinationRootFor(channel)}/requests`;
}

function notificationDirFor(channel: SurfaceAsyncChannel): string {
  return `${coordinationRootFor(channel)}/notifications`;
}

function outboxDirFor(channel: SurfaceAsyncChannel): string | undefined {
  if (channel === 'presence') return undefined;
  return `${coordinationRootFor(channel)}/outbox`;
}

export function listChannelDirectoryEntries(): ChannelDirectoryEntry[] {
  const manifestRecords = listSurfaceProviderManifests();
  const catalogEntries = new Map(
    listSurfaceProviderManifestCatalogEntries().map((entry) => [entry.id, entry]),
  );

  return manifestRecords
    .map((manifest) => {
      const catalog = catalogEntries.get(manifest.id) || getSurfaceProviderManifestCatalogEntry(manifest.id);
      return {
        channel: manifest.id,
        displayName: manifest.displayName,
        agentId: manifest.agentId,
        interactionMode: manifest.interactionMode,
        directReply: manifest.delivery.directReply,
        status: catalog?.status || 'unknown',
        summary: catalog?.summary,
        manifestPath: catalog?.manifest_path || pathResolver.knowledge('public/governance/surface-provider-manifests.json'),
        policyPath: catalog?.policy_path,
        coordinationRoot: coordinationRootFor(manifest.id),
        requestDir: requestDirFor(manifest.id),
        notificationDir: notificationDirFor(manifest.id),
        ...(outboxDirFor(manifest.id) ? { outboxDir: outboxDirFor(manifest.id) } : {}),
      };
    })
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

export function getChannelDirectoryEntry(channel: SurfaceAsyncChannel): ChannelDirectoryEntry | null {
  const normalized = channel.trim();
  if (!normalized) return null;
  return listChannelDirectoryEntries().find((entry) => entry.channel === normalized) || null;
}

export function formatChannelDirectoryEntry(entry: ChannelDirectoryEntry): string[] {
  const lines = [
    `${entry.displayName} (${entry.channel})`,
    `  agent: ${entry.agentId}`,
    `  interaction: ${entry.interactionMode}`,
    `  delivery: ${entry.directReply}`,
    `  status: ${entry.status}${entry.summary ? ` - ${entry.summary}` : ''}`,
    `  coordination root: ${entry.coordinationRoot}`,
    `  request dir: ${entry.requestDir}`,
    `  notification dir: ${entry.notificationDir}`,
  ];
  if (entry.outboxDir) {
    lines.push(`  outbox dir: ${entry.outboxDir}`);
  }
  lines.push(`  manifest: ${entry.manifestPath}`);
  if (entry.policyPath) {
    lines.push(`  policy: ${entry.policyPath}`);
  }
  return lines;
}
