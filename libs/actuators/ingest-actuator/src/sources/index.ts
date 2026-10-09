import { BoxSourceWalker } from './box-source.js';
import { SlackSourceWalker } from './slack-source.js';
import { ConfluenceSourceWalker } from './confluence-source.js';
import { GoogleDriveSourceWalker } from './google-drive-source.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '@agent/core/seam';
import type { SourceWalker } from './source-walker.js';

const sourceWalkerSeam = createSeam<SourceWalker>({
  key: 'ingest-source-walker',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/actuators/ingest-actuator/src/sources/index.ts',
});

function assertSourceWalker(walker: SourceWalker): void {
  const systemId = walker?.systemId;
  if (
    typeof systemId !== 'string' ||
    systemId !== systemId.trim() ||
    !/^[a-z][a-z0-9._-]*$/.test(systemId)
  ) {
    throw new Error(`ingest:sync_source — invalid source walker systemId: ${String(systemId)}`);
  }
  if (typeof walker.walk !== 'function') {
    throw new Error(`ingest:sync_source — source walker '${systemId}' must implement walk()`);
  }
}

export function registerSourceWalker(
  walker: SourceWalker,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'ingest-source-extension' }
): () => void {
  assertSourceWalker(walker);
  return sourceWalkerSeam.register(walker.systemId, walker, metadata);
}

export function listSupportedSources(): string[] {
  return sourceWalkerSeam.list().map((entry) => entry.id);
}

export function getSourceWalker(systemId: string): SourceWalker {
  const walker = sourceWalkerSeam.getOptional(systemId);
  if (!walker) {
    throw new Error(
      `ingest:sync_source — source_system must be one of ${listSupportedSources().join('|')}; got '${systemId}'`
    );
  }
  return walker;
}

// Register default walkers
registerSourceWalker(new BoxSourceWalker(), {
  provenance: 'builtin',
  source: 'ingest-source-walkers',
});
registerSourceWalker(new SlackSourceWalker(), {
  provenance: 'builtin',
  source: 'ingest-source-walkers',
});
registerSourceWalker(new ConfluenceSourceWalker(), {
  provenance: 'builtin',
  source: 'ingest-source-walkers',
});
registerSourceWalker(new GoogleDriveSourceWalker(), {
  provenance: 'builtin',
  source: 'ingest-source-walkers',
});

export {
  type SourceWalker,
  type SourceWalkerInput,
  type PageWalkResult,
  type SyncSourceItem,
  type SyncSourceTransport,
} from './source-walker.js';
export { extractConfluenceCursor } from './confluence-source.js';
export { BoxSourceWalker } from './box-source.js';
export { SlackSourceWalker } from './slack-source.js';
export { ConfluenceSourceWalker } from './confluence-source.js';
export { GoogleDriveSourceWalker } from './google-drive-source.js';
