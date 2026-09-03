import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import type { IntentResolutionContract } from './intent-resolution-contract.js';

export interface CoworkArtifactPacketArtifact {
  path?: string;
  content?: string;
  content_type: string;
  description?: string;
}

export interface CoworkArtifactPacket {
  delivery_id: string;
  delivered_at: string;
  mission_id?: string;
  trace_id?: string;
  title: string;
  summary: string;
  next_action?: string;
  intent_resolution?: IntentResolutionContract;
  artifacts: CoworkArtifactPacketArtifact[];
}

const COWORK_ARTIFACT_PACKET_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/cowork-artifact-packet.schema.json'
);

const coworkArtifactPacketCatalog = (filePath: string) =>
  defineCatalog<CoworkArtifactPacket>({
    id: 'cowork-artifact-packet',
    path: filePath,
    schema: COWORK_ARTIFACT_PACKET_SCHEMA_PATH,
  });

/** Load a Cowork outbox packet through the shared schema and path boundary. */
export function loadCoworkArtifactPacketAtPath(filePath: string): CoworkArtifactPacket {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safeFilePath) || !safeLstat(safeFilePath).isFile()) {
    throw new Error(`[COWORK_PACKET_INVALID] packet must be a regular file: ${filePath}`);
  }
  return coworkArtifactPacketCatalog(safeFilePath).load();
}

/** Validate an in-memory packet before it is published to the outbox. */
export function validateCoworkArtifactPacket(
  packet: unknown,
  sourcePath = '<cowork-artifact-packet>'
): CoworkArtifactPacket {
  return coworkArtifactPacketCatalog(sourcePath).validate(packet, sourcePath);
}
