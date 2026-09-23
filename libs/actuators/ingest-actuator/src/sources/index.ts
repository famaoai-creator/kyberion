import { BoxSourceWalker } from './box-source.js';
import { SlackSourceWalker } from './slack-source.js';
import { ConfluenceSourceWalker } from './confluence-source.js';
import { GoogleDriveSourceWalker } from './google-drive-source.js';
import type { SourceWalker } from './source-walker.js';

const sourceRegistry = new Map<string, SourceWalker>();

export function registerSourceWalker(walker: SourceWalker): void {
  sourceRegistry.set(walker.systemId, walker);
}

export function listSupportedSources(): string[] {
  return Array.from(sourceRegistry.keys());
}

export function getSourceWalker(systemId: string): SourceWalker {
  const walker = sourceRegistry.get(systemId);
  if (!walker) {
    throw new Error(
      `ingest:sync_source — source_system must be one of ${listSupportedSources().join('|')}; got '${systemId}'`
    );
  }
  return walker;
}

// Register default walkers
registerSourceWalker(new BoxSourceWalker());
registerSourceWalker(new SlackSourceWalker());
registerSourceWalker(new ConfluenceSourceWalker());
registerSourceWalker(new GoogleDriveSourceWalker());

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
