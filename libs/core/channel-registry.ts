import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface ChannelRegistryChannel {
  id: string;
  name: string;
  medium: string;
  default_mode: string;
  priority: number;
  capabilities: string[];
  connector_skill?: string;
  service_id?: string;
  execution_mode?: 'API' | 'CLI' | 'SDK';
}

export interface ChannelRegistryPolicy {
  interruption_allowed: boolean;
  default_response_latency_ms: number;
  max_buffer_size: number;
}

export interface ChannelRegistry {
  channels: ChannelRegistryChannel[];
  global_policy: ChannelRegistryPolicy;
}

export function loadChannelRegistry(rootDir = pathResolver.rootDir()): ChannelRegistry {
  return defineCatalog<ChannelRegistry>({
    id: 'presence-channel-registry',
    path: path.resolve(rootDir, 'presence/bridge/channel-registry.json'),
    schema: pathResolver.rootResolve('knowledge/product/schemas/channel-registry.schema.json'),
  }).load();
}
